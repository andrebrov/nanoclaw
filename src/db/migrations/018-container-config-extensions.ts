import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Fork-specific container-config fields that have no dedicated upstream column
 * (allowedCapabilities, observer, costGating, loopDetection, subagentLimit,
 * progressiveSkills, maintenanceSkillBlocklist, isAdmin, linkedinPostValidator)
 * are stored as a single JSON blob here. Parsed by configFromDb() in
 * container-config.ts. Must run after migration 'container-configs' (014),
 * which creates the table.
 */
export const migration018: Migration = {
  version: 18,
  name: 'container-config-extensions',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN extensions TEXT NOT NULL DEFAULT '{}'").run();
  },
};
