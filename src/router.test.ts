/**
 * Regression tests for the router's threadId preservation fix (issue #7) and
 * DM auth gate (issue #72).
 *
 * Non-threaded adapters (Telegram, WhatsApp, iMessage) collapse all topics
 * into one session per group, but the inbound message must keep the real
 * threadId so outbound delivery can route replies back to the originating topic.
 *
 * The core DM gate (issue #72) blocks DM messages from senders who are not
 * listed in user_roles or agent_group_members when no accessGate hook is
 * registered (permissions module absent).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isExplicitNewRequest } from './router.js';
import { isAddressedToOtherBot, isReplyToOurMessage, threadHasBotInvolvement } from './cost-gate.js';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getAgentGroupByFolder,
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
  setMessagingGroupReactOnWake,
  getDb,
} from './db/index.js';
import { inboundDbPath } from './session-manager.js';
import { findSession } from './db/sessions.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router' };
});

const TEST_DIR = '/tmp/nanoclaw-test-router';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createAgentGroup({
    id: 'ag-main',
    name: 'Main',
    folder: 'main',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'tg-chat-1',
    name: 'Old.wtf',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('threadId preservation for non-threaded adapters (issue #7)', () => {
  it('non-mention message in topic 750 → messages_in.thread_id keeps the topic id', async () => {
    // Register a mock Telegram adapter with supportsThreads=false.
    // This simulates Telegram's channel model where all topics share one chat
    // but we still want replies routed back to the originating topic.
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('telegram', {
      factory: () => ({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: '750',
      message: {
        id: 'tg-msg-42',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Alice', text: 'hello from topic' }),
        timestamp: now(),
      },
    });

    // Session must exist and be keyed with thread_id=null (all topics → one session).
    const session = findSession('mg-1', null);
    expect(session, 'session should exist keyed on null thread').toBeDefined();
    expect(session!.thread_id).toBeNull();

    // The message in messages_in must retain thread_id='750' so the agent-runner
    // can forward it to outbound delivery and the reply lands in the correct topic.
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT thread_id FROM messages_in').all() as Array<{ thread_id: string | null }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBe('750');
  });

  it('second message in a different topic routes to the same session (session collapses)', async () => {
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('telegram', {
      factory: () => ({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { routeInbound } = await import('./router.js');

    // Two messages in different topics.
    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: '750',
      message: {
        id: 'tg-msg-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Alice', text: 'topic 750' }),
        timestamp: now(),
      },
    });
    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: '999',
      message: {
        id: 'tg-msg-2',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Bob', text: 'topic 999' }),
        timestamp: now(),
      },
    });

    // Both messages must land in the same null-thread session.
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT thread_id FROM messages_in ORDER BY timestamp').all() as Array<{
      thread_id: string | null;
    }>;
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows[0].thread_id).toBe('750');
    expect(rows[1].thread_id).toBe('999');
  });
});

// ── Core DM gate (issue #72) ──────────────────────────────────────────────────
//
// When no permissions module is loaded (accessGate === null), the router must
// still refuse DM messages from senders who are not listed in user_roles or
// agent_group_members.  These tests verify that invariant without registering
// any accessGate hook.

describe('core DM gate — no accessGate registered (issue #72)', () => {
  const DM_PLATFORM_ID = 'tg-dm-owner';

  // Each test registers a Telegram adapter and imports routeInbound freshly.
  // The shared beforeEach/afterEach above already handle DB init and cleanup.

  beforeEach(() => {
    const db = getDb();

    // DM messaging group (is_group=0, strict policy)
    createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'telegram',
      platform_id: DM_PLATFORM_ID,
      name: 'Owner DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-dm',
      messaging_group_id: 'mg-dm',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    // Register the owner in users + user_roles so the DM gate can find them.
    db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      'telegram:dm-owner',
      'telegram',
      'Owner',
      now(),
    );
    db.prepare(
      'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
    ).run('telegram:dm-owner', 'owner', null, null, now());
  });

  async function setupAdapter() {
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('telegram', {
      factory: () => ({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  }

  it('unknown sender DM → message dropped, container not spawned', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: DM_PLATFORM_ID,
      threadId: null,
      message: {
        id: 'dm-stranger-1',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'telegram:stranger', text: 'hi from stranger' }),
        timestamp: now(),
        isMention: true,
      },
    });

    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('owner DM → container spawned normally', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: DM_PLATFORM_ID,
      threadId: null,
      message: {
        id: 'dm-owner-1',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'telegram:dm-owner', text: 'hi from owner' }),
        timestamp: now(),
        isMention: true,
      },
    });

    expect(wakeContainer).toHaveBeenCalled();
  });
});

// ── Group chat auto-wire (issue #125) ─────────────────────────────────────────
//
// When the router sees the first message in a group chat it hasn't registered
// before, it should auto-create the messaging group AND auto-wire it to the
// Main agent group. No approval card, no @mention required.

describe('group chat auto-wire (issue #125)', () => {
  const GROUP_PLATFORM_ID = 'tg-group-new-9999';
  const DM_PLATFORM_ID_UNKNOWN = 'tg-dm-stranger';

  async function setupAdapter() {
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('telegram', {
      factory: () => ({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  }

  it('group chat first message (no mention) → mg auto-created, mga wired to Main, container woken', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: GROUP_PLATFORM_ID,
      threadId: null,
      isGroup: true,
      message: {
        id: 'grp-msg-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Alice', text: 'hello group' }),
        timestamp: now(),
        isMention: false,
      },
    });

    const mg = getMessagingGroupByPlatform('telegram', GROUP_PLATFORM_ID);
    expect(mg, 'messaging group should be auto-created').toBeDefined();
    expect(mg!.is_group).toBe(1);

    const agents = getMessagingGroupAgents(mg!.id);
    expect(agents).toHaveLength(1);
    expect(agents[0].agent_group_id).toBe('ag-main');
    expect(agents[0].engage_mode).toBe('pattern');
    expect(agents[0].engage_pattern).toBe('.');
    expect(agents[0].sender_scope).toBe('all');
    expect(agents[0].session_mode).toBe('shared');

    expect(wakeContainer).toHaveBeenCalled();
  });

  it('group chat first message (mention) → same auto-wire outcome', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: GROUP_PLATFORM_ID,
      threadId: null,
      isGroup: true,
      message: {
        id: 'grp-msg-mention-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Bob', text: '@bot hello' }),
        timestamp: now(),
        isMention: true,
      },
    });

    const mg = getMessagingGroupByPlatform('telegram', GROUP_PLATFORM_ID);
    expect(mg, 'messaging group should be auto-created').toBeDefined();

    const agents = getMessagingGroupAgents(mg!.id);
    expect(agents).toHaveLength(1);
    expect(agents[0].agent_group_id).toBe('ag-main');

    expect(wakeContainer).toHaveBeenCalled();
  });

  it('DM first message from unknown user → no auto-wire, container not spawned', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // DM has no wired agents and is not a group — existing approval flow
    // (or strict drop) should apply, not auto-wire.
    await routeInbound({
      channelType: 'telegram',
      platformId: DM_PLATFORM_ID_UNKNOWN,
      threadId: null,
      isGroup: false,
      message: {
        id: 'dm-stranger-2',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'telegram:stranger2', text: 'hi' }),
        timestamp: now(),
        isMention: true, // DMs always set isMention=true from bridge
      },
    });

    // MG is auto-created (because isMention=true for DMs) but must NOT be
    // auto-wired to Main — the approval flow owns DMs.
    const mg = getMessagingGroupByPlatform('telegram', DM_PLATFORM_ID_UNKNOWN);
    if (mg) {
      const agents = getMessagingGroupAgents(mg.id);
      expect(agents).toHaveLength(0);
    }
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('DM from owner/admin → routes normally (existing behaviour, no regression)', async () => {
    const db = getDb();
    // Pre-create a DM MG with ag-main wired (simulates already-registered owner DM)
    createMessagingGroup({
      id: 'mg-owner-dm',
      channel_type: 'telegram',
      platform_id: 'tg-dm-owner2',
      name: 'Owner DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-owner-dm',
      messaging_group_id: 'mg-owner-dm',
      agent_group_id: 'ag-main',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      'telegram:owner2',
      'telegram',
      'Owner2',
      now(),
    );
    db.prepare(
      'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
    ).run('telegram:owner2', 'owner', null, null, now());

    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-dm-owner2',
      threadId: null,
      isGroup: false,
      message: {
        id: 'dm-owner2-1',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'telegram:owner2', text: 'hi from owner' }),
        timestamp: now(),
        isMention: true,
      },
    });

    expect(wakeContainer).toHaveBeenCalled();
  });
});

// ── Stage 1 gate — isExplicitNewRequest (issue #175) ─────────────────────────
//
// Pure unit tests for the deterministic intent check. No DB or container
// involvement — just the function's accept/reject decisions.

describe('isExplicitNewRequest (issue #175)', () => {
  it('returns true for short messages regardless of content', () => {
    expect(isExplicitNewRequest('hi')).toBe(true);
    expect(isExplicitNewRequest('hello')).toBe(true);
    expect(isExplicitNewRequest('ok got it')).toBe(true);
  });

  it('returns true for messages containing a question mark', () => {
    expect(isExplicitNewRequest('what is the status of the deploy?')).toBe(true);
    expect(isExplicitNewRequest('can you fix the login bug? here is the context')).toBe(true);
  });

  it('returns true for normal directives', () => {
    expect(isExplicitNewRequest('fix the auth bug in login.ts')).toBe(true);
    expect(isExplicitNewRequest('here is what I need you to do: build the widget')).toBe(true);
    expect(isExplicitNewRequest('review the PR and leave comments')).toBe(true);
  });

  it('returns false for "continue from where you left off" variants', () => {
    expect(isExplicitNewRequest('continue from where you left off')).toBe(false);
    expect(isExplicitNewRequest('Continue from where we left off, here is the old context')).toBe(false);
    expect(isExplicitNewRequest('continuing from the last session, please proceed')).toBe(false);
  });

  it('returns false for "picking up from" variants', () => {
    expect(isExplicitNewRequest('picking up from where we left off last time')).toBe(false);
    expect(isExplicitNewRequest('pick up from the last checkpoint and continue')).toBe(false);
  });

  it('returns false for "resume from" variants', () => {
    expect(isExplicitNewRequest('resume from where you stopped yesterday')).toBe(false);
    expect(isExplicitNewRequest('resume from the last session context below')).toBe(false);
  });

  it('returns false for context-dump openers', () => {
    expect(isExplicitNewRequest("here's the context for the discussion that follows")).toBe(false);
    expect(isExplicitNewRequest('here is the background you will need for this work')).toBe(false);
    expect(isExplicitNewRequest('for context, the project started three months ago')).toBe(false);
    expect(isExplicitNewRequest('for background: the API was deprecated last year')).toBe(false);
    expect(isExplicitNewRequest('for your reference, attached is the spec')).toBe(false);
    expect(isExplicitNewRequest('fyi: the server went down this morning at 9am')).toBe(false);
  });

  it('returns true for empty or whitespace-only text', () => {
    expect(isExplicitNewRequest('')).toBe(true);
    expect(isExplicitNewRequest('   ')).toBe(true);
  });
});

// ── Stage 1 gate integration — group channel (issue #175) ────────────────────
//
// Verifies that context-only messages reaching a group channel (pattern='.')
// do not wake the container, but explicit directives still do.

describe('Stage 1 gate integration — group channel (issue #175)', () => {
  async function setupAdapter() {
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('telegram', {
      factory: () => ({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  }

  it('context-only message in group → message stored but container NOT woken', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: {
        id: 'ctx-msg-1',
        kind: 'chat',
        content: JSON.stringify({
          sender: 'Alice',
          text: 'continue from where you left off, here is the full context of our discussion',
        }),
        timestamp: now(),
        isMention: false,
      },
    });

    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('context-only message with explicit @mention still wakes container', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: {
        id: 'ctx-mention-msg-1',
        kind: 'chat',
        content: JSON.stringify({
          sender: 'Alice',
          text: 'continue from where you left off, here is the full context of our discussion',
        }),
        timestamp: now(),
        isMention: true,
      },
    });

    expect(wakeContainer).toHaveBeenCalled();
  });

  it('normal directive in group → container woken as before', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: {
        id: 'directive-msg-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Bob', text: 'fix the login bug in auth.ts' }),
        timestamp: now(),
        isMention: false,
      },
    });

    expect(wakeContainer).toHaveBeenCalled();
  });

  it('duplicate context-only messages → zero container wakes', async () => {
    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const contextMsg = {
      sender: 'Alice',
      text: 'for context: the project was set up six months ago and these are the legacy files',
    };

    // Simulate the same context arriving three times (e.g. scheduled re-delivery)
    for (let i = 0; i < 3; i++) {
      await routeInbound({
        channelType: 'telegram',
        platformId: 'tg-chat-1',
        threadId: null,
        message: {
          id: `dup-ctx-${i}`,
          kind: 'chat',
          content: JSON.stringify(contextMsg),
          timestamp: now(),
          isMention: false,
        },
      });
    }

    expect(wakeContainer).not.toHaveBeenCalled();
  });
});

// ── Stage 1 cost-gate helpers (issue #174) ───────────────────────────────────
//
// Pure-unit tests for the deterministic helpers in cost-gate.ts. No network
// calls, no container involvement. The DB-backed helpers (isReplyToOurMessage,
// threadHasBotInvolvement) use a temporary messages.db that the shared
// beforeEach below seeds at the DATA_DIR path (mocked to '/tmp/nanoclaw-test-router').

// The config.js mock above maps DATA_DIR → '/tmp/nanoclaw-test-router', so
// cost-gate.ts will open its messages.db at that path. Seed it before tests.
const COST_GATE_DB_PATH = path.join('/tmp/nanoclaw-test-router', 'messages.db');

beforeEach(() => {
  // The outer beforeEach has already created '/tmp/nanoclaw-test-router' and
  // its v2.db. Now seed a messages.db with known outbound rows for cost-gate tests.
  if (!fs.existsSync('/tmp/nanoclaw-test-router')) {
    fs.mkdirSync('/tmp/nanoclaw-test-router', { recursive: true });
  }
  // Overwrite any messages.db written by previous test runs (message-store
  // lazily creates it on first use; here we pre-populate it for cost-gate tests).
  if (fs.existsSync(COST_GATE_DB_PATH)) fs.unlinkSync(COST_GATE_DB_PATH);
  const db = new Database(COST_GATE_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      messaging_group_id TEXT,
      channel_type       TEXT NOT NULL,
      platform_id        TEXT NOT NULL,
      thread_id          TEXT,
      direction          TEXT NOT NULL,
      kind               TEXT,
      sender_user_id     TEXT,
      sender_name        TEXT,
      text               TEXT,
      content_json       TEXT,
      platform_msg_id    TEXT,
      session_id         TEXT,
      agent_group_id     TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Outbound row: bot sent a message on this channel/thread
  db.prepare(
    `INSERT INTO messages
       (channel_type, platform_id, thread_id, direction, platform_msg_id, created_at)
       VALUES ('telegram', 'tg-cost-chat', 'thread-A', 'out', '42000', datetime('now'))`,
  ).run();
  // Inbound row (NOT ours): should NOT match isReplyToOurMessage
  db.prepare(
    `INSERT INTO messages
       (channel_type, platform_id, thread_id, direction, platform_msg_id, created_at)
       VALUES ('telegram', 'tg-cost-chat', null, 'in', '41999', datetime('now'))`,
  ).run();
  db.close();
});

describe('isAddressedToOtherBot (issue #174)', () => {
  it('returns false when no other-bot handles configured', () => {
    expect(isAddressedToOtherBot('@RockyBot fix this', [])).toBe(false);
  });

  it('returns true when message @-mentions a known other-bot handle', () => {
    expect(isAddressedToOtherBot('@RockyBot fix the login', ['RockyBot', 'LoMBot'])).toBe(true);
  });

  it('returns true for handle mid-sentence', () => {
    expect(isAddressedToOtherBot('hey @LoMBot what do you think?', ['RockyBot', 'LoMBot'])).toBe(true);
  });

  it('returns false when message mentions our own bot (not in otherBotHandles)', () => {
    expect(isAddressedToOtherBot('@OurBot do this', ['RockyBot', 'LoMBot'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAddressedToOtherBot('@rockybot fix this', ['RockyBot'])).toBe(true);
  });

  it('requires word boundary (no partial match)', () => {
    expect(isAddressedToOtherBot('we use RockyBotXYZ today', ['RockyBot'])).toBe(false);
  });
});

describe('isReplyToOurMessage (issue #174)', () => {
  it('returns true when replyToMsgId matches an outbound platform_msg_id', () => {
    expect(isReplyToOurMessage('telegram', 'tg-cost-chat', '42000')).toBe(true);
  });

  it('returns true for numeric replyToMsgId matching string platform_msg_id', () => {
    expect(isReplyToOurMessage('telegram', 'tg-cost-chat', 42000)).toBe(true);
  });

  it('returns false when replyToMsgId matches an inbound message (not ours)', () => {
    expect(isReplyToOurMessage('telegram', 'tg-cost-chat', '41999')).toBe(false);
  });

  it('returns false for null replyToMsgId', () => {
    expect(isReplyToOurMessage('telegram', 'tg-cost-chat', null)).toBe(false);
  });

  it('returns false for unknown channel/platform', () => {
    expect(isReplyToOurMessage('slack', 'no-such-channel', '42000')).toBe(false);
  });
});

describe('threadHasBotInvolvement (issue #174)', () => {
  it('returns true when thread has a prior bot outbound message', () => {
    expect(threadHasBotInvolvement('telegram', 'tg-cost-chat', 'thread-A')).toBe(true);
  });

  it('returns false for a thread with no outbound messages', () => {
    expect(threadHasBotInvolvement('telegram', 'tg-cost-chat', 'thread-Z')).toBe(false);
  });

  it('returns false for a different channel', () => {
    expect(threadHasBotInvolvement('slack', 'tg-cost-chat', 'thread-A')).toBe(false);
  });
});

// ── react_on_wake toggle — host observer suppression (issue #215) ─────────────
//
// When react_on_wake=0 is set on a messaging group, the router must call
// startSessionObserver with platformMsgId=null so the observer never emits a
// 👀 reaction. When react_on_wake=1 (default), platformMsgId is the actual
// inbound message ID so the 👀 fires normally.
//
// We spy on startSessionObserver directly — that's the exact gate between the
// router's shouldReact decision and the observer's reaction cycle.

vi.mock('./observer.js', () => ({
  startSessionObserver: vi.fn(),
  destroySessionObserver: vi.fn(),
  notifyObserverReply: vi.fn(),
  feedObserverLine: vi.fn(),
}));

describe('react_on_wake=off suppresses host-driven 👀 reaction (issue #215)', () => {
  const PLATFORM_ID = 'tg-chat-1';

  async function setupAdapter() {
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('telegram', {
      factory: () => ({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  }

  it('react_on_wake=off → startSessionObserver called with null platformMsgId (issue #215 regression)', async () => {
    const mg = getMessagingGroupByPlatform('telegram', PLATFORM_ID);
    expect(mg).toBeDefined();
    setMessagingGroupReactOnWake(mg!.id, false);

    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { startSessionObserver } = await import('./observer.js');
    (startSessionObserver as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: PLATFORM_ID,
      threadId: null,
      message: {
        id: 'react-off-msg-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Alice', text: 'hello, no reactions please' }),
        timestamp: now(),
        isMention: true,
      },
    });

    expect(startSessionObserver).toHaveBeenCalled();
    const call = (startSessionObserver as ReturnType<typeof vi.fn>).mock.calls[0];
    // Second argument is platformMsgId — must be null when react_on_wake=0.
    expect(call[1]).toBeNull();
  });

  it('react_on_wake=on (default) → startSessionObserver called with real platformMsgId', async () => {
    const mg = getMessagingGroupByPlatform('telegram', PLATFORM_ID);
    expect(mg).toBeDefined();
    setMessagingGroupReactOnWake(mg!.id, true);

    await setupAdapter();
    const { routeInbound } = await import('./router.js');
    const { startSessionObserver } = await import('./observer.js');
    (startSessionObserver as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: PLATFORM_ID,
      threadId: null,
      message: {
        id: 'react-on-msg-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Bob', text: 'reactions welcome' }),
        timestamp: now(),
        isMention: true,
      },
    });

    expect(startSessionObserver).toHaveBeenCalled();
    const call = (startSessionObserver as ReturnType<typeof vi.fn>).mock.calls[0];
    // Second argument is platformMsgId — must be the real message ID when react_on_wake=1.
    expect(call[1]).toBe('react-on-msg-1');
  });
});
