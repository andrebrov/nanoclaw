/**
 * Cross-session message index — host-managed SQLite db read by containers
 * read-only for context recovery queries.
 *
 * Single writer (this module on the host). Containers mount the file
 * read-only at /workspace/messages.db and open it with sqlite3 / better-
 * sqlite3 in readonly mode.
 *
 * Cross-mount visibility: `journal_mode=DELETE` is load-bearing here, same
 * as the per-session inbound/outbound dbs (see
 * `container/agent-runner/src/db/connection.ts` for the rationale). WAL
 * mode would force the reader to access the `-shm`/`-wal` siblings via
 * shared memory, which doesn't survive bind-mount boundaries.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const DB_PATH = path.join(DATA_DIR, 'messages.db');

let db: Database.Database | null = null;
let saveStmt: Database.Statement | null = null;

function init(): void {
  if (db) return;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      messaging_group_id TEXT,
      channel_type       TEXT NOT NULL,
      platform_id        TEXT NOT NULL,
      thread_id          TEXT,
      direction          TEXT NOT NULL CHECK (direction IN ('in','out')),
      kind               TEXT,
      sender_user_id     TEXT,
      sender_name        TEXT,
      text               TEXT,
      content_json       TEXT,
      platform_msg_id    TEXT,
      session_id         TEXT,
      agent_group_id     TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(channel_type, platform_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_mg ON messages(messaging_group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at DESC);
  `);
  saveStmt = db.prepare(`
    INSERT INTO messages (
      messaging_group_id, channel_type, platform_id, thread_id,
      direction, kind, sender_user_id, sender_name,
      text, content_json, platform_msg_id, session_id, agent_group_id
    ) VALUES (
      @messaging_group_id, @channel_type, @platform_id, @thread_id,
      @direction, @kind, @sender_user_id, @sender_name,
      @text, @content_json, @platform_msg_id, @session_id, @agent_group_id
    )
  `);
  log.info('Message index ready', { path: DB_PATH });
}

export interface IndexedMessage {
  messaging_group_id: string | null;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  direction: 'in' | 'out';
  kind: string | null;
  sender_user_id: string | null;
  sender_name: string | null;
  text: string | null;
  content_json: string | null;
  platform_msg_id: string | null;
  session_id: string | null;
  agent_group_id: string | null;
}

/**
 * Best-effort index write. Failures are logged and swallowed — the message
 * pipeline must not stall because a denormalized index couldn't be written.
 */
export function indexMessage(m: IndexedMessage): void {
  try {
    init();
    saveStmt!.run(m);
  } catch (err) {
    log.warn('Message index write failed', { err, platformId: m.platform_id });
  }
}

export const messageDbPath = DB_PATH;

/** Eagerly initialize the index (schema + pragmas). Call from host main() so
 * the file is a valid SQLite db before any container is spawned to mount it
 * read-only. */
export function initMessageStore(): void {
  init();
}
