/**
 * Regression tests for the router's threadId preservation fix (issue #7).
 *
 * Non-threaded adapters (Telegram, WhatsApp, iMessage) collapse all topics
 * into one session per group, but the inbound message must keep the real
 * threadId so outbound delivery can route replies back to the originating topic.
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
