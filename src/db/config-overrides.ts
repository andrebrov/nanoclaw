/**
 * Per-channel and per-user config overrides.
 *
 * Resolution order (later wins):
 *   global defaults → channel override → user override
 *
 * Each override row stores a JSON subset of ConfigOverride. Merging is
 * shallow: a field present in the user row replaces the channel row's value.
 */
import type Database from 'better-sqlite3';

export interface ConfigOverride {
  /** Claude model string, e.g. "claude-haiku-4-5". */
  model?: string;
  /** Maximum output tokens for this request. */
  maxTokens?: number;
  /** Appended verbatim to the system prompt for this turn. */
  systemPromptAppend?: string;
  /**
   * Additional tool names granted for this scope. Additive union with the
   * group's base allowlist — cannot remove tools, only add them.
   */
  allowedTools?: string[];
  /**
   * Per-chat emoji policy stamped by the router from messaging_groups.emoji_mode.
   * 'auto' = agent decides; 'on' = encourage emoji; 'off' = prohibit + strip.
   */
  emojiMode?: 'auto' | 'on' | 'off';
}

interface OverrideRow {
  config_json: string;
}

function safeParseOverride(row: OverrideRow): ConfigOverride {
  try {
    return JSON.parse(row.config_json) as ConfigOverride;
  } catch {
    return {};
  }
}

function mergeOverrides(base: ConfigOverride, override: ConfigOverride): ConfigOverride {
  const merged: ConfigOverride = { ...base };
  if (override.model !== undefined) merged.model = override.model;
  if (override.maxTokens !== undefined) merged.maxTokens = override.maxTokens;
  if (override.systemPromptAppend !== undefined) merged.systemPromptAppend = override.systemPromptAppend;
  if (override.allowedTools !== undefined) {
    // Additive union: combine base tools + override tools, deduplicated.
    const base_tools = base.allowedTools ?? [];
    merged.allowedTools = [...new Set([...base_tools, ...override.allowedTools])];
  }
  return merged;
}

/**
 * Look up a single override row.
 * agent_group_id='' means "applies to all agent groups".
 * Prefer the scoped row (specific agent group) over the global one.
 */
function lookupOverride(
  db: Database.Database,
  scopeType: 'channel' | 'user',
  scopeId: string,
  agentGroupId: string,
): ConfigOverride {
  // Prefer scoped override; fall back to global (agent_group_id='') if not found.
  const scoped = db
    .prepare('SELECT config_json FROM config_overrides WHERE scope_type = ? AND scope_id = ? AND agent_group_id = ?')
    .get(scopeType, scopeId, agentGroupId) as OverrideRow | undefined;
  if (scoped) return safeParseOverride(scoped);

  const global = db
    .prepare("SELECT config_json FROM config_overrides WHERE scope_type = ? AND scope_id = ? AND agent_group_id = ''")
    .get(scopeType, scopeId) as OverrideRow | undefined;
  if (global) return safeParseOverride(global);

  return {};
}

/**
 * Resolve the merged config override for a given (channel, user, agent_group).
 * Returns null when no overrides exist so callers can skip serialisation.
 */
export function resolveOverrides(
  db: Database.Database,
  messagingGroupId: string,
  userId: string | null,
  agentGroupId: string,
): ConfigOverride | null {
  const channelOverride = lookupOverride(db, 'channel', messagingGroupId, agentGroupId);
  const userOverride = userId ? lookupOverride(db, 'user', userId, agentGroupId) : {};

  const hasChannel = Object.keys(channelOverride).length > 0;
  const hasUser = Object.keys(userOverride).length > 0;
  if (!hasChannel && !hasUser) return null;

  return mergeOverrides(channelOverride, userOverride);
}

/** Upsert a config override. Pass an empty object to clear all fields. */
export function setOverride(
  db: Database.Database,
  scopeType: 'channel' | 'user',
  scopeId: string,
  agentGroupId: string,
  config: ConfigOverride,
): void {
  db.prepare(
    `INSERT INTO config_overrides (scope_type, scope_id, agent_group_id, config_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(scope_type, scope_id, agent_group_id)
     DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  ).run(scopeType, scopeId, agentGroupId, JSON.stringify(config));
}

/** Remove a config override row. */
export function deleteOverride(
  db: Database.Database,
  scopeType: 'channel' | 'user',
  scopeId: string,
  agentGroupId: string,
): void {
  db.prepare('DELETE FROM config_overrides WHERE scope_type = ? AND scope_id = ? AND agent_group_id = ?').run(
    scopeType,
    scopeId,
    agentGroupId,
  );
}

/** List all overrides, optionally filtered by scope_type. */
export function listOverrides(
  db: Database.Database,
  scopeType?: 'channel' | 'user',
): Array<{ scope_type: string; scope_id: string; agent_group_id: string; config_json: string; updated_at: string }> {
  if (scopeType) {
    return db
      .prepare('SELECT * FROM config_overrides WHERE scope_type = ? ORDER BY scope_type, scope_id, agent_group_id')
      .all(scopeType) as Array<{
      scope_type: string;
      scope_id: string;
      agent_group_id: string;
      config_json: string;
      updated_at: string;
    }>;
  }
  return db.prepare('SELECT * FROM config_overrides ORDER BY scope_type, scope_id, agent_group_id').all() as Array<{
    scope_type: string;
    scope_id: string;
    agent_group_id: string;
    config_json: string;
    updated_at: string;
  }>;
}
