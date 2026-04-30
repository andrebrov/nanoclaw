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

const TEST_ROOT = '/tmp/nanoclaw-test-claude-md-compose';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-claude-md-compose/groups' };
});

// Stub readContainerConfig to avoid touching the real FS.
vi.mock('./container-config.js', () => ({
  readContainerConfig: vi.fn(() => ({ mcpServers: {}, skills: 'all' })),
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';

const fakeGroup = { id: 'ag-1', folder: 'test-group', name: 'Test' } as import('./types.js').AgentGroup;

function groupDir(): string {
  return path.join(TEST_GROUPS_DIR, fakeGroup.folder);
}

function readMd(filename: string): string {
  return fs.readFileSync(path.join(groupDir(), filename), 'utf8');
}

beforeEach(() => {
  // Create the container/skills structure the composer scans.
  const skillsDir = path.join(TEST_ROOT, 'container', 'skills');
  for (const skill of ['crm', 'outreach', 'welcome']) {
    const sd = path.join(skillsDir, skill);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'instructions.md'), `# ${skill}`);
  }
  // Point process.cwd() stub to TEST_ROOT so the composer finds container/skills.
  vi.spyOn(process, 'cwd').mockReturnValue(TEST_ROOT);
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('composeGroupClaudeMd — no blocklist', () => {
  it('writes full CLAUDE.md importing all skill fragments', () => {
    composeGroupClaudeMd(fakeGroup);
    const md = readMd('CLAUDE.md');
    expect(md).toContain('skill-crm.md');
    expect(md).toContain('skill-outreach.md');
    expect(md).toContain('skill-welcome.md');
  });

  it('does not write CLAUDE.maintenance.md when blocklist is absent', () => {
    composeGroupClaudeMd(fakeGroup);
    expect(fs.existsSync(path.join(groupDir(), 'CLAUDE.maintenance.md'))).toBe(false);
  });

  it('removes a stale CLAUDE.maintenance.md when blocklist cleared to empty', () => {
    composeGroupClaudeMd(fakeGroup, { maintenanceBlocklist: ['crm'] });
    expect(fs.existsSync(path.join(groupDir(), 'CLAUDE.maintenance.md'))).toBe(true);
    composeGroupClaudeMd(fakeGroup, { maintenanceBlocklist: [] });
    expect(fs.existsSync(path.join(groupDir(), 'CLAUDE.maintenance.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd — with blocklist', () => {
  it('writes CLAUDE.maintenance.md that omits blocked skills', () => {
    composeGroupClaudeMd(fakeGroup, { maintenanceBlocklist: ['crm', 'outreach'] });
    const md = readMd('CLAUDE.maintenance.md');
    expect(md).not.toContain('skill-crm.md');
    expect(md).not.toContain('skill-outreach.md');
    expect(md).toContain('skill-welcome.md');
  });

  it('full CLAUDE.md is unchanged and still contains all skills', () => {
    composeGroupClaudeMd(fakeGroup, { maintenanceBlocklist: ['crm'] });
    const md = readMd('CLAUDE.md');
    expect(md).toContain('skill-crm.md');
    expect(md).toContain('skill-outreach.md');
    expect(md).toContain('skill-welcome.md');
  });

  it('maintenance variant still imports the shared base', () => {
    composeGroupClaudeMd(fakeGroup, { maintenanceBlocklist: ['crm'] });
    const md = readMd('CLAUDE.maintenance.md');
    expect(md).toContain('@./.claude-shared.md');
  });

  it('blocklist entry that matches no skill is silently ignored', () => {
    composeGroupClaudeMd(fakeGroup, { maintenanceBlocklist: ['nonexistent'] });
    const md = readMd('CLAUDE.maintenance.md');
    expect(md).toContain('skill-crm.md');
    expect(md).toContain('skill-outreach.md');
    expect(md).toContain('skill-welcome.md');
  });
});
