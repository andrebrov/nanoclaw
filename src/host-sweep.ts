/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { findSessionByAgentGroup } from './db/sessions.js';
import { getAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  heartbeatPath,
  writeSessionMessage,
} from './session-manager.js';
import { getContainerSpawnedAtMs, isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// Startup grace for a container that hasn't yet produced a heartbeat file.
// Past this window, "no heartbeat" is treated as stale rather than fresh —
// catches phantom sessions where the host added an activeContainers entry
// but the actual docker process never started (no close event fires, no
// heartbeat ever written). 5 min is generous for normal startup
// (image pull, MCP servers, SDK resume) but short enough to recover quickly
// from a poisoned activeContainers map.
export const MISSING_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export const MAX_CONSECUTIVE_FAILURES = 5;
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

// Keyed by "folder:session_name" so maintenance and default session slots
// track failures independently — a crashing maintenance container does not
// trip the circuit breaker for the user-facing default session.
const consecutiveFailures = new Map<string, number>();
const circuitBreakerUntil = new Map<string, number>();

function sessionKey(folder: string, sessionName: string): string {
  return `${folder}:${sessionName}`;
}

function isGroupInCooldown(folder: string, sessionName: string): boolean {
  const key = sessionKey(folder, sessionName);
  const until = circuitBreakerUntil.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    circuitBreakerUntil.delete(key);
    consecutiveFailures.delete(key);
    return false;
  }
  return true;
}

function recordGroupFailure(folder: string, sessionName: string, groupName: string): void {
  const key = sessionKey(folder, sessionName);
  const count = (consecutiveFailures.get(key) ?? 0) + 1;
  consecutiveFailures.set(key, count);
  if (count >= MAX_CONSECUTIVE_FAILURES && !circuitBreakerUntil.has(key)) {
    circuitBreakerUntil.set(key, Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS);
    log.warn('Circuit breaker triggered — session slot entering cooldown', {
      folder,
      sessionName,
      groupName,
      failures: count,
      cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
    });
    notifyMainGroup(folder, groupName);
  }
}

function resetGroupFailures(folder: string, sessionName: string): void {
  consecutiveFailures.delete(sessionKey(folder, sessionName));
}

function notifyMainGroup(failingFolder: string, failingGroupName: string): void {
  if (failingFolder === 'main') return;
  const mainGroup = getAgentGroupByFolder('main');
  if (!mainGroup) return;
  const session = findSessionByAgentGroup(mainGroup.id);
  if (!session) return;
  writeSessionMessage(mainGroup.id, session.id, {
    id: `cb-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text: `Circuit breaker triggered for group "${failingGroupName}": ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Cooling down for ${CIRCUIT_BREAKER_COOLDOWN_MS / 60_000} minutes.`,
    }),
    trigger: 1,
  });
  void wakeContainer(session).catch((err) => {
    log.warn('Failed to wake main group for circuit breaker notification', { failingFolder, err });
  });
}

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  spawnedAtMs?: number | null; // null/undefined when host can't tell (legacy / non-tracked sessions)
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const spawnedAtMs = args.spawnedAtMs ?? null;
  const declaredBashMs = bashTimeoutMs(containerState);
  const declaredMaxMs = containerState?.declared_max_ms ?? null;
  const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0, declaredMaxMs ?? 0);

  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  } else if (spawnedAtMs !== null) {
    // No heartbeat file. A fresh container hasn't had time to write one yet,
    // so grant MISSING_HEARTBEAT_GRACE_MS from spawn. Past that, treat as
    // stale: this catches phantom sessions (host believes container is
    // running but no docker process exists, so .heartbeat never appears).
    // Without this branch, a poisoned activeContainers entry stays invisible
    // to the sweep forever. The 41-hour DM stall on 2026-05-25 lived
    // exactly here.
    const sinceSpawn = now - spawnedAtMs;
    if (sinceSpawn > MISSING_HEARTBEAT_GRACE_MS) {
      return { action: 'kill-ceiling', heartbeatAgeMs: sinceSpawn, ceilingMs: MISSING_HEARTBEAT_GRACE_MS };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status (always, even in cooldown).
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Skip kill/reset/wake while circuit breaker cooldown is active.
    if (isGroupInCooldown(agentGroup.folder, session.session_name)) {
      log.debug('Session slot in circuit breaker cooldown — skipping', {
        folder: agentGroup.folder,
        sessionName: session.session_name,
      });
      return;
    }

    let hadFailure = false;

    // 3. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 4. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      const killed = enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
      if (killed) hadFailure = true;
    }

    // 5. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 3 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry, and only returns
    // true when actual work was done so the circuit breaker doesn't trip on
    // stale processing_ack rows alone.
    if (!alive && outDb) {
      const didWork = resetStuckProcessingRows(inDb, outDb, session, 'container not running');
      if (didWork) hadFailure = true;
    }

    if (hadFailure) {
      recordGroupFailure(agentGroup.folder, session.session_name, agentGroup.name);
    } else {
      resetGroupFailures(agentGroup.folder, session.session_name);
    }

    // 6. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): boolean {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
    spawnedAtMs: getContainerSpawnedAtMs(session.id),
  });

  if (decision.action === 'ok') return false;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return true;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
  return true;
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

/**
 * Reset stuck processing rows. Returns true only when actual work was done
 * (a message was reset for retry or marked failed) — NOT just because stale
 * processing_ack rows happen to exist in outbound.db.
 *
 * Why: the host cannot write to outbound.db (single-writer rule), so a
 * dead container's 'processing' processing_ack rows persist until the next
 * container starts and runs clearStaleProcessingAcks. After all matching
 * messages_in rows have been marked 'failed', getMessageForRetry returns
 * null for every claim — but the claim rows are still there. Returning
 * `true` in that case meant every subsequent sweep tick reported a
 * "failure" and tripped the circuit breaker for nothing.
 */
function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): boolean {
  const claims = getProcessingClaims(outDb);
  if (claims.length === 0) return false;

  let didWork = false;
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
    didWork = true;
  }
  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }

  return didWork;
}
