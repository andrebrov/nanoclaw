import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, clearStaleProcessingAcks } from './db/connection.js';
import { getPendingMessages, markCompleted, markProcessing } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import {
  setTurnReplyTo,
  clearTurnReplyTo,
  getTurnReplyTo,
  setTurnSourceRouting,
  clearTurnSourceRouting,
} from './db/session-state.js';
import { formatMessages, extractRouting } from './formatter.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: {
    processAfter?: string;
    trigger?: 0 | 1;
    platformId?: string;
    channelType?: string;
    threadId?: string;
  },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.platformId ?? null,
      opts?.channelType ?? null,
      opts?.threadId ?? null,
      JSON.stringify(content),
    );
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SCHEDULED TASK]');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[WEBHOOK: github/push]');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SYSTEM RESPONSE]');
    expect(prompt).toContain('register_group');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('[SYSTEM RESPONSE]');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('inReplyTo uses last trigger=1 message, not last overall, in a multi-bot batch', () => {
    // Simulate a busy group chat: m1 (trigger=0 context), m2 (trigger=1, the
    // @-mention that addressed this bot), m3 (trigger=0, a subsequent bot
    // message that landed before the agent ran). inReplyTo must be m2 — the
    // last trigger=1 message, i.e. the most recent user engagement — not m3.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES
           ('m1', 1, 'chat', datetime('now'), 'pending', 0, 'grp-1', 'telegram', null, '{"text":"earlier chatter"}'),
           ('m2', 2, 'chat', datetime('now'), 'pending', 1, 'grp-1', 'telegram', null, '{"text":"@MythicalClawBot help"}'),
           ('m3', 3, 'chat', datetime('now'), 'pending', 0, 'grp-1', 'telegram', null, '{"text":"another bot reply"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    // Channel routing should use the last message (m3)
    expect(routing.platformId).toBe('grp-1');
    expect(routing.channelType).toBe('telegram');
    // inReplyTo must be m2 (first trigger=1), not m3 (last overall)
    expect(routing.inReplyTo).toBe('m2');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('concurrent-access protection (no duplicate processing)', () => {
  it('messages claimed by processing_ack are invisible to concurrent getPendingMessages', () => {
    // This is the v2 architectural guarantee that prevents the race condition
    // described in issue #56: all inbound messages go through a single
    // agent-runner queue, and processing_ack acts as a distributed lock.
    insertMessage('m1', 'chat', { sender: 'User', text: 'hello' });

    // m1 is pending and visible to any reader
    expect(getPendingMessages()).toHaveLength(1);

    // Simulate the poll loop claiming m1 for processing
    markProcessing(['m1']);

    // A concurrent reader (e.g., a hypothetical check-unanswered scan) must
    // not see m1 — processing_ack filters it out regardless of its status.
    expect(getPendingMessages()).toHaveLength(0);
  });

  it('completed messages remain invisible after markCompleted', () => {
    insertMessage('m1', 'chat', { sender: 'User', text: 'hello' });

    markProcessing(['m1']);
    markCompleted(['m1']);

    expect(getPendingMessages()).toHaveLength(0);
  });

  it('a new message is visible while an older one is being processed', () => {
    insertMessage('m1', 'chat', { sender: 'User', text: 'first' });
    markProcessing(['m1']);

    insertMessage('m2', 'chat', { sender: 'User', text: 'second' });

    const pending = getPendingMessages();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('m2');
  });
});

describe('replyTo across container restart', () => {
  // Regression test for issue #213: after a container restart (or session resume),
  // the outbound in_reply_to field must still be set correctly for each new turn.
  //
  // The poll-loop computes routing.inReplyTo = messages_in.id of the last trigger=1
  // message at the start of each turn, stores it in session_state (turn_reply_to),
  // and passes it through to messages_out. A restart does not break this because:
  //   1. session_state persists in outbound.db across restarts
  //   2. clearStaleProcessingAcks only resets 'processing' entries — completed
  //      messages stay excluded from getPendingMessages()
  //   3. Each new turn recomputes and overwrites turn_reply_to from scratch

  function simulateTurn(
    msgId: string,
    platformId: string,
    channelType: string,
  ): { outId: string; inReplyTo: string | null } {
    const messages = getPendingMessages();
    expect(messages.length).toBeGreaterThan(0);

    const routing = extractRouting(messages);

    // Simulate what poll-loop does at turn start
    if (routing.inReplyTo) {
      setTurnReplyTo(routing.inReplyTo);
    } else {
      clearTurnReplyTo();
    }
    setTurnSourceRouting(routing.channelType, routing.platformId, routing.threadId);

    // Verify session_state has the right value before the agent acts
    expect(getTurnReplyTo()).toBe(msgId);

    // Simulate the agent sending a reply (dispatchResultText path)
    const outId = `out-${msgId}`;
    writeMessageOut({
      id: outId,
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: platformId,
      channel_type: channelType,
      thread_id: null,
      content: JSON.stringify({ text: `Reply to ${msgId}` }),
    });

    markCompleted([msgId]);
    clearTurnReplyTo();
    clearTurnSourceRouting();

    const all = getUndeliveredMessages();
    const out = all.find((m) => m.id === outId)!;
    return { outId, inReplyTo: out.in_reply_to };
  }

  it('in_reply_to is set on both turns: before and after a simulated restart', () => {
    const platformId = 'chan-123';
    const channelType = 'telegram';

    // Turn 1 (fresh session)
    insertMessage('msg-turn-1', 'chat', { sender: 'User', text: 'Hello' }, { platformId, channelType });
    const turn1 = simulateTurn('msg-turn-1', platformId, channelType);
    expect(turn1.inReplyTo).toBe('msg-turn-1');

    // Simulate container restart: clearStaleProcessingAcks resets only 'processing'
    // entries; 'completed' rows remain, so msg-turn-1 stays excluded from pending.
    clearStaleProcessingAcks();

    // Verify msg-turn-1 is not re-queued after the restart
    expect(getPendingMessages()).toHaveLength(0);

    // Turn 2 (resumed session — new message arrives after the restart)
    insertMessage('msg-turn-2', 'chat', { sender: 'User', text: 'Follow up' }, { platformId, channelType });
    const turn2 = simulateTurn('msg-turn-2', platformId, channelType);
    expect(turn2.inReplyTo).toBe('msg-turn-2');

    // The two turns must reference their own triggering messages, not each other
    expect(turn1.inReplyTo).not.toBe(turn2.inReplyTo);
  });

  it('turn_reply_to in session_state is overwritten on each new turn after restart', () => {
    // When a container is killed before clearTurnReplyTo() runs, session_state
    // retains the stale turn_reply_to from the previous turn. The next turn must
    // overwrite it with the fresh inReplyTo so MCP send_message threads correctly.

    // Simulate a stale turn_reply_to left by a crashed container
    setTurnReplyTo('stale-msg-id');
    expect(getTurnReplyTo()).toBe('stale-msg-id');

    // clearStaleProcessingAcks (container startup) does NOT touch session_state
    clearStaleProcessingAcks();
    expect(getTurnReplyTo()).toBe('stale-msg-id'); // stale value persists after restart

    // New message arrives: poll-loop must overwrite the stale value
    insertMessage(
      'msg-fresh',
      'chat',
      { sender: 'User', text: 'New message' },
      { platformId: 'chan-1', channelType: 'telegram' },
    );
    const messages = getPendingMessages();
    const routing = extractRouting(messages);

    if (routing.inReplyTo) {
      setTurnReplyTo(routing.inReplyTo);
    } else {
      clearTurnReplyTo();
    }

    // The stale value must be replaced with the new message's id
    expect(getTurnReplyTo()).toBe('msg-fresh');
    expect(getTurnReplyTo()).not.toBe('stale-msg-id');
  });
});
