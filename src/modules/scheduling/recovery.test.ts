/**
 * Tests for missed-task recovery.
 *
 * Two regressions to guard:
 *   1. Scheduled tasks persist across restart (rows survive a close + reopen
 *      of inbound.db, recurrence + process_after intact).
 *   2. After a simulated downtime, findMissedTasksInDb surfaces every task
 *      whose process_after sits more than MISSED_THRESHOLD_MS in the past.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { handleRecurrence } from './recurrence.js';
import { MISSED_THRESHOLD_MS, findMissedTasksInDb, formatMissedTasksNotice } from './recovery.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-recovery-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('recovery / restart persistence', () => {
  it('preserves a recurring task across a simulated host restart', async () => {
    // Schedule a recurring task and run handleRecurrence, producing a fresh
    // pending follow-up. This is the post-fire state where the live row owns
    // the next process_after.
    let db = freshDb();
    insertTask(db, {
      id: 'task-prospect',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily prospecting' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-prospect'`).run();
    await handleRecurrence(db, fakeSession());

    // Capture the live row's next-fire time before "restart".
    const liveBefore = db
      .prepare(
        `SELECT id, process_after, recurrence, series_id, status
           FROM messages_in WHERE status='pending'`,
      )
      .get() as { id: string; process_after: string; recurrence: string; series_id: string; status: string };
    expect(liveBefore.recurrence).toBe('0 9 * * *');
    expect(liveBefore.series_id).toBe('task-prospect');

    // Simulate restart: close and reopen the DB.
    db.close();
    db = openInboundDb(DB_PATH);

    const liveAfter = db
      .prepare(
        `SELECT id, process_after, recurrence, series_id, status
           FROM messages_in WHERE status='pending'`,
      )
      .get() as { id: string; process_after: string; recurrence: string; series_id: string; status: string };

    // Same id, same next-fire time, recurrence still attached.
    expect(liveAfter.id).toBe(liveBefore.id);
    expect(liveAfter.process_after).toBe(liveBefore.process_after);
    expect(liveAfter.recurrence).toBe(liveBefore.recurrence);
    expect(liveAfter.series_id).toBe(liveBefore.series_id);
    expect(liveAfter.status).toBe('pending');
    db.close();
  });
});

describe('findMissedTasksInDb', () => {
  it('returns tasks whose process_after is past the missed threshold', () => {
    const db = freshDb();
    const now = Date.parse('2026-05-27T12:00:00.000Z');

    insertTask(db, {
      id: 'task-old',
      processAfter: new Date(now - MISSED_THRESHOLD_MS - 60_000).toISOString(),
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily prospecting at 9 AM' }),
    });
    insertTask(db, {
      id: 'task-soon',
      processAfter: new Date(now - 30_000).toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'fresh one-shot' }),
    });
    insertTask(db, {
      id: 'task-future',
      processAfter: new Date(now + 60 * 60_000).toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'future task' }),
    });

    const missed = findMissedTasksInDb(db, now);
    expect(missed.map((m) => m.taskId)).toEqual(['task-old']);
    expect(missed[0].recurrence).toBe('0 9 * * *');
    expect(missed[0].prompt).toContain('daily prospecting');
    db.close();
  });

  it('ignores tasks that already completed', () => {
    const db = freshDb();
    const now = Date.parse('2026-05-27T12:00:00.000Z');

    insertTask(db, {
      id: 'task-done',
      processAfter: new Date(now - MISSED_THRESHOLD_MS - 60_000).toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'already ran' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-done'`).run();

    expect(findMissedTasksInDb(db, now)).toEqual([]);
    db.close();
  });

  it('formats a human-readable notice for the maintenance agent', () => {
    const notice = formatMissedTasksNotice([
      {
        taskId: 'task-1',
        seriesId: 'task-1',
        processAfter: '2026-05-27T09:00:00.000Z',
        recurrence: '0 9 * * *',
        prompt: 'daily prospecting',
      },
    ]);
    expect(notice).toContain('1 scheduled task occurrence(s) were missed');
    expect(notice).toContain('task-1');
    expect(notice).toContain('recur="0 9 * * *"');
    expect(notice).toContain('daily prospecting');
  });
});
