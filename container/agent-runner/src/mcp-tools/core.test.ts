import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction } from './core.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('add_reaction MCP tool', () => {
  it('writes a reaction outbound row for a known inbound seq', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('6037840640:42', 2, 'chat', datetime('now'), 'pending', 'chan-123', 'telegram', null, '{"sender":"Alice","text":"hi"}')`,
      )
      .run();

    const result = await addReaction.handler({ messageId: 2, emoji: 'thumbs_up' });

    expect((result as { isError?: boolean }).isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.operation).toBe('reaction');
    expect(content.messageId).toBe('6037840640:42');
    expect(content.emoji).toBe('thumbs_up');
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].platform_id).toBe('chan-123');
  });

  it('returns error for unknown seq', async () => {
    const result = await addReaction.handler({ messageId: 999, emoji: 'thumbs_up' }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('returns error when messageId is zero', async () => {
    const result = await addReaction.handler({ messageId: 0, emoji: 'thumbs_up' }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('required');
  });
});
