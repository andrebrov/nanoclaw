/**
 * Unit tests for the concurrency-cap queue and main-DM bypass logic.
 * Tests the pure `evaluateConcurrencyAction` helper only — no Docker mocking needed.
 */
import { describe, expect, it } from 'vitest';

import { evaluateConcurrencyAction } from './container-runner.js';
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
