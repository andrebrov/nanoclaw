import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function initDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // SQLITE_BUSY hardening. The central DB has multiple writers (host
  // sweep, channel adapters, delivery, router) that occasionally try to
  // write concurrently. better-sqlite3's default busy timeout is 5s;
  // under brief WAL-checkpoint contention or large-write windows that
  // can fail-fast. 30s is enough that any real-world contention waits
  // it out rather than throwing SQLITE_BUSY into a callback that may not
  // be retry-prepared (and propagating into the iter-5 uncaughtException
  // handler as a noisy log).
  _db.pragma('busy_timeout = 30000');
  log.info('Central DB initialized', { path: dbPath });
  return _db;
}

/** For tests only — creates an in-memory DB and runs migrations. */
export function initTestDb(): Database.Database {
  _db = new Database(':memory:');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Cheap: a single indexed lookup on
 * sqlite_master. Results are not cached — a module install adds the
 * table at runtime (next service start), and callers may run before
 * or after that boundary.
 */
export function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
    | { '1': number }
    | undefined;
  return row !== undefined;
}
