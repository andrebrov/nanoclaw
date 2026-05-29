/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group.
 *     Fork-specific fields (allowedCapabilities, observer, costGating, …) live
 *     in the row's `extensions` JSON column (migration 018).
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time.
 *   - `readContainerConfig()` — reads the materialized `container.json` cache
 *     (host modules read config from disk without a DB round-trip).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * OAuth 2.0 credentials for HTTP/SSE MCP servers that require bearer-token
 * auth. The agent-runner resolves the token at container start-up and injects
 * it as `Authorization: Bearer <token>` before handing the server config to
 * the Claude Code SDK. The SDK itself is unaware of OAuth.
 */
export interface OAuthConfig {
  /** Token endpoint (e.g. https://auth.example.com/oauth/token) */
  tokenUrl: string;
  /** "client_credentials" for service-to-service; "refresh_token" for user-delegated */
  grantType: 'client_credentials' | 'refresh_token';
  clientId: string;
  clientSecret?: string;
  /** Required when grantType is "refresh_token" */
  refreshToken?: string;
  /** Space-separated OAuth scope string */
  scope?: string;
}

export type McpServerConfig =
  | {
      // stdio transport (local process)
      command: string;
      args?: string[];
      env?: Record<string, string>;
      url?: never;
      headers?: never;
      type?: 'stdio';
      instructions?: string;
    }
  | {
      // HTTP (Streamable HTTP) or SSE transport (remote server)
      url: string;
      type: 'http' | 'sse';
      headers?: Record<string, string>;
      /** OAuth 2.0 config — token is resolved by the agent-runner at startup */
      oauth?: OAuthConfig;
      command?: never;
      args?: never;
      env?: never;
      instructions?: string;
    };

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/**
 * Capabilities that must be explicitly granted before the agent may use the
 * corresponding tools. Omitting this field (or leaving it empty) keeps the
 * agent in the safe default: read-only filesystem access, no shell, no
 * outbound network calls — only NanoClaw MCP tools and read operations.
 *
 * Valid entries:
 *   "shell_exec"  — Bash
 *   "file_write"  — Write, Edit, NotebookEdit
 *   "network"     — WebSearch, WebFetch
 */
