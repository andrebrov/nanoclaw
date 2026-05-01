/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it. Config changes go through the self-mod approval flow.
 *
 * All fields are optional — a missing file or a partial file both resolve
 * to sensible defaults. Writes are atomic-enough (write-then-rename is not
 * worth the ceremony here since there's only one writer in practice: the
 * host, from the delivery thread that processes approved system actions).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';

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

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /** Claude model override for this group (e.g. "claude-haiku-4-5"). Passed as AGENT_MODEL env var. */
  model?: string;
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

function parseProgressiveSkills(raw: unknown): string[] | 'all' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'all') return 'all';
  if (!Array.isArray(raw)) return undefined;
  const result = raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  return result.length > 0 ? result : undefined;
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
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
      isAdmin: raw.isAdmin,
      allowedCapabilities: parseAllowedCapabilities(raw.allowedCapabilities, p),
      linkedinPostValidator: raw.linkedinPostValidator === true,
      loopDetection: parseLoopDetectionConfig(raw.loopDetection),
      observer: raw.observer,
      maintenanceSkillBlocklist: Array.isArray(raw.maintenanceSkillBlocklist)
        ? raw.maintenanceSkillBlocklist.filter((s): s is string => typeof s === 'string')
        : undefined,
      progressiveSkills: parseProgressiveSkills(raw.progressiveSkills),
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}

/**
 * One-shot startup migration: backfill allowedCapabilities into any existing
 * groups/<folder>/container.json files that pre-date PR #61 and therefore
 * omit the field. Without this, those groups would silently lose Bash /
 * Write / WebFetch on the next container restart.
 *
 * Safe to call repeatedly — skips files that already declare the field.
 */
export function backfillAllowedCapabilities(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const patched: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = configPath(entry.name);
    if (!fs.existsSync(p)) continue;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (raw.allowedCapabilities !== undefined) continue;

    raw.allowedCapabilities = [...ALL_CAPABILITIES];
    try {
      fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
      patched.push(entry.name);
    } catch (err) {
      log.warn('[container-config] backfill failed', { folder: entry.name, err });
    }
  }

  if (patched.length > 0) {
    log.info('[container-config] backfilled allowedCapabilities', { groups: patched });
  }
}
