/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember the SDK session ID so the agent's conversation
 * resumes across container restarts. Cleared by /clear.
 */
import { getOutboundDb } from './connection.js';

const SDK_SESSION_KEY = 'sdk_session_id';

function getValue(key: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

export function getStoredSessionId(): string | undefined {
  return getValue(SDK_SESSION_KEY);
}

export function setStoredSessionId(sessionId: string): void {
  setValue(SDK_SESSION_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  deleteValue(SDK_SESSION_KEY);
}

const TURN_REPLY_TO_KEY = 'turn_reply_to';

/**
 * The inReplyTo ID for the current turn — set by the poll-loop at the start of
 * each turn from the last inbound message's ID, cleared at end of turn.
 * Used by send_message as the default in_reply_to so replies thread correctly
 * without the agent needing to track and pass the current message ID manually.
 */
export function getTurnReplyTo(): string | null {
  return getValue(TURN_REPLY_TO_KEY) ?? null;
}

export function setTurnReplyTo(id: string): void {
  setValue(TURN_REPLY_TO_KEY, id);
}

export function clearTurnReplyTo(): void {
  deleteValue(TURN_REPLY_TO_KEY);
}

const TURN_SOURCE_ROUTING_KEY = 'turn_source_routing';

/**
 * The source channel routing for the current turn — set by the poll-loop at
 * the start of each turn from the last inbound message's channel/platform IDs,
 * cleared at end of turn.
 *
 * Used by send_message as the default routing destination when `to` is omitted,
 * so replies go back to the channel the triggering message came from (e.g. a
 * group chat) rather than the session's bound default channel (e.g. a DM).
 * Consistent with dispatchResultText, which also uses inbound routing to
 * decide where plain text goes.
 */
export function setTurnSourceRouting(
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
): void {
  if (channelType && platformId) {
    setValue(TURN_SOURCE_ROUTING_KEY, JSON.stringify({ channelType, platformId, threadId: threadId ?? null }));
  } else {
    deleteValue(TURN_SOURCE_ROUTING_KEY);
  }
}

export function getTurnSourceRouting(): {
  channelType: string;
  platformId: string;
  threadId: string | null;
} | null {
  const raw = getValue(TURN_SOURCE_ROUTING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      channelType?: string;
      platformId?: string;
      threadId?: string | null;
    };
    if (parsed.channelType && parsed.platformId) {
      return {
        channelType: parsed.channelType,
        platformId: parsed.platformId,
        threadId: parsed.threadId ?? null,
      };
    }
  } catch {
    /* corrupt value — treat as absent */
  }
  return null;
}

export function clearTurnSourceRouting(): void {
  deleteValue(TURN_SOURCE_ROUTING_KEY);
}

const TURN_SEND_INVOKED_KEY = 'turn_send_invoked';

/**
 * Mark that a user-facing send tool (send_message, send_file) fired during
 * the current turn. The poll-loop reads this at result time to suppress the
 * SDK's closing text echo — otherwise the user sees two messages.
 * Cleared by the poll-loop at the start of each new turn.
 * NOT set by add_reaction: reaction + closing summary is a valid reply path.
 */
export function setTurnSendInvoked(): void {
  setValue(TURN_SEND_INVOKED_KEY, '1');
}

export function getTurnSendInvoked(): boolean {
  return getValue(TURN_SEND_INVOKED_KEY) === '1';
}

export function clearTurnSendInvoked(): void {
  deleteValue(TURN_SEND_INVOKED_KEY);
}
