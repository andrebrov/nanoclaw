#!/usr/bin/env node
/**
 * One-shot migration: restore v1 scheduled_tasks into v2 maintenance session.
 *
 * v1 stored tasks in data/nanoclaw.db (now 0 bytes); the closest snapshot is
 * store/backups/messages-2026-04-13T02-39-09-557Z.db. v2 stores them as
 * kind='task' rows in the per-agent-group maintenance session's inbound.db.
 *
 * For each v1 row we:
 *   - skip non-active rows
 *   - skip groups other than 'main' (only main has tasks today)
 *   - compute process_after:
 *       cron     → next firing from now in user TZ
 *       interval → now + interval_ms (also stored as recurrence='@every Nm')
 *                  v2's recurrence handler doesn't natively support @every,
 *                  so we keep recurrence=null and treat as one-shot for now;
 *                  the user can re-schedule with cron via update_task.
 *   - insert with series_id = v1 id so cancel/pause/update by old id still works
 */
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import path from 'path';
import fs from 'fs';

const ROOT = '/home/andrei/nanoclaw';
const V1_BACKUP = path.join(ROOT, 'store/backups/messages-2026-04-13T02-39-09-557Z.db');
const V2_DB = path.join(ROOT, 'data/v2.db');
const SESSIONS = path.join(ROOT, 'data/v2-sessions');
const TZ = process.env.TZ || 'America/New_York';
const MAINTENANCE = 'maintenance';

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nextEvenSeq(db) {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get();
  const max = r.m;
  return max < 2 ? 2 : max + 2 - (max % 2);
}

const v1 = new Database(V1_BACKUP, { readonly: true });
const tasks = v1
  .prepare(
    "SELECT id, group_folder, prompt, schedule_type, schedule_value, next_run, status FROM scheduled_tasks WHERE status IN ('active','pending')",
  )
  .all();
v1.close();

const central = new Database(V2_DB);
const main = central.prepare("SELECT id, name, folder FROM agent_groups WHERE folder='main'").get();
if (!main) throw new Error('No main agent group found in data/v2.db');
const agentGroupId = main.id;

// resolveMaintenanceSession equivalent: find or create
let maint = central
  .prepare(
    "SELECT id FROM sessions WHERE agent_group_id = ? AND session_name = ? LIMIT 1",
  )
  .get(agentGroupId, MAINTENANCE);

if (!maint) {
  const sessId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  central
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, session_name, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, 'active', 'stopped', NULL, ?)`,
    )
    .run(sessId, agentGroupId, MAINTENANCE, now);
  console.log(`Created maintenance session: ${sessId}`);
  maint = { id: sessId };

  // Init folder + DBs (mirror initSessionFolder)
  const sessDir = path.join(SESSIONS, agentGroupId, sessId);
  fs.mkdirSync(path.join(sessDir, 'outbox'), { recursive: true });
  // The host normally creates inbound.db / outbound.db via ensureSchema. We'll
  // copy schema from a sibling session's DB structure by opening fresh and
  // letting better-sqlite3 + nanoclaw apply schema on first host open. For
  // now we initialise the minimum structure ourselves.
  const inbound = new Database(path.join(sessDir, 'inbound.db'));
  inbound.pragma('journal_mode = DELETE');
  // Copy schema from any existing inbound.db
  const sample = path.join(SESSIONS, agentGroupId);
  let schemaSrc = null;
  for (const e of fs.readdirSync(sample)) {
    const p = path.join(sample, e, 'inbound.db');
    if (fs.existsSync(p) && p !== path.join(sessDir, 'inbound.db')) {
      schemaSrc = p;
      break;
    }
  }
  if (!schemaSrc) throw new Error('No sibling inbound.db to copy schema from');
  const src = new Database(schemaSrc, { readonly: true });
  const ddls = src
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL")
    .all();
  for (const { sql } of ddls) {
    inbound.exec(sql);
  }
  src.close();
  inbound.close();

  const outbound = new Database(path.join(sessDir, 'outbound.db'));
  outbound.pragma('journal_mode = DELETE');
  const outSrc = new Database(
    fs
      .readdirSync(sample)
      .map((e) => path.join(sample, e, 'outbound.db'))
      .find((p) => fs.existsSync(p) && p !== path.join(sessDir, 'outbound.db')),
    { readonly: true },
  );
  for (const { sql } of outSrc
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL")
    .all()) {
    outbound.exec(sql);
  }
  outSrc.close();
  outbound.close();
}

const maintSessId = maint.id;
const inboundPath = path.join(SESSIONS, agentGroupId, maintSessId, 'inbound.db');
const inDb = new Database(inboundPath);
inDb.pragma('journal_mode = DELETE');

let inserted = 0;
let skipped = 0;

for (const t of tasks) {
  if (t.group_folder !== 'main') {
    console.log(`SKIP ${t.id} — group_folder=${t.group_folder}`);
    skipped++;
    continue;
  }

  let processAfter = null;
  let recurrence = null;

  if (t.schedule_type === 'cron') {
    recurrence = t.schedule_value;
    try {
      const it = CronExpressionParser.parse(recurrence, { tz: TZ });
      processAfter = it.next().toDate().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    } catch (e) {
      console.log(`  WARN ${t.id} cron parse failed (${e.message}) — using next_run as-is`);
      processAfter = t.next_run;
    }
  } else if (t.schedule_type === 'once') {
    processAfter = t.next_run;
  } else if (t.schedule_type === 'interval') {
    const ms = parseInt(t.schedule_value, 10);
    if (Number.isNaN(ms)) {
      console.log(`SKIP ${t.id} — bad interval ${t.schedule_value}`);
      skipped++;
      continue;
    }
    processAfter = new Date(Date.now() + ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    // v2 has no @every; one-shot for now. User can attach cron via update_task.
    recurrence = null;
  } else {
    console.log(`SKIP ${t.id} — unknown schedule_type ${t.schedule_type}`);
    skipped++;
    continue;
  }

  // Skip duplicates by id
  const existing = inDb.prepare("SELECT id FROM messages_in WHERE id = ?").get(t.id);
  if (existing) {
    console.log(`SKIP ${t.id} — already in maintenance session`);
    skipped++;
    continue;
  }

  const content = JSON.stringify({ prompt: t.prompt, script: null });
  const seq = nextEvenSeq(inDb);

  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', NULL, NULL, NULL, ?, ?)`,
    )
    .run(t.id, seq, processAfter, recurrence, content, t.id);

  console.log(`INSERT ${t.id} at=${processAfter}${recurrence ? ` recur=${recurrence}` : ''} (${t.schedule_type})`);
  inserted++;
}

inDb.close();
central.close();

console.log(`\nDONE — inserted ${inserted}, skipped ${skipped} (of ${tasks.length})`);
console.log(`Maintenance session: ${maintSessId}`);
console.log(`Path: ${inboundPath}`);
