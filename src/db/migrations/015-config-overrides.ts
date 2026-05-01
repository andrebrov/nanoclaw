import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'config-overrides',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_overrides (
        scope_type     TEXT NOT NULL,
                       -- 'channel' (by messaging_group_id) | 'user' (by user_id)
        scope_id       TEXT NOT NULL,
        agent_group_id TEXT NOT NULL DEFAULT '',
                       -- '' = applies to all agent groups; otherwise scoped
        config_json    TEXT NOT NULL,
                       -- JSON: {model?, maxTokens?, systemPromptAppend?, allowedTools?}
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (scope_type, scope_id, agent_group_id)
      );
    `);
  },
};
