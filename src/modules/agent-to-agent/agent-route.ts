/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. All agent groups are synthetically available
 * as destinations (write-destinations.ts injects peers by normalized name),
 * so the routing check only verifies the target still exists. Content is
 * copied verbatim; the target's formatter looks up the source agent in its
 * own local map to display a name.
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
import { getAllAgentGroups, getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

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

async function deliverToAgent(targetAgentGroupId: string, sourceAgentGroupId: string, content: string): Promise<void> {
  const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: sourceAgentGroupId,
    channelType: 'agent',
    threadId: null,
    content,
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
    await Promise.all(peers.map((ag) => deliverToAgent(ag.id, session.agent_group_id, msg.content)));
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
    await deliverToAgent(mainGroup.id, session.agent_group_id, msg.content);
    return;
  }

  // All agent groups are synthetically available as peer destinations (auto-
  // injected by write-destinations.ts for cross-channel handoff, PR #32). The
  // earlier `hasDestination` auth check is now redundant — every peer is
  // implicitly authorized — so we just verify the target still exists.
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  await deliverToAgent(targetAgentGroupId, session.agent_group_id, msg.content);
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
  });
}
