import path from 'path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SESSION_NAME, KNOWN_SESSION_NAMES, MAINTENANCE_SESSION_NAME, resolveIpcResultPath } from './ipc.js';

const OUTPUT_DIR = '/data/ipc/my-group';

describe('resolveIpcResultPath', () => {
  it('returns valid path for well-formed requestId and known session', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, DEFAULT_SESSION_NAME, 'abc123');
    expect(p).toBe(path.join(OUTPUT_DIR, DEFAULT_SESSION_NAME, 'abc123.json'));
  });

  it('accepts hyphens and underscores in requestId', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, DEFAULT_SESSION_NAME, 'req-abc_XYZ');
    expect(p).toBe(path.join(OUTPUT_DIR, DEFAULT_SESSION_NAME, 'req-abc_XYZ.json'));
  });

  it('routes requestId with ../ to fixed fallback', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, DEFAULT_SESSION_NAME, '../../etc/passwd');
    expect(p).toBe(path.join(OUTPUT_DIR, '_script_result_invalid.json'));
  });

  it('routes requestId with special chars to fixed fallback', () => {
    for (const bad of ['foo bar', 'a/b', 'x.y', 'a;b', 'a$b']) {
      const p = resolveIpcResultPath(OUTPUT_DIR, DEFAULT_SESSION_NAME, bad);
      expect(p).toBe(path.join(OUTPUT_DIR, '_script_result_invalid.json'));
    }
  });

  it('routes empty requestId to fixed fallback', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, DEFAULT_SESSION_NAME, '');
    expect(p).toBe(path.join(OUTPUT_DIR, '_script_result_invalid.json'));
  });

  it('uses maintenance session when requested', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, MAINTENANCE_SESSION_NAME, 'task1');
    expect(p).toBe(path.join(OUTPUT_DIR, MAINTENANCE_SESSION_NAME, 'task1.json'));
  });

  it('falls back to default session for unknown session name', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, 'unknown-session', 'task1');
    expect(p).toBe(path.join(OUTPUT_DIR, DEFAULT_SESSION_NAME, 'task1.json'));
  });

  it('falls back to default session for session with path traversal', () => {
    const p = resolveIpcResultPath(OUTPUT_DIR, '../../other', 'task1');
    expect(p).toBe(path.join(OUTPUT_DIR, DEFAULT_SESSION_NAME, 'task1.json'));
  });
});

describe('KNOWN_SESSION_NAMES', () => {
  it('contains default and maintenance', () => {
    expect(KNOWN_SESSION_NAMES.has(DEFAULT_SESSION_NAME)).toBe(true);
    expect(KNOWN_SESSION_NAMES.has(MAINTENANCE_SESSION_NAME)).toBe(true);
  });
});
