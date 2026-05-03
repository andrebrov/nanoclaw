import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'emoji-mode',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE messaging_groups ADD COLUMN emoji_mode TEXT NOT NULL DEFAULT 'auto';
    `);
  },
};
