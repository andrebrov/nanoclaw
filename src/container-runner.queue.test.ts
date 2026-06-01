/**
 * Unit tests for the concurrency-cap queue and main-DM bypass logic.
 * Tests the pure `evaluateConcurrencyAction` helper only — no Docker mocking needed.
 */
import { describe, expect, it } from 'vitest';

import { evaluateConcurrencyAction, selectEvictionVictim, type EvictionCandidate } from './container-runner.js';
import type { Session } from './types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-main',
    messaging_group_id: 'mg-1',
    thread_id: null,
    session_name: 'default',
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const isMain = (s: Session) => s.agent_group_id === 'ag-main';
const isNotMain = (_s: Session) => false;

describe('evaluateConcurrencyAction', () => {
  it('returns spawn when under cap', () => {
    const session = makeSession();
    expect(evaluateConcurrencyAction(2, 5, session, isMain)).toBe('spawn');
  });

  it('returns spawn when exactly at cap - 1', () => {
    const session = makeSession();
    expect(evaluateConcurrencyAction(4, 5, session, isMain)).toBe('spawn');
  });

  it('returns queue for non-main group at cap', () => {
    const session = makeSession({ agent_group_id: 'ag-other' });
    expect(evaluateConcurrencyAction(5, 5, session, isMain)).toBe('queue');
  });

  it('returns bypass for main DM default session at cap', () => {
    const session = makeSession({ session_name: 'default', agent_group_id: 'ag-main' });
    expect(evaluateConcurrencyAction(5, 5, session, isMain)).toBe('bypass');
  });

  it('returns queue for main group maintenance session at cap', () => {
    const session = makeSession({ session_name: 'maintenance', agent_group_id: 'ag-main' });
    expect(evaluateConcurrencyAction(5, 5, session, isMain)).toBe('queue');
  });

  it('returns queue when resolver is null (cold-start safe default)', () => {
    const session = makeSession({ session_name: 'default', agent_group_id: 'ag-main' });
    expect(evaluateConcurrencyAction(5, 5, session, null)).toBe('queue');
  });

  it('returns queue when resolver returns false', () => {
    const session = makeSession({ session_name: 'default', agent_group_id: 'ag-other' });
    expect(evaluateConcurrencyAction(5, 5, session, isNotMain)).toBe('queue');
  });

  it('returns bypass when over cap for main DM (cap+1 allowed)', () => {
    const session = makeSession({ session_name: 'default', agent_group_id: 'ag-main' });
    expect(evaluateConcurrencyAction(6, 5, session, isMain)).toBe('bypass');
  });
});

/**
 * Idle-eviction selection policy. Guards against the 2026-06-01 spawn-queue
 * deadlock where persistent idle containers saturated the cap and starved
 * sessions with due work (see incident_spawn_queue_deadlock.md).
 */
describe('selectEvictionVictim', () => {
  const NOW = 1_000_000;
  const MIN_AGE = 60_000;

  function makeCandidate(overrides: Partial<EvictionCandidate> = {}): EvictionCandidate {
    return {
      sessionId: 'sess-1',
      // Default: comfortably older than the min-age threshold.
      spawnedAtMs: NOW - MIN_AGE - 1,
      isQueued: false,
      isMainDm: false,
      isProcessing: false,
      ...overrides,
    };
  }

  it('returns null when there are no candidates', () => {
    expect(selectEvictionVictim([], NOW, MIN_AGE)).toBeNull();
  });

  it('picks the only eligible idle candidate', () => {
    const c = makeCandidate({ sessionId: 'idle-1' });
    expect(selectEvictionVictim([c], NOW, MIN_AGE)).toBe('idle-1');
  });

  it('picks the oldest (smallest spawnedAtMs) among eligible candidates', () => {
    const young = makeCandidate({ sessionId: 'young', spawnedAtMs: NOW - MIN_AGE - 100 });
    const old = makeCandidate({ sessionId: 'old', spawnedAtMs: NOW - MIN_AGE - 5_000 });
    const mid = makeCandidate({ sessionId: 'mid', spawnedAtMs: NOW - MIN_AGE - 1_000 });
    expect(selectEvictionVictim([young, old, mid], NOW, MIN_AGE)).toBe('old');
  });

  it('excludes containers younger than minAgeMs', () => {
    const fresh = makeCandidate({ sessionId: 'fresh', spawnedAtMs: NOW - MIN_AGE + 1 });
    expect(selectEvictionVictim([fresh], NOW, MIN_AGE)).toBeNull();
  });

  it('treats a container exactly at minAgeMs as eligible (boundary)', () => {
    const atAge = makeCandidate({ sessionId: 'at-age', spawnedAtMs: NOW - MIN_AGE });
    expect(selectEvictionVictim([atAge], NOW, MIN_AGE)).toBe('at-age');
  });

  it('excludes queued sessions', () => {
    const queued = makeCandidate({ sessionId: 'queued', isQueued: true });
    expect(selectEvictionVictim([queued], NOW, MIN_AGE)).toBeNull();
  });

  it('excludes the main-DM session', () => {
    const main = makeCandidate({ sessionId: 'main', isMainDm: true });
    expect(selectEvictionVictim([main], NOW, MIN_AGE)).toBeNull();
  });

  it('excludes containers with an active processing claim', () => {
    const busy = makeCandidate({ sessionId: 'busy', isProcessing: true });
    expect(selectEvictionVictim([busy], NOW, MIN_AGE)).toBeNull();
  });

  it('skips the oldest when it is excluded and picks the next-oldest eligible', () => {
    const oldestBusy = makeCandidate({
      sessionId: 'oldest-busy',
      spawnedAtMs: NOW - MIN_AGE - 9_000,
      isProcessing: true,
    });
    const nextIdle = makeCandidate({ sessionId: 'next-idle', spawnedAtMs: NOW - MIN_AGE - 4_000 });
    const youngestIdle = makeCandidate({
      sessionId: 'youngest-idle',
      spawnedAtMs: NOW - MIN_AGE - 1_000,
    });
    expect(selectEvictionVictim([oldestBusy, nextIdle, youngestIdle], NOW, MIN_AGE)).toBe('next-idle');
  });

  it('returns null when every candidate is excluded (legitimate backpressure)', () => {
    const candidates = [
      makeCandidate({ sessionId: 'a', isProcessing: true }),
      makeCandidate({ sessionId: 'b', isMainDm: true }),
      makeCandidate({ sessionId: 'c', isQueued: true }),
      makeCandidate({ sessionId: 'd', spawnedAtMs: NOW - MIN_AGE + 1 }),
    ];
    expect(selectEvictionVictim(candidates, NOW, MIN_AGE)).toBeNull();
  });
});
