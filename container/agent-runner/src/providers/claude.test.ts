import { describe, it, expect } from 'bun:test';

import { buildToolAllowlist, isThinkingOnlyEndTurn } from './claude.js';

describe('isThinkingOnlyEndTurn', () => {
  const base = { type: 'result', subtype: 'success', stop_reason: 'end_turn', result: '' };

  it('returns true for a canonical thinking-only end_turn', () => {
    expect(isThinkingOnlyEndTurn(base)).toBe(true);
  });

  it('returns true when result is whitespace-only', () => {
    expect(isThinkingOnlyEndTurn({ ...base, result: '   \n  ' })).toBe(true);
  });

  it('returns false when result has text', () => {
    expect(isThinkingOnlyEndTurn({ ...base, result: 'hello' })).toBe(false);
  });

  it('returns false when stop_reason is not end_turn', () => {
    expect(isThinkingOnlyEndTurn({ ...base, stop_reason: 'max_tokens' })).toBe(false);
  });

  it('returns false when subtype is not success', () => {
    expect(isThinkingOnlyEndTurn({ ...base, subtype: 'error' })).toBe(false);
  });

  it('returns false when type is not result', () => {
    expect(isThinkingOnlyEndTurn({ ...base, type: 'assistant' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isThinkingOnlyEndTurn(null)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isThinkingOnlyEndTurn('result')).toBe(false);
  });

  it('returns false when result field is missing', () => {
    const { result: _r, ...noResult } = base;
    expect(isThinkingOnlyEndTurn(noResult)).toBe(false);
  });
});

const SDK_DISALLOWED = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

describe('buildToolAllowlist', () => {
  it('empty caps → BASE_TOOLS only (no Bash, Write, WebSearch)', () => {
    const tools = buildToolAllowlist([]);
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('mcp__nanoclaw__*');
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('NotebookEdit');
    expect(tools).not.toContain('WebSearch');
    expect(tools).not.toContain('WebFetch');
  });

  it('shell_exec unlocks Bash', () => {
    const tools = buildToolAllowlist(['shell_exec']);
    expect(tools).toContain('Bash');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('WebSearch');
  });

  it('file_write unlocks Write, Edit, NotebookEdit', () => {
    const tools = buildToolAllowlist(['file_write']);
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('NotebookEdit');
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('WebSearch');
  });

  it('network unlocks WebSearch and WebFetch', () => {
    const tools = buildToolAllowlist(['network']);
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('Write');
  });

  it('all three caps unlock all tool groups', () => {
    const tools = buildToolAllowlist(['shell_exec', 'file_write', 'network']);
    expect(tools).toContain('Bash');
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('NotebookEdit');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
  });

  it('unknown cap is a no-op (does not unlock anything extra)', () => {
    const tools = buildToolAllowlist(['shellexec', 'filewrite', 'typo']);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('WebSearch');
  });

  it('SDK_DISALLOWED_TOOLS are never in the allowlist', () => {
    const tools = buildToolAllowlist(['shell_exec', 'file_write', 'network']);
    for (const disallowed of SDK_DISALLOWED) {
      expect(tools).not.toContain(disallowed);
    }
  });
});
