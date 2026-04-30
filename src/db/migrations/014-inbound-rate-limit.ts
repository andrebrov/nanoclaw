import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'inbound-rate-limit',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE messaging_groups ADD COLUMN inbound_rate_limit INTEGER;
    `);
  },
};
