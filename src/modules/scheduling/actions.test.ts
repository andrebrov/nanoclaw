/**
 * Tests for scheduling action handlers — verifies that scheduled tasks are
 * routed to the maintenance session, not the originating user-facing session.
 *
 * This is the core invariant of the dual-session model: default session for
 * user messages, maintenance session for scheduled tasks. A hung maintenance
 * container cannot block interactive responses because the two slots have
 * independent containers.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  findSessionByAgentGroup,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { MAINTENANCE_SESSION_NAME, DEFAULT_SESSION_NAME } from '../../config.js';
import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-scheduling-actions' };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduling-actions';

function now() {
  return new Date().toISOString();
}

function makeSession(id: string, agentGroupId: string, messagingGroupId: string, sessionName: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    session_name: sessionName,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

function initSessionDb(agentGroupId: string, sessionId: string): void {
  const dir = path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  ensureSchema(path.join(dir, 'inbound.db'), 'inbound');
  ensureSchema(path.join(dir, 'outbound.db'), 'outbound');
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Test', folder: 'test', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'tg-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });

  // Create the default (user-facing) session that the agent would have been
  // running in when it calls schedule_task.
  const defaultSession = makeSession('sess-default', 'ag-1', 'mg-1', DEFAULT_SESSION_NAME);
  createSession(defaultSession);
  initSessionDb('ag-1', 'sess-default');
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
});

describe('handleScheduleTask — dual-session routing', () => {
  it('creates the task in the maintenance session, not the default session', async () => {
    const { handleScheduleTask } = await import('./actions.js');

    const defaultSession = makeSession('sess-default', 'ag-1', 'mg-1', DEFAULT_SESSION_NAME);

    // Fake inDb for the originating session (not used by handleScheduleTask for task creation).
    const defaultDbPath = path.join(TEST_DIR, 'v2-sessions', 'ag-1', 'sess-default', 'inbound.db');
    const inDb = openInboundDb(defaultDbPath);

    await handleScheduleTask(
      {
        taskId: 'task-1',
        prompt: 'daily digest',
        script: null,
        processAfter: new Date(Date.now() + 60_000).toISOString(),
        recurrence: null,
        platformId: null,
        channelType: null,
        threadId: null,
      },
      defaultSession,
      inDb,
    );

    inDb.close();

    // The maintenance session must have been created.
    const maintSession = findSessionByAgentGroup('ag-1', MAINTENANCE_SESSION_NAME);
    expect(maintSession, 'maintenance session should be created').toBeDefined();
    expect(maintSession!.session_name).toBe(MAINTENANCE_SESSION_NAME);

    // The task row must be in the maintenance session's inbound.db.
    const maintDbPath = path.join(TEST_DIR, 'v2-sessions', 'ag-1', maintSession!.id, 'inbound.db');
    const maintDb = openInboundDb(maintDbPath);
    const tasks = maintDb.prepare("SELECT id, kind FROM messages_in WHERE id = 'task-1'").all() as Array<{
      id: string;
      kind: string;
    }>;
    maintDb.close();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe('task');
  });

  it('does not write the task into the originating default session', async () => {
    const { handleScheduleTask } = await import('./actions.js');

    const defaultSession = makeSession('sess-default', 'ag-1', 'mg-1', DEFAULT_SESSION_NAME);
    const defaultDbPath = path.join(TEST_DIR, 'v2-sessions', 'ag-1', 'sess-default', 'inbound.db');
    const inDb = openInboundDb(defaultDbPath);

    await handleScheduleTask(
      {
        taskId: 'task-2',
        prompt: 'hourly ping',
        script: null,
        processAfter: new Date(Date.now() + 60_000).toISOString(),
        recurrence: '0 * * * *',
        platformId: null,
        channelType: null,
        threadId: null,
      },
      defaultSession,
      inDb,
    );

    // The task must NOT appear in the default session's DB.
    const rows = inDb.prepare("SELECT id FROM messages_in WHERE id = 'task-2'").all() as Array<{ id: string }>;
    inDb.close();

    expect(rows).toHaveLength(0);
  });

  it('maintenance and default sessions have different IDs', async () => {
    const { handleScheduleTask } = await import('./actions.js');

    const defaultSession = makeSession('sess-default', 'ag-1', 'mg-1', DEFAULT_SESSION_NAME);
    const defaultDbPath = path.join(TEST_DIR, 'v2-sessions', 'ag-1', 'sess-default', 'inbound.db');
    const inDb = openInboundDb(defaultDbPath);

    await handleScheduleTask(
      {
        taskId: 'task-3',
        prompt: 'weekly report',
        script: null,
        processAfter: new Date(Date.now() + 3600_000).toISOString(),
        recurrence: null,
        platformId: null,
        channelType: null,
        threadId: null,
      },
      defaultSession,
      inDb,
    );
    inDb.close();

    const maintSession = findSessionByAgentGroup('ag-1', MAINTENANCE_SESSION_NAME);
    expect(maintSession).toBeDefined();
    expect(maintSession!.id).not.toBe('sess-default');
  });
});
