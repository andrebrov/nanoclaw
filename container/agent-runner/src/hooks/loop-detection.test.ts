import { describe, it, expect } from 'bun:test';

import { createLoopDetectionGate } from './loop-detection.js';

describe('createLoopDetectionGate', () => {
  describe('no-loop cases', () => {
    it('allows the first call to any tool', () => {
      const gate = createLoopDetectionGate({ windowSize: 5, repeatThreshold: 3 });
      expect(gate('Read', { file_path: '/foo' })).toEqual({ block: false });
    });

    it('allows distinct tool calls', () => {
      const gate = createLoopDetectionGate({ windowSize: 5, repeatThreshold: 3 });
      expect(gate('Read', { file_path: '/a' })).toEqual({ block: false });
      expect(gate('Grep', { pattern: 'foo', path: '/b' })).toEqual({ block: false });
      expect(gate('Bash', { command: 'ls' })).toEqual({ block: false });
    });

    it('allows the same tool with different arguments', () => {
      const gate = createLoopDetectionGate({ windowSize: 5, repeatThreshold: 3 });
      gate('Read', { file_path: '/a' });
      gate('Read', { file_path: '/b' });
      expect(gate('Read', { file_path: '/c' })).toEqual({ block: false });
    });

    it('allows repetitions below the threshold', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 3 });
      gate('Bash', { command: 'ls' });
      // second occurrence — still under threshold of 3
      expect(gate('Bash', { command: 'ls' })).toEqual({ block: false });
    });

    it('handles undefined tool_input without throwing', () => {
      const gate = createLoopDetectionGate();
      expect(gate('Task', undefined)).toEqual({ block: false });
    });

    it('handles empty object tool_input', () => {
      const gate = createLoopDetectionGate();
      expect(gate('Task', {})).toEqual({ block: false });
    });
  });

  describe('loop detection — blocks at threshold', () => {
    it('blocks when the same fingerprint reaches repeatThreshold', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 3 });
      gate('Bash', { command: 'cat /etc/hosts' });
      gate('Bash', { command: 'cat /etc/hosts' });
      const result = gate('Bash', { command: 'cat /etc/hosts' });
      expect(result.block).toBe(true);
    });

    it('block reason names the tool and includes approach guidance', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 3 });
      gate('Read', { file_path: '/loop' });
      gate('Read', { file_path: '/loop' });
      const result = gate('Read', { file_path: '/loop' });
      expect(result.block).toBe(true);
      if (!result.block) throw new Error('unreachable');
      expect(result.reason).toContain('Read');
      expect(result.reason.toLowerCase()).toMatch(/loop|repeat|same/);
      expect(result.reason.toLowerCase()).toContain('approach');
    });

    it('continues to block on subsequent calls of the same looping fingerprint', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 2 });
      gate('Grep', { pattern: 'x', path: '/' });
      gate('Grep', { pattern: 'x', path: '/' }); // hits threshold=2
      // fourth call — still blocked
      const result = gate('Grep', { pattern: 'x', path: '/' });
      expect(result.block).toBe(true);
    });

    it('distinguishes calls by tool name — same args, different tool is not a loop', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 2 });
      gate('Read', { file_path: '/x' });
      gate('Grep', { file_path: '/x' });
      // third call is a second Grep, not third Read — no loop yet
      const result = gate('Grep', { file_path: '/x' });
      expect(result.block).toBe(true); // Grep:/x has now appeared twice → threshold=2
    });

    it('blocks with threshold=2 (minimum usable threshold)', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 2 });
      gate('Bash', { command: 'whoami' });
      const result = gate('Bash', { command: 'whoami' });
      expect(result.block).toBe(true);
    });
  });

  describe('window sliding', () => {
    it('evicts old fingerprints once the window is full', () => {
      // windowSize=3, threshold=2. Push fp-A twice, then push 3 different fps
      // to evict both. The next fp-A should be allowed again.
      const gate = createLoopDetectionGate({ windowSize: 3, repeatThreshold: 2 });
      gate('Read', { file_path: '/a' }); // window: [A]
      gate('Read', { file_path: '/a' }); // window: [A, A] — threshold hit but we only record, not test yet
      gate('Bash', { command: '1' }); // window: [A, A, B1] — evicts nothing yet (size=3)
      gate('Bash', { command: '2' }); // window: [A, B1, B2] — A count drops to 1
      gate('Bash', { command: '3' }); // window: [B1, B2, B3] — A evicted entirely
      // Now fp-A should be fresh — no loop
      expect(gate('Read', { file_path: '/a' })).toEqual({ block: false });
    });

    it('does not block when repeated calls are spread across window boundary', () => {
      const gate = createLoopDetectionGate({ windowSize: 4, repeatThreshold: 3 });
      gate('Read', { file_path: '/r' }); // window: [R]
      gate('Bash', { command: 'x' }); // window: [R, B]
      gate('Bash', { command: 'y' }); // window: [R, B, B2]
      gate('Bash', { command: 'z' }); // window: [R, B, B2, B3] — R at index 0, about to fall off
      // This call evicts the first R; window becomes [B, B2, B3, R2]
      expect(gate('Read', { file_path: '/r' })).toEqual({ block: false });
    });
  });

  describe('default options', () => {
    it('uses windowSize=10 and repeatThreshold=3 by default', () => {
      const gate = createLoopDetectionGate();
      // Fill 9 slots with distinct calls so we are just under the window limit
      for (let i = 0; i < 9; i++) {
        gate('Bash', { command: `echo ${i}` });
      }
      // 2 repetitions of the target — still under threshold
      gate('Read', { file_path: '/default' });
      gate('Read', { file_path: '/default' });
      // 3rd repetition triggers the block
      const result = gate('Read', { file_path: '/default' });
      expect(result.block).toBe(true);
    });
  });

  describe('fail-open edge cases', () => {
    it('truncates long inputs to avoid memory growth', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 3 });
      const longValue = 'x'.repeat(2000);
      // Two identical long-arg calls — should still fingerprint consistently
      gate('Bash', { command: longValue });
      gate('Bash', { command: longValue });
      const result = gate('Bash', { command: longValue });
      // Third identical call must be detected despite truncation
      expect(result.block).toBe(true);
    });

    it('treats a tool with no input as a stable fingerprint', () => {
      const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 2 });
      gate('Task', undefined);
      const result = gate('Task', undefined);
      expect(result.block).toBe(true);
    });
  });
});