export type AgentCapability = 'shell_exec' | 'file_write' | 'network';

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  /** Claude model override for this group (e.g. "claude-haiku-4-5"). Passed as AGENT_MODEL env var. */
  model?: string;
  /** Reasoning-effort override (upstream container_configs column). */
  effort?: string;
  /**
   * docker --memory ceiling for this group's containers (e.g. "1500m", "2g").
   * Validated against /^\d+[bkmgt]?$/i at spawn time; invalid values fall
   * back to the safe default (1500m) with a warning. Set higher when an
   * agent needs to buffer large tool outputs (PDF rendering, big HTTP
   * responses, etc.); set lower to constrain risky agents.
   *
   * When absent, the safe default applies (1500m) — that's enough for
   * typical agent usage (~200-500MB observed) with ~3× headroom, and
   * prevents a runaway from OOMing the host.
   */
  memory_limit?: string;
  /**
   * Grant this container admin observability: mounts host logs + session dirs
   * read-only at /workspace/host-logs/ and enables the chat_status MCP tool.
   * Only set on designated admin agent groups.
   */
  isAdmin?: boolean;
  /**
   * Opt-in capabilities beyond the safe default. Missing or empty array means
   * the agent runs in restricted mode: no shell, no file writes, no network.
   * See AgentCapability for valid values.
   */
  allowedCapabilities?: AgentCapability[];
  /**
   * When true, this group's agent has its outbound LinkedIn-post Bash
   * commands gated by the merchant-advocate review. See
   * specs/linkedin-post-validator.spec.md.
   */
  linkedinPostValidator?: boolean;
  /**
   * Enable the loop-detection guard. The agent's PreToolUse hook maintains
   * a rolling window of tool-call fingerprints and blocks repeated identical
   * calls. Set to `true` for defaults (window=10, threshold=3) or an object
   * to configure thresholds explicitly.
   */
  loopDetection?: boolean | { windowSize?: number; repeatThreshold?: number };
  /**
   * Optional observer status channel — streams thinking/tool events and
   * watchdog pings to a separate channel for real-time observability.
   * When absent, the status-channel feature is disabled; the reaction
   * cycle and main-chat watchdog still fire regardless.
   */
  observer?: {
    statusChannelId: string;
    statusChannelType: string;
    statusThreadId?: string | null;
  };
  /**
   * Skill names to exclude from the system prompt for maintenance/scheduled
   * sessions. Interactive sessions still receive the full prompt. Entries are
   * skill directory names under `container/skills/` (e.g. "crm", "outreach").
   * Absent or empty → no filtering.
   */
  maintenanceSkillBlocklist?: string[];
  /**
   * Skills to load progressively (on-demand) rather than at session startup.
   * Listed skills are NOT symlinked into `.claude/skills/` — Claude Code does
   * not load their SKILL.md at startup. Instead, the agent discovers them via
   * `mcp__nanoclaw__list_skills` and loads full instructions with
   * `mcp__nanoclaw__get_skill`. Reduces baseline prompt tokens for sessions
   * that don't use most skills (e.g. scheduled tasks).
   *
   * Entries are skill directory names under `container/skills/`. Use "all" to
   * defer every skill. Absent or empty → all skills loaded eagerly (default).
   */
  progressiveSkills?: string[] | 'all';
  /**
   * Hard cap on Task (sub-agent spawn) calls per model turn. After the model
   * responds, calls that would exceed this limit are blocked before execution.
   * The counter resets after each model turn. Absent or ≤ 0 → unlimited.
   *
   * Takes precedence over the host-level AGENT_SUBAGENT_LIMIT env var.
   */
  subagentLimit?: number;
  /**
   * Three-stage cost gate for match-all group wirings (issue #174).
   *
   * Only applies when engage_mode='pattern' and engage_pattern='.' on a
   * group messaging group. DMs and explicit @mentions always bypass the gate.
   *
   * Stage 1 (deterministic): reply-to-our-bot, thread bot-involvement signal,
   * other-bot-handle skip.
   * Stage 2 (Haiku classifier): binary YES/NO via claude-haiku-4-5.
   * Requires ANTHROPIC_API_KEY in .env.
   */
  costGating?: {
    /** Enable the three-stage gate. Default: false. */
    enabled?: boolean;
    /**
     * Platform handles of sibling bots in this group (e.g. ["RockyBot", "LoMBot"]).
     * When a message @-mentions only one of these and not our bot, Stage 1
     * immediately skips engagement — no Stage 2 call needed.
     */
    otherBotHandles?: string[];
    /**
     * Classifier bias for Stage 2.
     * 'no'  → bias toward not spawning (good for high-volume social chats).
     * 'yes' → bias toward spawning (good for dev/ops chats where missing a
     *         message is costly). Default: 'no'.
     */
    classifierBias?: 'yes' | 'no';
    /**
     * Number of recent messages to include as Stage 2 context.
     * Higher values improve accuracy but increase token cost. Default: 10.
     */
    contextMessageCount?: number;
  };
}

const ALL_CAPABILITIES: AgentCapability[] = ['shell_exec', 'file_write', 'network'];
const KNOWN_CAPABILITIES = new Set<string>(ALL_CAPABILITIES);

function emptyConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    allowedCapabilities: [...ALL_CAPABILITIES],
  };
}

/**
 * Validate and normalise a raw `allowedCapabilities` value from JSON.
 *
 * - Absent / undefined → permissive default (all caps), so pre-#61 installs
 *   that omit the field continue to work exactly as before.
 * - Non-array → loud warning, permissive default.
 * - Array with unknown strings → warn for each unknown, drop them.
 * - Empty array → restricted mode (intentional operator choice).
 */
function parseAllowedCapabilities(raw: unknown, source: string): AgentCapability[] {
  if (raw === undefined || raw === null) {
    return [...ALL_CAPABILITIES];
  }
  if (!Array.isArray(raw)) {
    log.warn('[container-config] allowedCapabilities must be an array — ignoring and defaulting to permissive', {
      source,
      got: typeof raw,
    });
    return [...ALL_CAPABILITIES];
  }
  const result: AgentCapability[] = [];
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (KNOWN_CAPABILITIES.has(s)) {
      result.push(s as AgentCapability);
    } else {
      log.warn('[container-config] unknown capability — ignored', { source, value: item });
    }
  }
  return result;
}

