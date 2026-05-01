import path from 'path';

import { describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { SAFE_FILENAME_RE, normalizeForDedup } from './index.js';

// --- normalizeForDedup ---

describe('normalizeForDedup', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeForDedup('  hello  ')).toBe('hello');
    expect(normalizeForDedup('\nhello\n')).toBe('hello');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeForDedup('hello   world')).toBe('hello world');
    expect(normalizeForDedup('a\tb')).toBe('a b');
    expect(normalizeForDedup('a\n\nb')).toBe('a b');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeForDedup('   ')).toBe('');
    expect(normalizeForDedup('\n\t')).toBe('');
  });

  it('leaves already-normalized content unchanged', () => {
    expect(normalizeForDedup('hello world')).toBe('hello world');
  });

  it('lowercases content for case-insensitive dedup', () => {
    expect(normalizeForDedup('Hello World')).toBe('hello world');
    expect(normalizeForDedup('APPLE IS A FRUIT')).toBe('apple is a fruit');
    expect(normalizeForDedup('Mixed CASE  entry')).toBe('mixed case entry');
  });
});

// --- write_shared_memory filename validation ---

describe('SAFE_FILENAME_RE', () => {
  it('accepts valid filenames', () => {
    expect(SAFE_FILENAME_RE.test('skills-discovered.md')).toBe(true);
    expect(SAFE_FILENAME_RE.test('notes.txt')).toBe(true);
    expect(SAFE_FILENAME_RE.test('my_data-2024.json')).toBe(true);
    expect(SAFE_FILENAME_RE.test('a')).toBe(true);
  });

  it('rejects path traversal sequences', () => {
    expect(SAFE_FILENAME_RE.test('../etc/passwd')).toBe(false);
    expect(SAFE_FILENAME_RE.test('../../secrets')).toBe(false);
    expect(SAFE_FILENAME_RE.test('.hidden')).toBe(false);
  });

  it('rejects filenames with path separators', () => {
    expect(SAFE_FILENAME_RE.test('foo/bar')).toBe(false);
    expect(SAFE_FILENAME_RE.test('foo\\bar')).toBe(false);
  });

  it('rejects empty and whitespace filenames', () => {
    expect(SAFE_FILENAME_RE.test('')).toBe(false);
    expect(SAFE_FILENAME_RE.test(' notes')).toBe(false);
    expect(SAFE_FILENAME_RE.test('notes ')).toBe(false);
  });

  it('rejects filenames with special shell characters', () => {
    expect(SAFE_FILENAME_RE.test('file;rm')).toBe(false);
    expect(SAFE_FILENAME_RE.test('file|cat')).toBe(false);
    expect(SAFE_FILENAME_RE.test('file`id`')).toBe(false);
    expect(SAFE_FILENAME_RE.test('file$(cmd)')).toBe(false);
  });
});

// --- Memory isolation: per-agent dir must not be a descendant of globalDir ---

describe('memory isolation paths', () => {
  const globalDir = path.join(GROUPS_DIR, 'global');

  it('per-agent memory dir is not under globalDir', () => {
    const agentMemoryDir = path.join(DATA_DIR, 'agent-memory', 'ag-test-123');
    const rel = path.relative(globalDir, agentMemoryDir);
    // A path starting with '..' means it is outside globalDir
    expect(rel.startsWith('..')).toBe(true);
  });

  it('two agent memory dirs are siblings and neither is inside the other', () => {
    const agent1 = path.join(DATA_DIR, 'agent-memory', 'ag-aaa');
    const agent2 = path.join(DATA_DIR, 'agent-memory', 'ag-bbb');
    expect(path.relative(agent1, agent2).startsWith('..')).toBe(true);
    expect(path.relative(agent2, agent1).startsWith('..')).toBe(true);
  });

  it('per-agent memory path shares parent with DATA_DIR, not with globalDir', () => {
    const agentMemoryDir = path.join(DATA_DIR, 'agent-memory', 'ag-test-456');
    // Parent of parent is DATA_DIR
    expect(path.dirname(path.dirname(agentMemoryDir))).toBe(DATA_DIR);
    // Parent is NOT globalDir
    expect(path.dirname(agentMemoryDir)).not.toBe(globalDir);
  });
});
