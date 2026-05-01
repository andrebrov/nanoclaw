import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-container-config/groups';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-container-config/groups' };
});

import { readContainerConfig, initContainerConfig, backfillAllowedCapabilities } from './container-config.js';
import { log } from './log.js';

beforeEach(() => {
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync('/tmp/nanoclaw-test-container-config', { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeGroupConfig(folder: string, content: unknown): void {
  const dir = path.join(TEST_GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(content, null, 2) + '\n');
}

describe('readContainerConfig — allowedCapabilities', () => {
  it('absent field → permissive default (all caps)', () => {
    writeGroupConfig('g1', { mcpServers: {} });
    const cfg = readContainerConfig('g1');
    expect(cfg.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);
  });

  it('empty array → restricted (intentional operator choice)', () => {
    writeGroupConfig('g1', { allowedCapabilities: [] });
    const cfg = readContainerConfig('g1');
    expect(cfg.allowedCapabilities).toEqual([]);
  });

  it('explicit full set → all caps returned', () => {
    writeGroupConfig('g1', { allowedCapabilities: ['shell_exec', 'file_write', 'network'] });
    const cfg = readContainerConfig('g1');
    expect(cfg.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);
  });

  it('unknown cap is a no-op (dropped with a warning)', () => {
    writeGroupConfig('g1', { allowedCapabilities: ['shell_exec', 'shellexec', 'typo'] });
    const cfg = readContainerConfig('g1');
    expect(cfg.allowedCapabilities).toEqual(['shell_exec']);
    expect(log.warn).toHaveBeenCalled();
  });

  it('non-array value → loud warning + permissive default', () => {
    writeGroupConfig('g1', { allowedCapabilities: 'shell_exec' });
    const cfg = readContainerConfig('g1');
    expect(cfg.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);
    expect(log.warn).toHaveBeenCalled();
  });

  it('missing file → permissive default', () => {
    const cfg = readContainerConfig('does-not-exist');
    expect(cfg.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);
  });
});

describe('readContainerConfig — model', () => {
  it('absent field → undefined', () => {
    writeGroupConfig('g1', { mcpServers: {} });
    const cfg = readContainerConfig('g1');
    expect(cfg.model).toBeUndefined();
  });

  it('model string → returned as-is', () => {
    writeGroupConfig('g1', { model: 'claude-haiku-4-5' });
    const cfg = readContainerConfig('g1');
    expect(cfg.model).toBe('claude-haiku-4-5');
  });

  it('whitespace-only model → undefined', () => {
    writeGroupConfig('g1', { model: '   ' });
    const cfg = readContainerConfig('g1');
    expect(cfg.model).toBeUndefined();
  });

  it('model with surrounding whitespace → trimmed', () => {
    writeGroupConfig('g1', { model: '  claude-sonnet-4-6  ' });
    const cfg = readContainerConfig('g1');
    expect(cfg.model).toBe('claude-sonnet-4-6');
  });
});

describe('initContainerConfig', () => {
  it('new group gets permissive default', () => {
    initContainerConfig('g2');
    const cfg = readContainerConfig('g2');
    expect(cfg.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);
  });
});

describe('readContainerConfig — subagentLimit', () => {
  it('absent field → undefined', () => {
    writeGroupConfig('g1', { mcpServers: {} });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBeUndefined();
  });

  it('positive integer → returned as-is', () => {
    writeGroupConfig('g1', { subagentLimit: 3 });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBe(3);
  });

  it('zero → undefined (treated as unlimited)', () => {
    writeGroupConfig('g1', { subagentLimit: 0 });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBeUndefined();
  });

  it('negative value → undefined', () => {
    writeGroupConfig('g1', { subagentLimit: -1 });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBeUndefined();
  });

  it('float → floored to integer', () => {
    writeGroupConfig('g1', { subagentLimit: 3.9 });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBe(3);
  });

  it('string number → parsed', () => {
    writeGroupConfig('g1', { subagentLimit: '5' });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBe(5);
  });

  it('non-numeric string → undefined', () => {
    writeGroupConfig('g1', { subagentLimit: 'many' });
    const cfg = readContainerConfig('g1');
    expect(cfg.subagentLimit).toBeUndefined();
  });
});

describe('backfillAllowedCapabilities', () => {
  it('backfills missing field and skips already-present field', () => {
    writeGroupConfig('old', { mcpServers: {} });
    writeGroupConfig('new', { allowedCapabilities: ['shell_exec'] });

    backfillAllowedCapabilities();

    const oldRaw = JSON.parse(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'old', 'container.json'), 'utf8')) as {
      allowedCapabilities: string[];
    };
    expect(oldRaw.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);

    const newRaw = JSON.parse(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'new', 'container.json'), 'utf8')) as {
      allowedCapabilities: string[];
    };
    expect(newRaw.allowedCapabilities).toEqual(['shell_exec']);
  });

  it('is idempotent — second call does not change already-backfilled files', () => {
    writeGroupConfig('g3', { mcpServers: {} });
    backfillAllowedCapabilities();
    backfillAllowedCapabilities();
    const raw = JSON.parse(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'g3', 'container.json'), 'utf8')) as {
      allowedCapabilities: string[];
    };
    expect(raw.allowedCapabilities).toEqual(['shell_exec', 'file_write', 'network']);
  });
});
