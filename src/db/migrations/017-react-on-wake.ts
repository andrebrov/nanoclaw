import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'react-on-wake',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE messaging_groups ADD COLUMN react_on_wake INTEGER NOT NULL DEFAULT 1;
    `);
  },
};
