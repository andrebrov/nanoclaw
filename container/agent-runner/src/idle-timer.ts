/**
 * Idle timer with generation guards for the poll-loop query lifecycle.
 *
 * Resets on every provider `activity` event and on every mid-turn
 * `query.push()` call so the callback fires only when the container
 * has been genuinely quiet for the full idle window.
 *
 * Generation guards: each call to `newIdleGeneration()` increments a
 * module-level counter and cancels the in-flight timer. Any timer
 * callback that was scheduled against an older generation is silently
 * dropped, preventing a stale timer from one `processQuery` invocation
 * from firing during a subsequent one (cross-query race).
 */

let _handle: ReturnType<typeof setTimeout> | null = null;
let _generation = 0;
let _onFire: (() => void) | null = null;
let _intervalMs = 0;

/**
 * Start a new idle generation. Cancels any timer outstanding from the
 * previous generation. Call once at the top of each `processQuery`.
 */
export function newIdleGeneration(): void {
  _generation++;
  if (_handle !== null) {
    clearTimeout(_handle);
    _handle = null;
  }
  _onFire = null;
}

/**
 * Reset (or start) the idle timer. The callback fires after `ms` ms of
 * silence. Each call cancels the previous timer, restarting the countdown.
 *
 * The generation captured at call time is checked before the callback runs —
 * if `newIdleGeneration()` was called in the meantime (a new query started),
 * the callback is suppressed.
 */
export function resetIdleTimer(onFire: () => void, ms: number): void {
  if (_handle !== null) clearTimeout(_handle);
  _onFire = onFire;
  _intervalMs = ms;
  const gen = _generation;
  _handle = setTimeout(() => {
    if (_generation !== gen) return;
    _handle = null;
    _onFire?.();
  }, ms);
}

/**
 * Cancel the idle timer without advancing the generation. Use in the
 * `finally` block of `processQuery` to ensure the timer doesn't outlive
 * the query.
 */
export function clearIdleTimer(): void {
  if (_handle !== null) {
    clearTimeout(_handle);
    _handle = null;
  }
  _onFire = null;
}

/** Exposed for testing only. */
export function _getGeneration(): number {
  return _generation;
}
