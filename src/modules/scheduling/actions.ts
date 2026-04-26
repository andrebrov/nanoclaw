/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 *
 * All task mutations target the maintenance session (session_name='maintenance'),
 * not the originating user-facing session. This keeps scheduled tasks isolated
 * so a hung maintenance container cannot delay interactive user responses.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { findSessionByAgentGroup, getSession } from '../../db/sessions.js';
import { MAINTENANCE_SESSION_NAME } from '../../config.js';
import { log } from '../../log.js';
import { openInboundDb, resolveMaintenanceSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  // Route to the maintenance session so scheduled tasks run independently
  // of user-facing conversations.
  const { session: maintSession } = resolveMaintenanceSession(session.agent_group_id);

  const inDb = openInboundDb(session.agent_group_id, maintSession.id);
  try {
    insertTask(inDb, {
      id: taskId,
      processAfter,
      recurrence,
      platformId: (content.platformId as string) ?? null,
      channelType: (content.channelType as string) ?? null,
      threadId: (content.threadId as string) ?? null,
      content: JSON.stringify({ prompt, script }),
    });
  } finally {
    inDb.close();
  }
  log.info('Scheduled task created', { taskId, processAfter, recurrence, maintenanceSessionId: maintSession.id });

  // Wake the maintenance container so it picks up the new task promptly.
  const freshSession = getSession(maintSession.id);
  if (freshSession) {
    wakeContainer(freshSession).catch((err) =>
      log.error('Failed to wake maintenance container for scheduled task', { err }),
    );
  }
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const maintSession = findSessionByAgentGroup(session.agent_group_id, MAINTENANCE_SESSION_NAME);
  if (!maintSession) {
    log.info('Cancel task: no maintenance session exists', { taskId });
    return;
  }
  const inDb = openInboundDb(session.agent_group_id, maintSession.id);
  try {
    cancelTask(inDb, taskId);
  } finally {
    inDb.close();
  }
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const maintSession = findSessionByAgentGroup(session.agent_group_id, MAINTENANCE_SESSION_NAME);
  if (!maintSession) {
    log.info('Pause task: no maintenance session exists', { taskId });
    return;
  }
  const inDb = openInboundDb(session.agent_group_id, maintSession.id);
  try {
    pauseTask(inDb, taskId);
  } finally {
    inDb.close();
  }
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const maintSession = findSessionByAgentGroup(session.agent_group_id, MAINTENANCE_SESSION_NAME);
  if (!maintSession) {
    log.info('Resume task: no maintenance session exists', { taskId });
    return;
  }
  const inDb = openInboundDb(session.agent_group_id, maintSession.id);
  try {
    resumeTask(inDb, taskId);
  } finally {
    inDb.close();
  }
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }

  const maintSession = findSessionByAgentGroup(session.agent_group_id, MAINTENANCE_SESSION_NAME);
  let touched = 0;
  if (maintSession) {
    const inDb = openInboundDb(session.agent_group_id, maintSession.id);
    try {
      touched = updateTask(inDb, taskId, update);
    } finally {
      inDb.close();
    }
  }

  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent in the originating session that update_task matched nothing.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
