/**
 * Admin-only MCP tools: list_groups, set_group_model.
 *
 * Allow operators to inspect and change per-group model overrides from chat
 * without needing host-side CLI access.
 *
 * Only registered when container.json has isAdmin=true (same gate as
 * observability.ts). The host re-validates admin status before applying
 * the set_group_model system action.
 *
 * Requires the groups dir mount added for admin containers:
 *   /workspace/host-logs/groups/<folder>/container.json  (read-only)
 * The central DB is read from:
 *   /workspace/host-logs/v2.db  (read-only, same as chat_status)
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HOST_LOGS_BASE = '/workspace/host-logs';
const CENTRAL_DB_PATH = path.join(HOST_LOGS_BASE, 'v2.db');
const GROUPS_BASE = path.join(HOST_LOGS_BASE, 'groups');

// claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5-20251001, etc.
const MODEL_RE = /^claude-[a-z0-9]+-[0-9]/;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function openCentralDb(): Database | null {
  if (!fs.existsSync(CENTRAL_DB_PATH)) return null;
  try {
    const db = new Database(CENTRAL_DB_PATH, { readonly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch (e) {
    log(`Failed to open central DB: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function readGroupModel(folder: string): string | undefined {
  const cfgPath = path.join(GROUPS_BASE, folder, 'container.json');
  if (!fs.existsSync(cfgPath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    return typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
}

export const listGroups: McpToolDefinition = {
  tool: {
    name: 'list_groups',
    description:
      'List all agent groups with their current model override. Use this to find group folder slugs before calling set_group_model. Admin-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  async handler(_args) {
    if (!fs.existsSync(HOST_LOGS_BASE)) {
      return err('Host-logs not mounted. Set isAdmin=true in container.json to enable this tool.');
    }

    const db = openCentralDb();
    if (!db) {
      return err(`Central DB not available at ${CENTRAL_DB_PATH}.`);
    }

    try {
      const groups = db.prepare('SELECT id, name, folder FROM agent_groups ORDER BY name').all() as AgentGroupRow[];

      if (groups.length === 0) {
        return ok('No agent groups registered.');
      }

      const lines: string[] = ['Agent groups:'];
      for (const g of groups) {
        const model = readGroupModel(g.folder) ?? '(default)';
        lines.push(`  ${g.name} | folder: ${g.folder} | model: ${model}`);
      }
      return ok(lines.join('\n'));
    } finally {
      db.close();
    }
  },
};

export const setGroupModel: McpToolDefinition = {
  tool: {
    name: 'set_group_model',
    description:
      "Set the Claude model override for a target agent group. Writes to the group's container.json and restarts its container. Admin-only. Use list_groups to find valid folder slugs.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        group: {
          type: 'string',
          description: "Target agent group folder slug (e.g. 'main'). Use list_groups to find valid slugs.",
        },
        model: {
          type: 'string',
          description:
            "Claude model ID to set (e.g. 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'). Pass an empty string to remove the override and fall back to the default model.",
        },
      },
      required: ['group', 'model'],
    },
  },
  async handler(args) {
    const group = (args.group as string | undefined)?.trim();
    const model = (args.model as string | undefined)?.trim() ?? '';

    if (!group) return err('group is required');
    if (model && !MODEL_RE.test(model)) {
      return err(
        `Invalid model ID "${model}". Expected a Claude model ID starting with "claude-" (e.g. claude-sonnet-4-6).`,
      );
    }

    // Validate the group exists before submitting — avoids a useless round-trip
    // and gives the agent immediate feedback when referencing a stale/removed group.
    const db = openCentralDb();
    if (db) {
      try {
        const row = db
          .prepare(`SELECT folder FROM agent_groups WHERE folder = ? OR LOWER(name) = LOWER(?) LIMIT 1`)
          .get(group, group) as { folder: string } | null;
        if (!row) {
          const all = db.prepare('SELECT name FROM agent_groups ORDER BY name').all() as { name: string }[];
          const list = all.map((g) => g.name).join(', ');
          return err(`No agent group called "${group}". Available groups: ${list || '(none)'}`);
        }
      } finally {
        db.close();
      }
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'set_group_model',
        group,
        model: model || null,
      }),
    });

    log(`set_group_model: ${requestId} → group="${group}" model="${model || '(clear)'}"`);
    return ok(
      model
        ? `Model change request submitted: group "${group}" → ${model}. You will be notified when applied.`
        : `Model override clear request submitted for group "${group}". You will be notified when applied.`,
    );
  },
};

registerTools([listGroups, setGroupModel]);

log('Channel-model tools registered: list_groups, set_group_model');
