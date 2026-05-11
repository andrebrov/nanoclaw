/**
 * inReplyTo validator for send_message in group chats.
 *
 * In a group chat, replies must thread under the message the agent is
 * answering — otherwise the conversation degenerates into a flat list of
 * top-level posts where it is impossible to tell who is answering whom.
 *
 * When the agent calls `send_message` with a destination that resolves to
 * a group chat AND no `inReplyTo` argument, this gate blocks the call and
 * tells the agent to retry with the seq of the message it is answering.
 * DMs and agent-to-agent destinations are never blocked — threading there
 * is unambiguous.
 *
 * The destination's `is_group` flag is projected from the host's
 * `messaging_groups.is_group` column into the per-session `destinations`
 * table on every container wake (see src/modules/agent-to-agent/
 * write-destinations.ts). When `to` is omitted the agent is replying to
 * the current turn's source chat, which is looked up via findByRouting.
 *
 * Fail-open: if the destination can't be resolved (e.g. the agent passed
 * a name that doesn't exist) or any unexpected error occurs, the call is
 * allowed through. The send_message handler will surface the routing
 * error to the agent with its own message — duplicating that here would
 * just produce a less specific error.
 */
import { findByName, findByRouting, type DestinationEntry } from '../destinations.js';
import { getSessionRouting } from '../db/session-routing.js';
import { getTurnSourceRouting } from '../db/session-state.js';

function log(msg: string): void {
  console.error(`[inreplyto-group-validator] ${msg}`);
}

/**
 * Resolve the destination the agent is sending to. Mirrors the resolution
 * order in mcp-tools/core.ts:resolveRouting so the validator sees the same
 * destination the send_message handler will use.
 */
function resolveDestination(to: string | undefined): DestinationEntry | undefined {
  if (to) return findByName(to);

  const turnSource = getTurnSourceRouting();
  if (turnSource?.channelType && turnSource.platformId) {
    return findByRouting(turnSource.channelType, turnSource.platformId);
  }

  const session = getSessionRouting();
  if (session.channel_type && session.platform_id) {
    return findByRouting(session.channel_type, session.platform_id);
  }

  return undefined;
}

export interface InReplyToGroupGateResult {
  block: false;
  /** Convenience for tests / debugging — the destination we evaluated, if any. */
  destination?: DestinationEntry;
}

export interface InReplyToGroupGateBlock {
  block: true;
  reason: string;
  destination: DestinationEntry;
}

/**
 * Evaluate a send_message tool call. Returns `{ block: true, reason }` only
 * when the destination is a group chat and `inReplyTo` is missing.
 *
 * Pure / synchronous: no I/O beyond the destinations + routing reads that
 * the send_message handler already performs. Safe to call from the hot
 * PreToolUse path.
 */
export function evaluateInReplyToGroupGate(
  toolInput: Record<string, unknown> | undefined,
): InReplyToGroupGateResult | InReplyToGroupGateBlock {
  try {
    const input = toolInput ?? {};
    const inReplyTo = input.inReplyTo;
    if (inReplyTo !== undefined && inReplyTo !== null) {
      return { block: false };
    }

    const to = typeof input.to === 'string' ? input.to : undefined;
    const dest = resolveDestination(to);
    if (!dest) return { block: false };
    if (!dest.isGroup) return { block: false, destination: dest };

    return {
      block: true,
      destination: dest,
      reason:
        `send_message in group chat requires inReplyTo to maintain threading. ` +
        `Destination "${dest.name}" is a group chat — pass the seq of the message you are answering ` +
        `as \`inReplyTo\` so your reply threads under it instead of starting a new top-level post.`,
    };
  } catch (err) {
    log(`evaluation error — fail-open: ${err instanceof Error ? err.message : String(err)}`);
    return { block: false };
  }
}
