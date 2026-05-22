/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 *
 * See `docs/claude-md-composition.md` for the full design.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { configFromDb, type McpServerConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

/**
 * Extract the `description` field from a SKILL.md YAML frontmatter block.
 * Handles quoted (single or double) and unquoted values, including multi-word
 * descriptions that span the rest of the `description:` line.
 */
function parseSkillDescription(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return '';
  const descMatch = fm[1].match(/^description:\s*([\s\S]*?)(?=\n\S|\n*$)/m);
  if (!descMatch) return '';
  return descMatch[1]
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * Build a compact manifest block listing progressive skills.
 * Reads each skill's SKILL.md frontmatter from the host-side skills directory.
 */
function buildProgressiveSkillManifest(skillNames: string[], skillsHostDir: string): string {
  const entries: string[] = [];
  for (const name of skillNames.sort()) {
    const skillMdPath = path.join(skillsHostDir, name, 'SKILL.md');
    let desc = '';
    if (fs.existsSync(skillMdPath)) {
      try {
        desc = parseSkillDescription(fs.readFileSync(skillMdPath, 'utf-8'));
      } catch {
        /* skip unreadable */
      }
    }
    entries.push(`- **${name}**: ${desc}`);
  }
  return [
    '## Skills available on demand',
    '',
    'The following skills are available but not pre-loaded. Use `mcp__nanoclaw__list_skills` to',
    'see this list with descriptions, then `mcp__nanoclaw__get_skill("<name>")` to load the full',
    'instructions for a specific skill before using it.',
    '',
    ...entries,
  ].join('\n');
}

export interface ComposeOptions {
  /**
   * When non-empty, also write `CLAUDE.maintenance.md` alongside `CLAUDE.md`.
   * The maintenance variant omits skill fragments whose name matches an entry in
   * this list (matched against the skill directory name, e.g. "crm").
   * Maintenance sessions mount `CLAUDE.maintenance.md` instead of `CLAUDE.md`.
   */
  maintenanceBlocklist?: string[];
}

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 *
 * When `opts.maintenanceBlocklist` is non-empty, also writes
 * `CLAUDE.maintenance.md` — a slim variant that omits the listed skill
 * fragments. Used to reduce cold-start token cost for scheduled tasks.
 */
export function composeGroupClaudeMd(group: AgentGroup, opts?: ComposeOptions): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Desired fragment set.
  const configRow = getContainerConfig(group.id);
  const config = configRow ? configFromDb(configRow, group) : null;
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? (JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};
  const desired = new Map<string, { type: 'symlink' | 'inline'; content: string }>();

  // Skill fragments — every skill that ships an `instructions.md`.
  // TODO (shared-source refactor): respect `container.json` skill selection.
  const skillsHostDir = path.join(process.cwd(), 'container', 'skills');

  // Resolve the set of progressive skills from container config.
  const progressiveRaw = config?.progressiveSkills;
  let allSkillNames: string[] = [];
  if (fs.existsSync(skillsHostDir)) {
    allSkillNames = fs.readdirSync(skillsHostDir).filter((e) => {
      try {
        return fs.statSync(path.join(skillsHostDir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  }
  const progressiveSet: Set<string> =
    progressiveRaw === 'all' ? new Set(allSkillNames) : new Set(Array.isArray(progressiveRaw) ? progressiveRaw : []);

  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of allSkillNames) {
      if (progressiveSet.has(skillName)) continue; // deferred — not eagerly included
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (fs.existsSync(hostFragment)) {
        desired.set(`skill-${skillName}.md`, {
          type: 'symlink',
          content: `${SHARED_SKILLS_CONTAINER_BASE}/${skillName}/instructions.md`,
        });
      }
    }
  }

  // Progressive skill manifest — a compact list added to CLAUDE.md when any
  // skills are deferred. Informs the agent what's available on demand.
  if (progressiveSet.size > 0) {
    const manifest = buildProgressiveSkillManifest([...progressiveSet], skillsHostDir);
    desired.set('progressive-skills.md', { type: 'inline', content: manifest });
  }

  // Built-in module fragments — every MCP tool source file that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's MCP tools (schedule_task, install_packages, etc.).
  // Skip cli.instructions.md when cli_scope is disabled.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      desired.set(`module-${moduleName}.md`, {
        type: 'symlink',
        content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, {
        type: 'inline',
        content: mcp.instructions,
      });
    }
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, frag] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    if (frag.type === 'symlink') {
      syncSymlink(fragPath, frag.content);
    } else {
      writeAtomic(fragPath, frag.content);
    }
  }

  // Composed entry — imports only.
  const sortedFragments = [...desired.keys()].sort();
  const imports = ['@./.claude-shared.md'];
  for (const name of sortedFragments) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  // Slim maintenance variant — same as above minus blocked skill fragments.
  // Written only when the blocklist is non-empty; removed otherwise so stale
  // files don't linger after the operator clears the blocklist.
  const maintenancePath = path.join(groupDir, 'CLAUDE.maintenance.md');
  const blocklist = opts?.maintenanceBlocklist ?? [];
  if (blocklist.length > 0) {
    const blocked = new Set(blocklist.map((s) => `skill-${s}.md`));
    const maintenanceImports = ['@./.claude-shared.md'];
    for (const name of sortedFragments) {
      if (!blocked.has(name)) {
        maintenanceImports.push(`@./.claude-fragments/${name}`);
      }
    }
    writeAtomic(maintenancePath, [COMPOSED_HEADER, ...maintenanceImports, ''].join('\n'));
  } else {
    try {
      fs.unlinkSync(maintenancePath);
    } catch {
      /* file absent — nothing to remove */
    }
  }

  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
