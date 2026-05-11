/**
 * Regression tests for the inReplyTo-in-group-chat send_message validator.
 *
 * The hook protects threading: in a group chat the agent must pass
 * `inReplyTo` so its reply lands under the message it is answering instead
 * of as a new top-level post. DMs and agent destinations are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { setTurnSourceRouting } from '../db/session-state.js';
import { evaluateInReplyToGroupGate } from './inreplyto-group-validator.js';

function seedDestination(opts: {
  name: string;
  type?: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
  isGroup?: 0 | 1;
}): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations
         (name, display_name, type, channel_type, platform_id, agent_group_id, is_group)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.name,
      opts.name,
      opts.type ?? 'channel',
      opts.channelType ?? null,
      opts.platformId ?? null,
      opts.agentGroupId ?? null,
      opts.isGroup ?? 0,
    );
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('evaluateInReplyToGroupGate', () => {
  describe('blocks group sends without inReplyTo', () => {
    it('blocks send_message to a group destination when inReplyTo is missing', () => {
      seedDestination({
        name: 'family',
        channelType: 'telegram',
        platformId: 'tg-group-1',
        isGroup: 1,
      });
      const result = evaluateInReplyToGroupGate({ to: 'family', text: 'hello everyone' });
      expect(result.block).toBe(true);
      if (!result.block) throw new Error('unreachable');
      expect(result.reason).toContain('inReplyTo');
      expect(result.reason.toLowerCase()).toContain('group chat');
      expect(result.reason).toContain('family');
      expect(result.destination.name).toBe('family');
    });

    it('blocks when `to` is omitted and the current turn source is a group', () => {
      seedDestination({
        name: 'family',
        channelType: 'telegram',
        platformId: 'tg-group-1',
        isGroup: 1,
      });
      setTurnSourceRouting('telegram', 'tg-group-1', null);
      const result = evaluateInReplyToGroupGate({ text: 'hi' });
      expect(result.block).toBe(true);
    });

    it('blocks even when inReplyTo is explicitly null', () => {
      seedDestination({
        name: 'family',
        channelType: 'telegram',
        platformId: 'tg-group-1',
        isGroup: 1,
      });
      const result = evaluateInReplyToGroupGate({ to: 'family', text: 'hi', inReplyTo: null });
      expect(result.block).toBe(true);
    });
  });

  describe('allows DMs without inReplyTo', () => {
    it('does not block send_message to a non-group destination', () => {
      seedDestination({
        name: 'andrei_dm',
        channelType: 'telegram',
        platformId: 'tg-dm-1',
        isGroup: 0,
      });
      const result = evaluateInReplyToGroupGate({ to: 'andrei_dm', text: 'just for you' });
      expect(result.block).toBe(false);
    });

    it('does not block send_message to an agent destination', () => {
      seedDestination({
        name: 'worker-1',
        type: 'agent',
        agentGroupId: 'ag-worker-1',
        isGroup: 0,
      });
      const result = evaluateInReplyToGroupGate({ to: 'worker-1', text: 'go research X' });
      expect(result.block).toBe(false);
    });
  });

  describe('allows when inReplyTo is present', () => {
    it('allows send_message to a group destination when inReplyTo is set', () => {
      seedDestination({
        name: 'family',
        channelType: 'telegram',
        platformId: 'tg-group-1',
        isGroup: 1,
      });
      const result = evaluateInReplyToGroupGate({ to: 'family', text: 'hello', inReplyTo: 42 });
      expect(result.block).toBe(false);
    });

    it('allows inReplyTo as a positive integer', () => {
      seedDestination({
        name: 'family',
        channelType: 'telegram',
        platformId: 'tg-group-1',
        isGroup: 1,
      });
      const result = evaluateInReplyToGroupGate({ to: 'family', text: 'hi', inReplyTo: 1 });
      expect(result.block).toBe(false);
    });
  });

  describe('fail-open edge cases', () => {
    it('does not block when the destination name is unknown (handler will surface the error)', () => {
      const result = evaluateInReplyToGroupGate({ to: 'nope', text: 'hi' });
      expect(result.block).toBe(false);
    });

    it('does not block when no destination can be resolved and no routing is set', () => {
      const result = evaluateInReplyToGroupGate({ text: 'hi' });
      expect(result.block).toBe(false);
    });

    it('does not block when tool_input is missing', () => {
      const result = evaluateInReplyToGroupGate(undefined);
      expect(result.block).toBe(false);
    });
  });
});
