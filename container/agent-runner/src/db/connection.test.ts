/**
 * Unit tests for reclaimStaleProcessingAcks — the live-container self-heal of
 * orphaned 'processing' claims (see incident-orphaned-processing-claim-masking
 * and specs/stale-processing-claim-self-heal.spec.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  initTestSessionDb,
  closeSessionDb,
  getOutboundDb,
  reclaimStaleProcessingAcks,
} from './connection.js';

const STALE_MS = 30 * 60_000;

/** Insert a processing_ack row with status_changed at now + offsetSeconds. */
function insertAck(messageId: string, status: string, offsetSeconds: number): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now', ?))",
    )
    .run(messageId, status, `${offsetSeconds} seconds`);
}

function ackStatus(messageId: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
    .get(messageId) as { status: string } | undefined;
  return row?.status;
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('reclaimStaleProcessingAcks', () => {
  it('returns [] and writes nothing when there are no claims', () => {
    expect(reclaimStaleProcessingAcks(STALE_MS)).toEqual([]);
  });

  it('drops a processing claim older than staleMs and returns its id', () => {
    insertAck('task-old', 'processing', -40 * 60); // 40 min ago
    const reclaimed = reclaimStaleProcessingAcks(STALE_MS);
    expect(reclaimed).toEqual(['task-old']);
    expect(ackStatus('task-old')).toBeUndefined(); // row deleted → re-fetchable
  });

  it('leaves a processing claim younger than staleMs (in-flight turn protection)', () => {
    insertAck('task-fresh', 'processing', -5 * 60); // 5 min ago
    const reclaimed = reclaimStaleProcessingAcks(STALE_MS);
    expect(reclaimed).toEqual([]);
    expect(ackStatus('task-fresh')).toBe('processing');
  });

  it('never touches completed rows, even when old', () => {
    insertAck('task-done', 'completed', -90 * 60); // 90 min ago, completed
    const reclaimed = reclaimStaleProcessingAcks(STALE_MS);
    expect(reclaimed).toEqual([]);
    expect(ackStatus('task-done')).toBe('completed');
  });

  it('reclaims only the stale processing rows from a mixed set', () => {
    insertAck('stale-1', 'processing', -45 * 60);
    insertAck('stale-2', 'processing', -31 * 60);
    insertAck('fresh', 'processing', -2 * 60);
    insertAck('done-old', 'completed', -60 * 60);

    const reclaimed = reclaimStaleProcessingAcks(STALE_MS).sort();
    expect(reclaimed).toEqual(['stale-1', 'stale-2']);
    expect(ackStatus('stale-1')).toBeUndefined();
    expect(ackStatus('stale-2')).toBeUndefined();
    expect(ackStatus('fresh')).toBe('processing');
    expect(ackStatus('done-old')).toBe('completed');
  });

  it('treats a claim exactly at the staleMs boundary as stale', () => {
    insertAck('task-boundary', 'processing', -30 * 60); // exactly 30 min
    // status_changed <= datetime('now','-1800 seconds') is true at the boundary.
    expect(reclaimStaleProcessingAcks(STALE_MS)).toEqual(['task-boundary']);
  });
});
