import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration013: Migration = {
  version: 13,
  name: 'session-name',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN session_name TEXT NOT NULL DEFAULT 'default';
      CREATE INDEX idx_sessions_session_name ON sessions(agent_group_id, session_name);
    `);
  },
};
