/**
 * Process-level counters for every defense layer added in the 2026-05-29
 * resilience pass. Bumped at the firing site of each layer; read by the
 * host-sweep state snapshot every ~10 minutes so operators see at a
 * glance which defenses have engaged since host start.
 *
 * Counts reset only on host restart. A healthy install should show all
 * zeros most of the time; non-zero counts identify which failure mode
 * is currently exercising the system. Cross-reference with the
 * resilience_2026-05-29.md memory for the diagnostic table.
 */

export interface ResilienceMetrics {
  /** iter 2 — docker-ps audit evicted a phantom activeContainers entry. */
  auditEvictions: number;
  /** iter 3 — spawnContainer didn't complete within SPAWN_TIMEOUT_MS. */
  spawnTimeouts: number;
  /** iter 10 — doSpawn waited on backoff before retrying. */
  crashBackoffsApplied: number;
  /** iter 1 — a single session sweep threw and was isolated. */
  perSessionFailures: number;
  /** iter 6 — a single session sweep exceeded PER_SESSION_TIMEOUT_MS. */
  perSessionTimeouts: number;
  /** iter 13 — total sweep tick took longer than SLOW_TICK_THRESHOLD_MS. */
  slowTicks: number;
  /** iter 14 — disk free at DATA_DIR fell below the warn threshold. */
  diskLowWarnings: number;
  /** iter 14 — disk free at DATA_DIR fell below the error threshold. */
  diskLowErrors: number;
  /** iter 9c807c7 / B2 — heartbeat-stale + ceiling kill fired. */
  ceilingKills: number;
  /** iter 5 — process.on('uncaughtException') swallowed a throw. */
  uncaughtExceptions: number;
  /** iter 5 — process.on('unhandledRejection') swallowed a rejection. */
  unhandledRejections: number;
  /**
   * Idle container evicted to free a cap slot for a queued wake. Non-zero
   * means persistent idle containers were saturating MAX_CONCURRENT_CONTAINERS
   * and a session with due work had to displace one (see
   * incident_spawn_queue_deadlock.md).
   */
  idleEvictions: number;
}

const metrics: ResilienceMetrics = {
  auditEvictions: 0,
  spawnTimeouts: 0,
  crashBackoffsApplied: 0,
  perSessionFailures: 0,
  perSessionTimeouts: 0,
  slowTicks: 0,
  diskLowWarnings: 0,
  diskLowErrors: 0,
  ceilingKills: 0,
  uncaughtExceptions: 0,
  unhandledRejections: 0,
  idleEvictions: 0,
};

export function bumpResilienceMetric(name: keyof ResilienceMetrics, by = 1): void {
  metrics[name] += by;
}

export function getResilienceMetrics(): Readonly<ResilienceMetrics> {
  return { ...metrics };
}

/** Test-only — wipe all counters back to zero. */
export function _resetResilienceMetrics(): void {
  for (const key of Object.keys(metrics) as (keyof ResilienceMetrics)[]) {
    metrics[key] = 0;
  }
}