function parseLoopDetectionConfig(
  raw: unknown,
): boolean | { windowSize?: number; repeatThreshold?: number } | undefined {
  if (raw === true) return true;
  if (!raw) return undefined;
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    const out: { windowSize?: number; repeatThreshold?: number } = {};
    if (typeof o.windowSize === 'number' && o.windowSize > 0) out.windowSize = Math.floor(o.windowSize);
    if (typeof o.repeatThreshold === 'number' && o.repeatThreshold >= 2)
      out.repeatThreshold = Math.floor(o.repeatThreshold);
    return out;
  }
  return undefined;
}

function parseSubagentLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function parseCostGatingConfig(raw: unknown): ContainerConfig['costGating'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const handles = Array.isArray(o.otherBotHandles)
    ? o.otherBotHandles.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    : undefined;
  const bias = o.classifierBias === 'yes' || o.classifierBias === 'no' ? o.classifierBias : undefined;
  const count =
    typeof o.contextMessageCount === 'number' && o.contextMessageCount > 0
      ? Math.floor(o.contextMessageCount)
      : undefined;
  return {
    enabled: o.enabled === true,
    otherBotHandles: handles,
    classifierBias: bias,
    contextMessageCount: count,
  };
}

function parseProgressiveSkills(raw: unknown): string[] | 'all' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'all') return 'all';
  if (!Array.isArray(raw)) return undefined;
  const result = raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  return result.length > 0 ? result : undefined;
}

function parseObserver(raw: unknown): ContainerConfig['observer'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.statusChannelId !== 'string' || typeof o.statusChannelType !== 'string') return undefined;
  return {
    statusChannelId: o.statusChannelId,
    statusChannelType: o.statusChannelType,
    statusThreadId: typeof o.statusThreadId === 'string' ? o.statusThreadId : null,
  };
}

/** Safely parse the `extensions` JSON blob from a container_configs row. */
function parseExtensions(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Build a `ContainerConfig` from a DB row + agent group identity. Standard
 * fields come from typed columns; fork-specific fields are read out of the
 * row's `extensions` JSON blob and normalised through the same parse helpers
 * the file path uses.
 */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  const ext = parseExtensions(row.extensions);
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    // Fork-specific fields (stored in the `extensions` JSON column).
    isAdmin: ext.isAdmin === true,
    allowedCapabilities: parseAllowedCapabilities(ext.allowedCapabilities, `db:${group.id}`),
    linkedinPostValidator: ext.linkedinPostValidator === true,
    loopDetection: parseLoopDetectionConfig(ext.loopDetection),
    observer: parseObserver(ext.observer),
    maintenanceSkillBlocklist: Array.isArray(ext.maintenanceSkillBlocklist)
      ? (ext.maintenanceSkillBlocklist as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
    progressiveSkills: parseProgressiveSkills(ext.progressiveSkills),
    subagentLimit: parseSubagentLimit(ext.subagentLimit),
    costGating: parseCostGatingConfig(ext.costGating),
  };
}

/**
 * Read the materialized `container.json` cache for a group from disk. Returns
 * `emptyConfig()` when the file is absent. The file is written from the DB at
 * spawn (see materializeContainerJson); host modules read it for config
 * without a DB round-trip.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
    return {
      mcpServers: raw.mcpServers ?? {},
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      effort: typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : undefined,
      isAdmin: raw.isAdmin,
      allowedCapabilities: parseAllowedCapabilities(raw.allowedCapabilities, p),
      linkedinPostValidator: raw.linkedinPostValidator === true,
      loopDetection: parseLoopDetectionConfig(raw.loopDetection),
      observer: raw.observer,
      maintenanceSkillBlocklist: Array.isArray(raw.maintenanceSkillBlocklist)
        ? raw.maintenanceSkillBlocklist.filter((s): s is string => typeof s === 'string')
        : undefined,
      progressiveSkills: parseProgressiveSkills(raw.progressiveSkills),
      subagentLimit: parseSubagentLimit(raw.subagentLimit),
      costGating: parseCostGatingConfig(raw.costGating),
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
