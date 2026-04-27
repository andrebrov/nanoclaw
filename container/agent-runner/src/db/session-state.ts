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
