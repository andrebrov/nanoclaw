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
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, inboundDbPath, heartbeatPath, writeSessionMessage } from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export const MAX_CONSECUTIVE_FAILURES = 5;
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

// Keyed by agent group folder.
const consecutiveFailures = new Map<string, number>();
const circuitBreakerUntil = new Map<string, number>();

function isGroupInCooldown(folder: string): boolean {
  const until = circuitBreakerUntil.get(folder);
  if (!until) return false;
  if (Date.now() >= until) {
    circuitBreakerUntil.delete(folder);
    consecutiveFailures.delete(folder);
    return false;
  }
  return true;
}

function recordGroupFailure(folder: string, groupName: string): void {
  const count = (consecutiveFailures.get(folder) ?? 0) + 1;
  consecutiveFailures.set(folder, count);
  if (count >= MAX_CONSECUTIVE_FAILURES && !circuitBreakerUntil.has(folder)) {
    circuitBreakerUntil.set(folder, Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS);
    log.warn('Circuit breaker triggered — group entering cooldown', {
      folder,
      groupName,
      failures: count,
      cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
    });
    notifyMainGroup(folder, groupName);
  }
}

function resetGroupFailures(folder: string): void {
  consecutiveFailures.delete(folder);
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
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.status_changed);
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
    if (isGroupInCooldown(agentGroup.folder)) {
      log.debug('Group in circuit breaker cooldown — skipping', { folder: agentGroup.folder });
      return;
    }

    const alive = isContainerRunning(session.id);
    let hadFailure = false;

    // 3. Crashed-container cleanup: processing rows left behind get retried.
    if (!alive && outDb) {
      hadFailure = resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 4. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      const killed = enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
      if (killed) hadFailure = true;
    }

    if (hadFailure) {
      recordGroupFailure(agentGroup.folder, agentGroup.name);
    } else {
      resetGroupFailures(agentGroup.folder);
    }

    // 5. Wake a container if new work is due, nothing is running, and not in cooldown.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id) && !isGroupInCooldown(agentGroup.folder)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
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

/** Reset stuck processing rows. Returns true if any claims were found and handled. */
function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): boolean {
  const claims = getProcessingClaims(outDb);
  if (claims.length === 0) return false;

  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

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
  }
  return true;
}
