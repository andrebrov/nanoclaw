/**
 * In-memory token-bucket rate limiter for inbound messages.
 *
 * One bucket per messaging_group_id. A null or zero limit means unlimited.
 * Tokens refill continuously at maxPerMinute / 60 000 ms. The bucket starts
 * full so short conversations never see the limiter.
 *
 * `firstDrop` is true on the first message blocked in a throttle window so
 * the caller can send exactly one notice and then stay silent until the
 * bucket opens again.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  noticeSent: boolean;
  readonly maxTokens: number;
  readonly ratePerMs: number;
}

const buckets = new Map<string, Bucket>();

function getOrCreate(groupId: string, maxPerMinute: number): Bucket {
  const existing = buckets.get(groupId);
  if (existing && existing.maxTokens === maxPerMinute) return existing;
  const bucket: Bucket = {
    tokens: maxPerMinute,
    lastRefillMs: Date.now(),
    noticeSent: false,
    maxTokens: maxPerMinute,
    ratePerMs: maxPerMinute / 60_000,
  };
  buckets.set(groupId, bucket);
  return bucket;
}

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefillMs;
  const prev = bucket.tokens;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.ratePerMs);
  bucket.lastRefillMs = now;
  if (prev <= 0 && bucket.tokens > 0) {
    bucket.noticeSent = false;
  }
}

/**
 * Check whether the next message from `groupId` is allowed.
 *
 * Returns `{ allowed: true }` when under the limit or when `maxPerMinute` is
 * null/0 (unlimited).
 * Returns `{ allowed: false, firstDrop: true }` the first time a window is
 * exhausted — caller should send a throttle notice.
 * Returns `{ allowed: false, firstDrop: false }` for subsequent drops in the
 * same window — caller should drop silently.
 */
export function checkInboundRateLimit(
  groupId: string,
  maxPerMinute: number | null,
): { allowed: boolean; firstDrop: boolean } {
  if (!maxPerMinute || maxPerMinute <= 0) return { allowed: true, firstDrop: false };
  const bucket = getOrCreate(groupId, maxPerMinute);
  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, firstDrop: false };
  }
  const firstDrop = !bucket.noticeSent;
  bucket.noticeSent = true;
  return { allowed: false, firstDrop };
}

/** Remove the bucket for a group. Used in tests. */
export function resetRateLimitBucket(groupId: string): void {
  buckets.delete(groupId);
}
