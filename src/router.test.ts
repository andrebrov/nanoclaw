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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
