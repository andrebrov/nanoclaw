/**
 * Missed-task recovery on host startup.
 *
 * Scheduled tasks live as `messages_in` rows (`kind='task'`) in each agent
 * group's maintenance session. They are written to disk and persist across
 * container restarts. But if the host process itself was down across a
 * scheduled fire time, the task row's `process_after` ends up in the past:
 * the next sweep tick will eventually wake the container and the task runs
 * late, with no signal that anything was missed.
 *
 * notifyMissedTasks scans every active maintenance session for pending
 * tasks whose fire time is meaningfully in the past, and writes a one-shot
 * chat-kind system message into that session's inbound.db summarising what
 * was missed. The maintenance agent sees the notice on its next wake and
 * can decide whether to surface it to the user.
 *
 * Idempotent across host restarts only at the message-id level — a fresh
 * startup intentionally writes a fresh notice because the downtime gap and
 * the set of missed slots may have changed.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { wakeContainer } from '../../container-runner.js';
import { MAINTENANCE_SESSION_NAME } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

export const MISSED_THRESHOLD_MS = 5 * 60 * 1000;

export interface MissedSlot {
  taskId: string;
  seriesId: string | null;
  processAfter: string;
  recurrence: string | null;
  prompt: string;
}

interface MissedTaskRow {
  id: string;
  series_id: string | null;
  process_after: string;
  recurrence: string | null;
  content: string;
}

/**
 * Pure query — find pending task rows whose process_after is more than
 * MISSED_THRESHOLD_MS in the past. Exposed for unit testing without needing
 * a session-manager / central-db setup.
 */
export function findMissedTasksInDb(db: Database.Database, now: number): MissedSlot[] {
  const cutoff = new Date(now - MISSED_THRESHOLD_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id, series_id, process_after, recurrence, content
         FROM messages_in
        WHERE kind = 'task'
          AND status = 'pending'
          AND process_after IS NOT NULL
          AND datetime(process_after) < datetime(?)
        ORDER BY process_after ASC`,
    )
    .all(cutoff) as MissedTaskRow[];

  return rows.map((r) => {
    let prompt = '';
    try {
      const parsed = JSON.parse(r.content) as { prompt?: string };
      if (typeof parsed.prompt === 'string') prompt = parsed.prompt.slice(0, 80);
    } catch {
      /* keep empty prompt */
    }
    return {
      taskId: r.id,
      seriesId: r.series_id,
      processAfter: r.process_after,
      recurrence: r.recurrence,
      prompt,
    };
  });
}

function getMaintenanceSessions(): Session[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE session_name = ? AND status = 'active'")
    .all(MAINTENANCE_SESSION_NAME) as Session[];
}

export function formatMissedTasksNotice(missed: MissedSlot[]): string {
  const lines = missed.map((m) => {
    const recur = m.recurrence ? ` recur="${m.recurrence}"` : '';
    const prompt = m.prompt ? ` — ${m.prompt}` : '';
    return `- ${m.taskId}${recur} (scheduled ${m.processAfter})${prompt}`;
  });
  return [
    `Host recovery: ${missed.length} scheduled task occurrence(s) were missed while the host was down.`,
    'They remain queued and will fire on the next sweep tick. If any need a heads-up to the user, surface them now:',
    ...lines,
  ].join('\n');
}

/**
 * Scan every active maintenance session for tasks whose `process_after` is
 * more than MISSED_THRESHOLD_MS in the past, and write a recovery chat
 * message into that session's inbound.db. Best-effort: any per-session
 * failure logs and continues. Returns the number of sessions notified.
 */
export async function notifyMissedTasks(now: number = Date.now()): Promise<number> {
  let sessions: Session[];
  try {
    sessions = getMaintenanceSessions();
  } catch (err) {
    log.warn('notifyMissedTasks: failed to query maintenance sessions', { err });
    return 0;
  }

  let notified = 0;
  for (const session of sessions) {
    const dbPath = inboundDbPath(session.agent_group_id, session.id);
    if (!fs.existsSync(dbPath)) continue;

    let missed: MissedSlot[];
    let db: Database.Database;
    try {
      db = openInboundDb(session.agent_group_id, session.id);
    } catch (err) {
      log.warn('notifyMissedTasks: failed to open inbound DB', { sessionId: session.id, err });
      continue;
    }
    try {
      missed = findMissedTasksInDb(db, now);
    } catch (err) {
      log.warn('notifyMissedTasks: failed to scan session', { sessionId: session.id, err });
      continue;
    } finally {
      db.close();
    }

    if (missed.length === 0) continue;

    try {
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `recover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          text: formatMissedTasksNotice(missed),
          sender: 'system',
          senderId: 'system',
        }),
        trigger: 1,
      });
      notified++;
      log.info('Wrote missed-task recovery notice', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        missedCount: missed.length,
      });

      const fresh = getSession(session.id);
      if (fresh) {
        wakeContainer(fresh).catch((err) =>
          log.warn('notifyMissedTasks: wakeContainer failed', { sessionId: session.id, err }),
        );
      }
    } catch (err) {
      log.warn('notifyMissedTasks: failed to write recovery message', { sessionId: session.id, err });
    }
  }
  return notified;
}
