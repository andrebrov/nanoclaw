/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export type McpServerEntry =
  | { command: string; args: string[]; env: Record<string, string>; url?: never }
  | { url: string; type: 'http' | 'sse'; headers?: Record<string, string>; command?: never };

/**
 * Capabilities explicitly granted by the operator in container.json.
 * Mirrors the AgentCapability type on the host side.
 */
export type AgentCapability = 'shell_exec' | 'file_write' | 'network';

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
}

const DEFAULT_MAX_MESSAGES = 10;

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
    allowedCapabilities: Array.isArray(raw.allowedCapabilities)
      ? (raw.allowedCapabilities as AgentCapability[])
      : [],
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
