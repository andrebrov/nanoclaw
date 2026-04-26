/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { messageDbPath } from './message-store.js';
import { writeSessionSecrets } from './container-secrets.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<void>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 */
export function wakeContainer(session: Session): Promise<void> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve();
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session).finally(() => {
    wakePromises.delete(session.id);
  });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Read container config once — threaded through provider resolution,
  // buildMounts, and buildContainerArgs so we don't re-read the file.
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Ensure container.json has the agent group identity fields the runner needs.
  // Written at spawn time so the runner can read them from the RO mount.
  ensureRuntimeFields(containerConfig, agentGroup);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  // Remove any stale .heartbeat from a prior container instance. The host
  // sweep's absolute-ceiling check uses heartbeat mtime as liveness; if a
  // prior container was killed/crashed, its heartbeat persists on disk and
  // the sweep will compute age > ceiling the moment the new container is
  // listed as running, kill-137 it before it can write its first heartbeat,
  // and retry-storm forever. Deleting here restores the "fresh spawn ⇒ no
  // heartbeat file" invariant that host-sweep.ts:79–86 relies on.
  try {
    fs.unlinkSync(heartbeatPath(agentGroup.id, session.id));
  } catch {
    /* already absent — fine */
  }

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = (containerConfig.provider || 'claude').toLowerCase();
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — read-write so agents can share learnings via
  // files like skills-discovered.md. All containers write to the same dir;
  // conflicts are user-space (last write wins per file).
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
  mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: false });

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Cross-session message index — read-only. Single writer is the host
  // (src/message-store.ts); containers query it for context recovery
  // ("what did this user say last week?", "did we discuss X already?").
  // Only mount if the host has initialized the file at least once;
  // first-spawn-before-first-message is fine — no mount, agent skips it.
  if (fs.existsSync(messageDbPath)) {
    mounts.push({ hostPath: messageDbPath, containerPath: '/workspace/messages.db', readonly: true });
  }

  // Per-session secret files for v1-style skill scripts (composio-tool,
  // instantly-tool, phantombuster-tool). v2 stopped writing these when it
  // moved to OneCLI Vault; without them every Composio-mediated skill
  // exits with "credentials not available" before the OneCLI proxy ever
  // sees the request. See container-secrets.ts for rationale.
  for (const m of writeSessionSecrets(sessDir)) {
    mounts.push(m);
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // /home/node/.claude.json — Claude CLI's config file lives at HOME root,
  // NOT inside the .claude/ subdir. Without this mount it's container-local
  // and lost on every restart, which makes claude write a fresh
  // `{"firstStartTime":"..."}` placeholder on init that fails to authenticate
  // through the SDK invocation path. Result: every run returns "Not logged
  // in · Please run /login" as the response. The file is 0o600 + RW; claude
  // updates it (cached features, growth-book flags, session refs) and the
  // changes persist across spawns. Restore from `.claude-shared/backups/`
  // if missing — claude rotates good copies there before writing a new one.
  const claudeConfigPath = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'claude-config.json');
  if (!fs.existsSync(claudeConfigPath)) {
    const backupsDir = path.join(claudeDir, 'backups');
    if (fs.existsSync(backupsDir)) {
      const candidates = fs
        .readdirSync(backupsDir)
        .filter((n) => n.startsWith('.claude.json.backup.'))
        .map((n) => ({ name: n, path: path.join(backupsDir, n), size: fs.statSync(path.join(backupsDir, n)).size }))
        // Pick the largest backup — small ones (~50 bytes) are placeholder
        // states from failed inits; the real config is multi-KB.
        .sort((a, b) => b.size - a.size);
      if (candidates.length > 0 && candidates[0].size > 1000) {
        fs.copyFileSync(candidates[0].path, claudeConfigPath);
        fs.chmodSync(claudeConfigPath, 0o600);
        log.info('Restored .claude.json from backup', {
          agentGroup: agentGroup.name,
          source: candidates[0].name,
          size: candidates[0].size,
        });
      } else {
        // No usable backup — touch an empty file so the bind-mount works;
        // claude will populate it on first start.
        fs.writeFileSync(claudeConfigPath, '{}', { mode: 0o600 });
      }
    } else {
      fs.writeFileSync(claudeConfigPath, '{}', { mode: 0o600 });
    }
  }
  mounts.push({ hostPath: claudeConfigPath, containerPath: '/home/node/.claude.json', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Tessl tiles — installed at ./.tessl/tiles/<author>/<tile>/ on the
  // host (vendored mode, see tessl.json). Mount RO so agents can use
  // installed tiles like uinaf/verify, uinaf/review, github-ops, etc.
  // Skills inside tiles are discovered via syncTesslTileSymlinks below,
  // which projects them as `tessl__<skill>` symlinks alongside the
  // trunk skills in .claude-shared/skills/.
  const tesslTilesDir = path.join(projectRoot, '.tessl', 'tiles');
  if (fs.existsSync(tesslTilesDir)) {
    mounts.push({ hostPath: tesslTilesDir, containerPath: '/app/tessl-tiles', readonly: true });
    syncTesslTileSymlinks(claudeDir, tesslTilesDir);
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Project Tessl tiles into the agent's `.claude-shared/skills/` directory
 * as `tessl__<skill>` symlinks, mirroring how syncSkillSymlinks handles the
 * trunk skills. Two tile shapes are supported:
 *
 *   1. Single-skill tile — `<author>/<tile>/SKILL.md` at the tile root.
 *      → symlinked as `tessl__<tile-name>`.
 *   2. Multi-skill tile — `<author>/<tile>/skills/<skill>/SKILL.md`.
 *      → each `<skill>` symlinked as `tessl__<skill>`.
 *
 * Symlink targets use the container path (`/app/tessl-tiles/...`) since
 * Claude Code resolves them inside the container. The host path on disk
 * doesn't need to match — only the symlink string does.
 *
 * Idempotent: stale `tessl__*` symlinks for tiles no longer installed are
 * pruned each spawn. Trunk skills (without the `tessl__` prefix) are left
 * alone — that's `syncSkillSymlinks`'s domain.
 */
function syncTesslTileSymlinks(claudeDir: string, tesslTilesDir: string): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Discover desired tessl skills: walk <author>/<tile>/ for either
  // SKILL.md (single) or skills/*/SKILL.md (multi).
  const desired = new Map<string, string>(); // linkName → containerTargetPath
  if (fs.existsSync(tesslTilesDir)) {
    for (const author of fs.readdirSync(tesslTilesDir)) {
      const authorDir = path.join(tesslTilesDir, author);
      if (!fs.statSync(authorDir).isDirectory()) continue;
      for (const tile of fs.readdirSync(authorDir)) {
        const tileDir = path.join(authorDir, tile);
        if (!fs.statSync(tileDir).isDirectory()) continue;
        const rootSkill = path.join(tileDir, 'SKILL.md');
        const skillsSubdir = path.join(tileDir, 'skills');
        if (fs.existsSync(rootSkill)) {
          desired.set(`tessl__${tile}`, `/app/tessl-tiles/${author}/${tile}`);
        } else if (fs.existsSync(skillsSubdir) && fs.statSync(skillsSubdir).isDirectory()) {
          for (const sub of fs.readdirSync(skillsSubdir)) {
            const subDir = path.join(skillsSubdir, sub);
            if (!fs.statSync(subDir).isDirectory()) continue;
            if (!fs.existsSync(path.join(subDir, 'SKILL.md'))) continue;
            desired.set(`tessl__${sub}`, `/app/tessl-tiles/${author}/${tile}/skills/${sub}`);
          }
        }
      }
    }
  }

  // Prune stale tessl__ symlinks
  for (const entry of fs.readdirSync(skillsDir)) {
    if (!entry.startsWith('tessl__')) continue;
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired tessl skills
  for (const [linkName, target] of desired) {
    const linkPath = path.join(skillsDir, linkName);
    let exists = false;
    try {
      const stat = fs.lstatSync(linkPath);
      exists = stat.isSymbolicLink();
      if (exists && fs.readlinkSync(linkPath) !== target) {
        // Target changed (tile upgraded or moved) — refresh the symlink
        fs.unlinkSync(linkPath);
        exists = false;
      }
    } catch {
      /* missing — fall through to creation */
    }
    if (!exists) {
      fs.symlinkSync(target, linkPath);
    }
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  if (dirty) {
    writeContainerConfig(agentGroup.folder, containerConfig);
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Passthrough: non-secret config env vars the skills expect (Composio IDs,
  // URLs, Meta app config). Secrets flow via OneCLI, not here.
  //
  // ANTHROPIC_API_KEY exception: the agent-runner SDK gets credentials via
  // the OneCLI proxy at outbound-HTTPS time, but subprocesses spawned by
  // the agent (claude CLI invoked from Bash, Task tool sub-agents, skill
  // scripts shelling out to `claude`) check `process.env.ANTHROPIC_API_KEY`
  // *before* making any HTTPS call. Without it they fail immediately with
  // "Not logged in · Please run /login", regardless of proxy config. So
  // ANTHROPIC_API_KEY rides along too — same key the vault holds, just
  // also visible inside the container's env.
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_API_KEY|COMPOSIO_|CLAY_WEBHOOK_URL|GHOST_API_URL|META_|GRANOLA_)/.test(key)) {
      const v = process.env[key];
      if (v) args.push('-e', `${key}=${v}`);
    }
  }

  // COMPOSIO_API_KEY placeholder — the Composio SDK reads this env var at
  // init time and fails if absent. When the host .env has no COMPOSIO_API_KEY
  // (because the real key lives in OneCLI vault), inject a dummy value so the
  // SDK initialises. The OneCLI proxy intercepts outbound requests to
  // backend.composio.dev and overwrites the x-api-key header with the vault
  // credential, so any non-empty placeholder works.
  if (!process.env['COMPOSIO_API_KEY']) {
    args.push('-e', 'COMPOSIO_API_KEY=test');
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  try {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (onecliApplied) {
      log.info('OneCLI gateway applied', { containerName });
    } else {
      log.warn('OneCLI gateway not applied — container will have no credentials', { containerName });
    }
  } catch (err) {
    log.warn('OneCLI gateway error — container will have no credentials', { containerName, err });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `nanoclaw-agent:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
