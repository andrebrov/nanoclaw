import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import { buildToolAllowlist, isThinkingOnlyEndTurn, resolveSystemPrompt } from './claude.js';
import { repairDanglingToolCalls } from '../hooks/dangling-tool-call-recovery.js';

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

// ── resolveSystemPrompt ──

describe('resolveSystemPrompt', () => {
  const PRESET = { type: 'preset', preset: 'claude_code' } as const;

  it('returns undefined when both inputs are absent', () => {
    expect(resolveSystemPrompt(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when both inputs are empty strings', () => {
    expect(resolveSystemPrompt('', '')).toBeUndefined();
  });

  it('returns undefined when base is empty and append is absent', () => {
    expect(resolveSystemPrompt('', undefined)).toBeUndefined();
  });

  it('wraps base instructions alone in the preset form', () => {
    const result = resolveSystemPrompt('be concise', undefined);
    expect(result).toEqual({ ...PRESET, append: 'be concise' });
  });

  it('wraps append-only in the preset form when base is absent', () => {
    const result = resolveSystemPrompt(undefined, 'extra context');
    expect(result).toEqual({ ...PRESET, append: 'extra context' });
  });

  it('joins base and append with double newline', () => {
    const result = resolveSystemPrompt('base', 'extra');
    expect(result).toEqual({ ...PRESET, append: 'base\n\nextra' });
  });

  it('skips empty base when append is present', () => {
    const result = resolveSystemPrompt('', 'extra');
    expect(result).toEqual({ ...PRESET, append: 'extra' });
  });

  it('skips empty append when base is present', () => {
    const result = resolveSystemPrompt('base', '');
    expect(result).toEqual({ ...PRESET, append: 'base' });
  });

  it('append field is always a plain string — no cache_control markup', () => {
    // cache_control is handled by the SDK/Claude Code layer, not by the caller.
    const result = resolveSystemPrompt('instructions', 'override');
    expect(typeof result?.append).toBe('string');
    expect(result).not.toHaveProperty('cache_control');
  });
});

// ── repairDanglingToolCalls ──

function writeTranscript(entries: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

describe('repairDanglingToolCalls', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const f of temps.splice(0)) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function make(entries: object[]): string {
    const f = writeTranscript(entries);
    temps.push(f);
    return f;
  }

  it('no-op when file does not exist', () => {
    expect(() => repairDanglingToolCalls('/nonexistent/path/session.jsonl')).not.toThrow();
  });

  it('no-op when transcript has no tool_use blocks', () => {
    const file = make([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
  });

  it('no-op when every tool_use has a matching tool_result', () => {
    const file = make([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'abc', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'ok' }] },
      },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
  });

  it('injects a placeholder for a single dangling tool_use', () => {
    const file = make([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'xyz', name: 'Read', input: {} }] },
      },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    const injected = JSON.parse(lines[1]);
    expect(injected.type).toBe('user');
    const blocks = injected.message.content as Array<{ type: string; tool_use_id: string; is_error: boolean }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('xyz');
    expect(blocks[0].is_error).toBe(true);
  });

  it('groups multiple dangling ids into a single injected user message', () => {
    const file = make([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'id1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'id2', name: 'Read', input: {} },
          ],
        },
      },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    const injected = JSON.parse(lines[1]);
    const ids = (injected.message.content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id);
    expect(ids).toContain('id1');
    expect(ids).toContain('id2');
  });

  it('only injects for truly dangling ids, leaving resolved ones alone', () => {
    const file = make([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'done', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'done', content: 'ok' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'dangling', name: 'Read', input: {} }] },
      },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(4);
    const injected = JSON.parse(lines[3]);
    const ids = (injected.message.content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id);
    expect(ids).toContain('dangling');
    expect(ids).not.toContain('done');
  });

  it('is idempotent — a second call does not inject again', () => {
    const file = make([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'once', name: 'Bash', input: {} }] },
      },
    ]);
    repairDanglingToolCalls(file);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
  });
});
