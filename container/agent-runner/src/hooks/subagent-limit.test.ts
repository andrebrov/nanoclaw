import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { SubagentLimitTracker, parseSubagentLimit, SUBAGENT_TOOL, SUBAGENT_TOOLS, isSubagentTool } from './subagent-limit.js';

describe('SUBAGENT_TOOL', () => {
  it('is "Task"', () => {
    expect(SUBAGENT_TOOL).toBe('Task');
  });
});

describe('SUBAGENT_TOOLS / isSubagentTool', () => {
  it('recognises Task', () => {
    expect(isSubagentTool('Task')).toBe(true);
    expect(SUBAGENT_TOOLS.has('Task')).toBe(true);
  });

  it('recognises Agent (new SDK name)', () => {
    expect(isSubagentTool('Agent')).toBe(true);
    expect(SUBAGENT_TOOLS.has('Agent')).toBe(true);
  });

  it('rejects unrelated tool names', () => {
    expect(isSubagentTool('Bash')).toBe(false);
    expect(isSubagentTool('Read')).toBe(false);
    expect(isSubagentTool('')).toBe(false);
  });
});

describe('SubagentLimitTracker', () => {
  it('allows calls up to the limit', () => {
    const tracker = new SubagentLimitTracker(3);
    expect(tracker.intercept()).toBeUndefined();
    expect(tracker.intercept()).toBeUndefined();
    expect(tracker.intercept()).toBeUndefined();
  });

  it('blocks calls beyond the limit', () => {
    const tracker = new SubagentLimitTracker(2);
    tracker.intercept();
    tracker.intercept();
    const reason = tracker.intercept();
    expect(reason).toBeDefined();
    expect(reason).toContain('SubagentLimit');
    expect(reason).toContain('2');
  });

  it('includes requested count in the block reason', () => {
    const tracker = new SubagentLimitTracker(1);
    tracker.intercept();
    const reason = tracker.intercept();
    expect(reason).toContain('requested 2');
  });

  it('resets counter across turns', () => {
    const tracker = new SubagentLimitTracker(1);
    tracker.intercept(); // allowed
    expect(tracker.intercept()).toBeDefined(); // blocked
    tracker.reset();
    expect(tracker.intercept()).toBeUndefined(); // allowed again
  });

  it('limit of 1 allows exactly one call per turn', () => {
    const tracker = new SubagentLimitTracker(1);
    expect(tracker.intercept()).toBeUndefined();
    expect(tracker.intercept()).toBeDefined();
    tracker.reset();
    expect(tracker.intercept()).toBeUndefined();
  });
});

describe('parseSubagentLimit', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.AGENT_SUBAGENT_LIMIT;
    delete process.env.AGENT_SUBAGENT_LIMIT;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.AGENT_SUBAGENT_LIMIT = savedEnv;
    } else {
      delete process.env.AGENT_SUBAGENT_LIMIT;
    }
  });

  it('returns undefined when env var is absent', () => {
    expect(parseSubagentLimit()).toBeUndefined();
  });

  it('returns the parsed number when env var is set', () => {
    process.env.AGENT_SUBAGENT_LIMIT = '3';
    expect(parseSubagentLimit()).toBe(3);
  });

  it('trims whitespace before parsing', () => {
    process.env.AGENT_SUBAGENT_LIMIT = '  5  ';
    expect(parseSubagentLimit()).toBe(5);
  });

  it('returns undefined for zero', () => {
    process.env.AGENT_SUBAGENT_LIMIT = '0';
    expect(parseSubagentLimit()).toBeUndefined();
  });

  it('returns undefined for negative values', () => {
    process.env.AGENT_SUBAGENT_LIMIT = '-1';
    expect(parseSubagentLimit()).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    process.env.AGENT_SUBAGENT_LIMIT = 'abc';
    expect(parseSubagentLimit()).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    process.env.AGENT_SUBAGENT_LIMIT = '';
    expect(parseSubagentLimit()).toBeUndefined();
  });
});
