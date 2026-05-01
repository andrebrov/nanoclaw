import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import { repairDanglingToolCalls } from './dangling-tool-call-recovery.js';

function writeTranscript(entries: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dangling-test-'));
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

  it('placeholder content signals interruption, not an empty result', () => {
    const file = make([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'xyz', name: 'Bash', input: {} }] },
      },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    const injected = JSON.parse(lines[1]);
    const block = (injected.message.content as Array<{ content: string }>)[0];
    expect(block.content).toContain('interrupted');
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

  it('interrupted session resumes cleanly — mixed resolved and dangling calls', () => {
    // Simulates: turn 1 completes normally, turn 2 is interrupted mid-loop
    const file = make([
      // Turn 1: completed tool call
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'turn1-call', name: 'Read', input: {} }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'turn1-call', content: 'file contents' }],
        },
      },
      // Turn 2: interrupted before result arrived
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'turn2-call-a', name: 'Bash', input: { command: 'echo hello' } },
            { type: 'tool_use', id: 'turn2-call-b', name: 'Write', input: { file_path: '/tmp/x' } },
          ],
        },
      },
    ]);
    repairDanglingToolCalls(file);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    // Original 3 lines + 1 injected
    expect(lines).toHaveLength(4);
    const injected = JSON.parse(lines[3]);
    const blocks = injected.message.content as Array<{ type: string; tool_use_id: string; is_error: boolean }>;
    expect(blocks).toHaveLength(2);
    const injectedIds = blocks.map((b) => b.tool_use_id);
    expect(injectedIds).toContain('turn2-call-a');
    expect(injectedIds).toContain('turn2-call-b');
    expect(injectedIds).not.toContain('turn1-call');
    // All placeholders are marked as errors (not empty results)
    for (const block of blocks) {
      expect(block.is_error).toBe(true);
    }
  });
});
