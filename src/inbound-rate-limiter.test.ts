import { describe, it, expect, beforeEach } from 'vitest';

import { checkInboundRateLimit, resetRateLimitBucket } from './inbound-rate-limiter.js';

const GROUP = 'mg-test-rl';

beforeEach(() => {
  resetRateLimitBucket(GROUP);
});

describe('checkInboundRateLimit', () => {
  it('allows all messages when limit is null', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkInboundRateLimit(GROUP, null).allowed).toBe(true);
    }
  });

  it('allows messages up to the limit', () => {
    const limit = 5;
    for (let i = 0; i < limit; i++) {
      expect(checkInboundRateLimit(GROUP, limit).allowed).toBe(true);
    }
  });

  it('blocks the message after the limit is exhausted', () => {
    const limit = 3;
    for (let i = 0; i < limit; i++) {
      checkInboundRateLimit(GROUP, limit);
    }
    const result = checkInboundRateLimit(GROUP, limit);
    expect(result.allowed).toBe(false);
  });

  it('sets firstDrop=true only on the first blocked message', () => {
    const limit = 2;
    checkInboundRateLimit(GROUP, limit);
    checkInboundRateLimit(GROUP, limit);

    const first = checkInboundRateLimit(GROUP, limit);
    expect(first.allowed).toBe(false);
    expect(first.firstDrop).toBe(true);

    const second = checkInboundRateLimit(GROUP, limit);
    expect(second.allowed).toBe(false);
    expect(second.firstDrop).toBe(false);
  });

  it('isolates buckets per group', () => {
    const other = 'mg-other';
    resetRateLimitBucket(other);

    const limit = 1;
    checkInboundRateLimit(GROUP, limit);
    const blocked = checkInboundRateLimit(GROUP, limit);
    expect(blocked.allowed).toBe(false);

    // Different group should still be at full capacity
    expect(checkInboundRateLimit(other, limit).allowed).toBe(true);
    resetRateLimitBucket(other);
  });

  it('returns firstDrop=false when limit is 0 (treated as unlimited)', () => {
    const result = checkInboundRateLimit(GROUP, 0);
    expect(result.allowed).toBe(true);
    expect(result.firstDrop).toBe(false);
  });
});
