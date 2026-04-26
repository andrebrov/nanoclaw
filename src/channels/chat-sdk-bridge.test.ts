import { describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';
import type { OutboundMessage } from './adapter.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge deliver — reaction', () => {
  it('calls adapter.addReaction with the emoji and strips :ag-… suffix from messageId', async () => {
    const addReactionCalls: Array<{ threadId: string; messageId: string; emoji: string }> = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        addReaction: vi.fn(async (threadId: string, messageId: string, emoji: string) => {
          addReactionCalls.push({ threadId, messageId, emoji });
        }),
      }),
      supportsThreads: false,
    });

    const msg: OutboundMessage = {
      kind: 'chat',
      content: { operation: 'reaction', messageId: 'tg-chat-123:42:ag-test-group', emoji: 'thumbs_up' },
    };
    await bridge.deliver('tg-chat-123', null, msg);

    expect(addReactionCalls).toHaveLength(1);
    // :ag-test-group suffix must be stripped before hitting the adapter
    expect(addReactionCalls[0].messageId).toBe('tg-chat-123:42');
    expect(addReactionCalls[0].emoji).toBe('thumbs_up');
    expect(addReactionCalls[0].threadId).toBe('tg-chat-123');
  });

  it('returns undefined (not retried) even when adapter.addReaction throws', async () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        addReaction: vi.fn(async () => {
          throw new Error('Bad Request: message to react not found');
        }),
      }),
      supportsThreads: false,
    });

    const msg: OutboundMessage = {
      kind: 'chat',
      content: { operation: 'reaction', messageId: 'tg-chat-123:55', emoji: 'heart' },
    };
    // Must not throw — reaction failures are non-fatal (see comment in chat-sdk-bridge.ts)
    const result = await bridge.deliver('tg-chat-123', null, msg);
    expect(result).toBeUndefined();
  });
});
