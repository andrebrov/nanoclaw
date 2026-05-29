/**
 * Unit tests for the iter-10 crash-loop backoff helpers
 * (`computeBackoffMs`, `recordCrash`, `clearCrashRecord`).
 *
 * The functions are private to container-runner.ts; the module exposes
 * them via `_testCrashBackoff` for regression coverage. Tests are pure
 * — no docker, no filesystem, no sleep — and run in <10ms total.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _testCrashBackoff } from './container-runner.js';

const { computeBackoffMs, recordCrash, clearCrashRecord, reset, constants } = _testCrashBackoff;

afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe('crash-loop backoff', () => {
  it('returns 0 when no crash record exists', () => {
    expect(computeBackoffMs('sess-unknown')).toBe(0);
  });

  it('1st crash is free (no backoff)', () => {
    recordCrash('sess-1');
    expect(computeBackoffMs('sess-1')).toBe(0);
  });

  it('2nd crash → BASE_BACKOFF_MS (5s)', () => {
    recordCrash('sess-1');
    recordCrash('sess-1');
    expect(computeBackoffMs('sess-1')).toBe(constants.BASE_BACKOFF_MS);
  });

  it('3rd crash → 2× BASE_BACKOFF_MS (10s)', () => {
    recordCrash('sess-1');
    recordCrash('sess-1');
    recordCrash('sess-1');
    expect(computeBackoffMs('sess-1')).toBe(constants.BASE_BACKOFF_MS * 2);
  });

  it('progresses as expected: 0, 0, 5s, 10s, 20s, 40s, capped at MAX (60s)', () => {
    const expected = [
      0,
      0,
      constants.BASE_BACKOFF_MS,
      constants.BASE_BACKOFF_MS * 2,
      constants.BASE_BACKOFF_MS * 4,
      constants.BASE_BACKOFF_MS * 8,
      constants.MAX_BACKOFF_MS, // 6th crash would compute 80s but caps at 60s
      constants.MAX_BACKOFF_MS, // stays at cap
    ];
    for (const [i, want] of expected.entries()) {
      const actual = computeBackoffMs('sess-1');
      expect(actual, `before crash #${i + 1}`).toBe(want);
      recordCrash('sess-1');
    }
  });

  it('clearCrashRecord wipes the entry (used on clean exit)', () => {
    recordCrash('sess-1');
    recordCrash('sess-1');
    recordCrash('sess-1');
    expect(computeBackoffMs('sess-1')).toBeGreaterThan(0);
    clearCrashRecord('sess-1');
    expect(computeBackoffMs('sess-1')).toBe(0);
  });

  it('stale records are reset after CRASH_RESET_WINDOW_MS without further crashes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T00:00:00Z'));
    recordCrash('sess-1');
    recordCrash('sess-1');
    recordCrash('sess-1');
    expect(computeBackoffMs('sess-1')).toBeGreaterThan(0);
    // Advance past the reset window — a session that stayed quiet for >5min
    // shouldn't pay for ancient crashes.
    vi.setSystemTime(new Date(Date.now() + constants.CRASH_RESET_WINDOW_MS + 1000));
    expect(computeBackoffMs('sess-1')).toBe(0);
  });

  it('crash after the reset window starts the counter fresh', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T00:00:00Z'));
    recordCrash('sess-1');
    recordCrash('sess-1');
    recordCrash('sess-1');
    vi.setSystemTime(new Date(Date.now() + constants.CRASH_RESET_WINDOW_MS + 1000));
    // Next crash should be treated as the first in a new window.
    recordCrash('sess-1');
    // Single fresh crash → no backoff yet (matches "1st crash is free").
    expect(computeBackoffMs('sess-1')).toBe(0);
  });

  it('separate sessions track independently', () => {
    recordCrash('sess-a');
    recordCrash('sess-a');
    recordCrash('sess-a');
    expect(computeBackoffMs('sess-a')).toBeGreaterThan(0);
    expect(computeBackoffMs('sess-b')).toBe(0);
  });
});
