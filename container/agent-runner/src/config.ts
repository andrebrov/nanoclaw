/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { OAuthConfig } from './oauth.js';
export type { OAuthConfig } from './oauth.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export type McpServerEntry =
  | { command: string; args: string[]; env: Record<string, string>; url?: never }
  | { url: string; type: 'http' | 'sse'; headers?: Record<string, string>; oauth?: OAuthConfig; command?: never };

/** A single named middleware slot: maps a display name to a shell command. */
export interface MiddlewareSlot {
  name: string;
  command: string;
}

/**
 * Ordered middleware pipeline per hook event.
 * Each key is a Claude Agent SDK hook event name; the value is an array of
 * slots executed in declared order, short-circuiting on the first block.
 *
 * Example container.json entry:
 * ```json
 * {
 *   "middlewareChain": {
 *     "PreToolUse": [
 *       { "name": "sandbox", "command": "/workspace/hooks/sandbox.sh" },
 *       { "name": "loop_detection", "command": "/workspace/hooks/loop.sh" }
 *     ],
 *     "PostToolUse": [
 *       { "name": "memory", "command": "/workspace/hooks/memory.sh" }
 *     ]
 *   }
 * }
 * ```
 */
export type MiddlewareChain = Partial<Record<'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', MiddlewareSlot[]>>;

/**
 * Capabilities explicitly granted by the operator in container.json.
 * Mirrors the AgentCapability type on the host side.
 */
export type AgentCapability = 'shell_exec' | 'file_write' | 'network';

const ALL_CAPABILITIES: AgentCapability[] = ['shell_exec', 'file_write', 'network'];
const KNOWN_CAPABILITIES = new Set<string>(ALL_CAPABILITIES);

/**
 * Validate and normalise a raw allowedCapabilities value from container.json.
 * Absent / null → permissive default so pre-#61 installs keep working.
 * Non-array → logs warning, returns permissive default.
 * Array with unknown strings → drops unknowns and warns.
 */
function parseAllowedCapabilities(raw: unknown): AgentCapability[] {
  if (raw === undefined || raw === null) {
    return [...ALL_CAPABILITIES];
  }
  if (!Array.isArray(raw)) {
    console.error(
      `[config] allowedCapabilities must be an array — ignoring and defaulting to permissive (got: ${typeof raw})`,
    );
    return [...ALL_CAPABILITIES];
  }
  const result: AgentCapability[] = [];
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (KNOWN_CAPABILITIES.has(s)) {
      result.push(s as AgentCapability);
    } else {
      console.error(`[config] unknown capability '${String(item)}' — ignored`);
    }
  }
  return result;
}

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerEntry>;
  /** True when the host granted admin observability (host-logs mounts + chat_status tool). */
  isAdmin: boolean;
  /**
   * Opt-in capabilities beyond the safe default. Empty array (the default)
   * means restricted mode: no shell, no file writes, no network.
   */
  allowedCapabilities: AgentCapability[];
  /**
   * When true, Bash commands matching the LinkedIn-post patterns
   * (composio-tool linkedin-* / heyreach-tool *) are gated by the
   * merchant-advocate review hook before they execute. See
   * specs/linkedin-post-validator.spec.md.
   */
  linkedinPostValidator: boolean;
  /**
   * When set, the PreToolUse hook maintains a rolling window of the last
   * `windowSize` tool call fingerprints and blocks any call whose fingerprint
   * has appeared `repeatThreshold` or more times in the window.
   * false / absent → disabled.
   */
  loopDetection: false | { windowSize: number; repeatThreshold: number };
  /**
   * Ordered middleware pipeline per hook event. Absent means no extra
   * middleware. Slots are executed in declared order; the first block
   * short-circuits the chain. Each slot runs a shell command with the
   * hook input as JSON on stdin. See MiddlewareChain for details.
   */
  middlewareChain: MiddlewareChain;
  /**
   * Hard cap on Task (sub-agent spawn) calls per model turn. Absent or ≤ 0
   * means no limit from container.json; falls back to AGENT_SUBAGENT_LIMIT
   * env var. Per-group config takes precedence over the env var.
   */
  subagentLimit: number | undefined;
}

const KNOWN_MIDDLEWARE_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

function parseMiddlewareChain(raw: unknown): MiddlewareChain {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      console.error(`[config] middlewareChain must be an object — ignoring (got: ${typeof raw})`);
    }
    return {};
  }
  const result: MiddlewareChain = {};
  for (const [event, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_MIDDLEWARE_EVENTS.has(event)) {
      console.error(`[config] middlewareChain: unknown event '${event}' — ignored`);
      continue;
    }
    if (!Array.isArray(slots)) {
      console.error(`[config] middlewareChain.${event} must be an array — ignored`);
      continue;
    }
    const parsed: MiddlewareSlot[] = [];
    for (const slot of slots) {
      if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) {
        console.error(`[config] middlewareChain.${event}: slot must be an object — ignored`);
        continue;
      }
      const s = slot as Record<string, unknown>;
      if (typeof s.name !== 'string' || !s.name) {
        console.error(`[config] middlewareChain.${event}: slot missing 'name' string — ignored`);
        continue;
      }
      if (typeof s.command !== 'string' || !s.command) {
        console.error(`[config] middlewareChain.${event}: slot '${s.name}' missing 'command' string — ignored`);
        continue;
      }
      parsed.push({ name: s.name, command: s.command });
    }
    result[event as keyof MiddlewareChain] = parsed;
  }
  return result;
}

const DEFAULT_MAX_MESSAGES = 10;

function parseLoopDetection(raw: unknown): false | { windowSize: number; repeatThreshold: number } {
  if (!raw) return false;
  if (raw === true) return { windowSize: 10, repeatThreshold: 3 };
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    const windowSize = typeof o.windowSize === 'number' && o.windowSize > 0 ? Math.floor(o.windowSize) : 10;
    const repeatThreshold =
      typeof o.repeatThreshold === 'number' && o.repeatThreshold >= 2 ? Math.floor(o.repeatThreshold) : 3;
    return { windowSize, repeatThreshold };
  }
  return false;
}

function parseContainerSubagentLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    isAdmin: (raw.isAdmin as boolean) === true,
    allowedCapabilities: parseAllowedCapabilities(raw.allowedCapabilities),
    linkedinPostValidator: raw.linkedinPostValidator === true,
    loopDetection: parseLoopDetection(raw.loopDetection),
    middlewareChain: parseMiddlewareChain(raw.middlewareChain),
    subagentLimit: parseContainerSubagentLimit(raw.subagentLimit),
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
