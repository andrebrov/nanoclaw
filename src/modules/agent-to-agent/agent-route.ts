/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. All agent groups are synthetically available
 * as destinations (write-destinations.ts injects peers by normalized name),
 * so the routing check only verifies the target still exists. Content is
 * copied into the target's inbound DB; the target's formatter looks up the
 * source agent in its own local map to display a name.
 *
 * If the source message had `files` (from `send_file`), the actual bytes
 * are copied from the source's outbox into the target's `inbox/<a2a-msg-id>/`
 * directory and surfaced to the target agent as `attachments` (existing
 * formatter convention — see formatter.ts:230). The target agent can then
 * forward the file onward via its own `send_file` call using the absolute
 * `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Broadcast: `platform_id === '__broadcast__'` fans out to all agent groups
 * except the sender. The `broadcast` destination is injected as a synthetic
 * row into every agent's inbound.db projection by write-destinations.ts.
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getAllAgentGroups, getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

export { isSafeAttachmentName };

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  fs.mkdirSync(targetInboxDir, { recursive: true });

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
}

/** Sentinel used by the synthetic broadcast destination row. */
export const BROADCAST_SENTINEL = '__broadcast__';

/**
 * Sentinel used by the synthetic main destination row. Resolved at routing
 * time to the oldest agent group (by created_at) — the one the user set up
 * first. Enables cross-channel handoffs via send_message({ to: 'main' })
 * without requiring operator wiring.
 */
export const MAIN_SENTINEL = '__main__';

async function deliverToAgent(
  targetAgentGroupId: string,
  sourceSession: Session,
  msg: RoutableAgentMessage,
): Promise<void> {
  const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, sourceSession, targetAgentGroupId, targetSession.id);

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: sourceSession.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
  });
  log.info('Agent message routed', {
    from: sourceSession.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }

  // Broadcast: fan out to every agent group except the sender.
  if (targetAgentGroupId === BROADCAST_SENTINEL) {
    const all = getAllAgentGroups();
    const peers = all.filter((ag) => ag.id !== session.agent_group_id);
    log.info('Agent broadcast', { from: session.agent_group_id, peers: peers.map((p) => p.id) });
    await Promise.all(peers.map((ag) => deliverToAgent(ag.id, session, msg)));
    return;
  }

  // Main: route to the oldest agent group (the user's primary DM agent).
  if (targetAgentGroupId === MAIN_SENTINEL) {
    const all = getAllAgentGroups();
    const mainGroup = all.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!mainGroup) {
      throw new Error(`main routing failed: no agent groups found`);
    }
    log.info('Agent main routing', { from: session.agent_group_id, to: mainGroup.id });
    await deliverToAgent(mainGroup.id, session, msg);
    return;
  }

  // Capability gate (LLM08 fix, issue #140): the source agent must have an
  // explicit agent_destinations row for this target. Synthetic peer injection
  // was removed from write-destinations.ts, so only explicitly wired routes
  // (e.g. bidirectional rows created by `create_agent`) pass this check.
  if (!hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)) {
    log.warn('Unauthorized agent-to-agent send attempt blocked', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      messageId: msg.id,
    });
    throw new Error(
      `unauthorized agent destination: ${session.agent_group_id} cannot send to agent ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  await deliverToAgent(targetAgentGroupId, session, msg);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
