/**
 * Regression tests for add_reaction and edit_message MCP tools.
 *
 * Verifies that the tool handlers write correctly-shaped outbound rows so
 * the chat-sdk-bridge can deliver reactions and edits to the platform.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction, editMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

// Insert an inbound message with an explicit even seq (host-owned namespace).
function seedInbound(seq: number, id: string, platformId = 'tg-chat-123', channelType = 'telegram'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, NULL, '{"text":"hi"}')`,
    )
    .run(id, seq, platformId, channelType);
}

// Insert an outbound message with an explicit odd seq (container-owned namespace)
// and record a delivery row mapping it to a platform message ID.
function seedOutbound(seq: number, id: string, platformMsgId: string): void {
  getOutboundDb()
    .prepare(
      `INSERT INTO messages_out
         (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, datetime('now'), 'chat', 'tg-chat-123', 'telegram', NULL, '{"text":"reply"}')`,
    )
    .run(id, seq);
  getInboundDb()
    .prepare(
      `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
       VALUES (?, ?, 'delivered', datetime('now'))`,
    )
    .run(id, platformMsgId);
}

describe('add_reaction', () => {
  it('writes an outbound reaction row for an inbound message', async () => {
    // messages_in.id includes the :<agentGroupId> suffix that messageIdForAgent adds.
    seedInbound(2, 'tg-chat-123:42:ag-test-group');

    const result = await addReaction.handler({ messageId: 2, emoji: 'thumbs_up' });

    expect(result.isError).toBeFalsy();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.operation).toBe('reaction');
    expect(content.emoji).toBe('thumbs_up');
    // The compound ID is forwarded verbatim; the chat-sdk-bridge strips the
    // ":ag-..." suffix before calling adapter.addReaction.
    expect(content.messageId).toBe('tg-chat-123:42:ag-test-group');
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].platform_id).toBe('tg-chat-123');
  });

  it('writes an outbound reaction row for an outbound (already-delivered) message', async () => {
    seedOutbound(1, 'out-msg-id', 'tg-chat-123:99');

    const result = await addReaction.handler({ messageId: 1, emoji: 'heart' });

    expect(result.isError).toBeFalsy();
    const out = getUndeliveredMessages().filter((m) => {
      const c = JSON.parse(m.content);
      return c.operation === 'reaction';
    });
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.messageId).toBe('tg-chat-123:99'); // platform ID from delivered table
    expect(content.emoji).toBe('heart');
  });

  it('returns an error for an unknown seq', async () => {
    const result = await addReaction.handler({ messageId: 999, emoji: 'thumbs_up' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('#999');
  });

  it('returns an error when messageId is missing', async () => {
    const result = await addReaction.handler({ emoji: 'thumbs_up' });
    expect(result.isError).toBe(true);
  });

  it('returns an error when emoji is missing', async () => {
    seedInbound(2, 'tg-chat-123:42:ag-test-group');
    const result = await addReaction.handler({ messageId: 2 });
    expect(result.isError).toBe(true);
  });
});

describe('edit_message', () => {
  it('writes an outbound edit row targeting the platform message ID', async () => {
    seedOutbound(1, 'out-edit-id', 'tg-chat-123:77');

    const result = await editMessage.handler({ messageId: 1, text: 'Updated text' });

    expect(result.isError).toBeFalsy();
    const out = getUndeliveredMessages().filter((m) => {
      const c = JSON.parse(m.content);
      return c.operation === 'edit';
    });
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.messageId).toBe('tg-chat-123:77');
    expect(content.text).toBe('Updated text');
  });
});
