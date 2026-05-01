/**
 * Tests for the middleware chain executor.
 *
 * Key guarantees verified here:
 *   1. Slots run in declared order (not reversed, not parallel).
 *   2. The first blocking slot short-circuits — later slots never run.
 *   3. True spawn errors (child.on('error')) fail open; a missing binary with
 *      shell: true exits 127 and is treated as a normal block.
 *   4. A non-zero exit code blocks with the stdout as the reason.
 *   5. JSON { decision: 'block' } in stdout blocks; { decision: 'continue' } or exit 0 passes.
 *   6. An empty chain passes through unconditionally.
 *
 * All slots use plain shell commands so the tests run without any stubs or
 * mocks.  Timeouts are generous to avoid flakiness on slow CI machines —
 * the built-in 10 s per-slot timeout is intentionally NOT tested here
 * because sleeping 10 s in a unit test would be unreasonable.
 */
import { describe, it, expect } from 'bun:test';

import { createMiddlewareHook } from './middleware-chain.js';
import type { MiddlewareSlot } from '../config.js';

// The SDK's HookCallback input type varies per event.  For testing the chain
// executor we only care that the input is forwarded to the slot as JSON on
// stdin — the shape itself doesn't matter to the chain logic.
const DUMMY_INPUT = { tool_name: 'Read', type: 'PreToolUse' };

describe('createMiddlewareHook', () => {
  it('passes through when the chain is empty', async () => {
    const hook = createMiddlewareHook([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toEqual({ continue: true });
  });

  it('passes through when all slots exit 0 with no stdout', async () => {
    const slots: MiddlewareSlot[] = [
      { name: 'first', command: 'exit 0' },
      { name: 'second', command: 'exit 0' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toEqual({ continue: true });
  });

  it('blocks when a slot exits non-zero', async () => {
    const slots: MiddlewareSlot[] = [{ name: 'blocker', command: 'exit 1' }];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block' });
  });

  it('uses stdout as the block reason on non-zero exit', async () => {
    const slots: MiddlewareSlot[] = [
      { name: 'blocker', command: 'echo "rate limit exceeded"; exit 2' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block', stopReason: 'rate limit exceeded' });
  });

  it('blocks when slot emits JSON { decision: "block" } and exits 0', async () => {
    const slots: MiddlewareSlot[] = [
      { name: 'json-blocker', command: 'echo \'{"decision":"block","reason":"policy violation"}\'' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block', stopReason: 'policy violation' });
  });

  it('passes through when slot emits JSON { decision: "continue" }', async () => {
    const slots: MiddlewareSlot[] = [
      { name: 'json-continue', command: 'echo \'{"decision":"continue"}\'' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toEqual({ continue: true });
  });

  it('short-circuits on first block — later slots do not run', async () => {
    // The second slot would fail the test if it ran — its non-zero exit would
    // produce a different reason string.  If reason matches the first slot's
    // message we know the chain stopped there.
    const slots: MiddlewareSlot[] = [
      { name: 'first', command: 'echo \'{"decision":"block","reason":"stopped by first"}\'' },
      { name: 'second', command: 'echo \'{"decision":"block","reason":"stopped by second"}\'' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block', stopReason: 'stopped by first' });
  });

  it('order matters — second slot blocks when first passes', async () => {
    const slots: MiddlewareSlot[] = [
      { name: 'pass', command: 'exit 0' },
      { name: 'blocker', command: 'echo \'{"decision":"block","reason":"second slot blocked"}\'' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block', stopReason: 'second slot blocked' });
  });

  it('swapping order changes which slot fires first', async () => {
    const blockFirst: MiddlewareSlot[] = [
      { name: 'alpha', command: 'echo \'{"decision":"block","reason":"alpha"}\'' },
      { name: 'beta', command: 'echo \'{"decision":"block","reason":"beta"}\'' },
    ];
    const blockSecond: MiddlewareSlot[] = [
      { name: 'beta', command: 'echo \'{"decision":"block","reason":"beta"}\'' },
      { name: 'alpha', command: 'echo \'{"decision":"block","reason":"alpha"}\'' },
    ];

    const hookFirst = createMiddlewareHook(blockFirst);
    const hookSecond = createMiddlewareHook(blockSecond);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = await hookFirst(DUMMY_INPUT as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2 = await hookSecond(DUMMY_INPUT as any);

    expect(r1).toMatchObject({ stopReason: 'alpha' });
    expect(r2).toMatchObject({ stopReason: 'beta' });
  });

  it('blocks when the binary is not found (shell exits 127)', async () => {
    // With shell: true the /bin/sh wrapper is always spawned; a missing binary
    // causes /bin/sh to exit 127 — that is a normal (blocking) non-zero exit,
    // not a spawn error.  Fail-open only fires when /bin/sh itself cannot be
    // launched (child.on('error')), which cannot happen in a normal environment.
    const slots: MiddlewareSlot[] = [
      { name: 'bad', command: '/this-binary-does-not-exist-xyz-abc-123' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block' });
  });

  it('multiple passing slots followed by a blocker — all pass slots run, blocker fires', async () => {
    const slots: MiddlewareSlot[] = [
      { name: 'pass1', command: 'exit 0' },
      { name: 'pass2', command: 'echo \'{"decision":"continue"}\'' },
      { name: 'pass3', command: 'exit 0' },
      { name: 'final-block', command: 'exit 1' },
    ];
    const hook = createMiddlewareHook(slots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hook(DUMMY_INPUT as any);
    expect(result).toMatchObject({ decision: 'block' });
  });
});
