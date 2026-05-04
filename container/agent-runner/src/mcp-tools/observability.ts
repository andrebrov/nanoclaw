/**
 * Admin-only observability MCP tools: chat_status.
 *
 * Only registered when container.json has isAdmin=true. The host mounts
 * host-side state read-only at /workspace/host-logs/ for admin groups:
 *   /workspace/host-logs/logs/       — orchestrator stdout/stderr logs
 *   /workspace/host-logs/v2.db       — central DB snapshot (WAL-mode, RO)
 *   /workspace/host-logs/sessions/   — per-session dirs + heartbeat files
 *
 * Non-admin containers never see these mounts, so these tools would fail
 * gracefully even if somehow invoked, but they are never registered there.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HOST_LOGS_BASE = '/workspace/host-logs';
const CENTRAL_DB_PATH = path.join(HOST_LOGS_BASE, 'v2.db');
const SESSIONS_BASE = path.join(HOST_LOGS_BASE, 'sessions');
const LOGS_DIR = path.join(HOST_LOGS_BASE, 'logs');

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Open the central DB read-only. Returns null and logs if unavailable. */
function openCentralDb(): Database | null {
  if (!fs.existsSync(CENTRAL_DB_PATH)) {
    return null;
  }
  try {
    const db = new Database(CENTRAL_DB_PATH, { readonly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch (e) {
    log(`Failed to open central DB: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Age of a heartbeat file in seconds, or null if missing/unreadable. */
function heartbeatAgeSec(agentGroupId: string, sessionId: string): number | null {
  const hbPath = path.join(SESSIONS_BASE, agentGroupId, sessionId, '.heartbeat');
  try {
    const stat = fs.statSync(hbPath);
    return (Date.now() - stat.mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/**
 * Derive a human-readable container status from the DB field + heartbeat age.
 * The DB field can lag: if the heartbeat is stale but the DB says 'running',
 * report 'stale' so the admin can see the discrepancy.
 */
function resolveContainerStatus(dbStatus: string, hbAgeSec: number | null): string {
  if (dbStatus === 'running') {
    if (hbAgeSec === null) return 'running (no heartbeat)';
    if (hbAgeSec > 120) return `stale (heartbeat ${Math.round(hbAgeSec)}s ago)`;
    return `running (heartbeat ${Math.round(hbAgeSec)}s ago)`;
  }
  return dbStatus;
}

interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  session_name: string;
  container_status: string;
  last_active: string | null;
}

interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
}

interface MessagingGroupRow {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
}

interface WiringRow {
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: string;
  session_mode: string;
}

export const chatStatus: McpToolDefinition = {
  tool: {
    name: 'chat_status',
    description:
      'Return host-side status for registered chats — agent groups, wired messaging groups, session container status, and heartbeat liveness. Admin-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_group: {
          type: 'string',
          description: 'Filter by agent group name or folder (partial match, case-insensitive). Omit for all groups.',
        },
      },
      required: [],
    },
  },
  async handler(args) {
    if (!fs.existsSync(HOST_LOGS_BASE)) {
      return err('Host-logs not mounted. Set isAdmin=true in container.json to enable observability.');
    }

    const db = openCentralDb();
    if (!db) {
      return err(`Central DB not available at ${CENTRAL_DB_PATH}. Ensure host has written at least one session.`);
    }

    try {
      const filterRaw = (args.agent_group as string | undefined)?.toLowerCase() ?? '';

      const agentGroups = db
        .prepare('SELECT id, name, folder FROM agent_groups ORDER BY name')
        .all() as AgentGroupRow[];
      const wirings = db
        .prepare('SELECT messaging_group_id, agent_group_id, engage_mode, session_mode FROM messaging_group_agents')
        .all() as WiringRow[];
      const messagingGroups = db
        .prepare('SELECT id, channel_type, platform_id, name FROM messaging_groups')
        .all() as MessagingGroupRow[];

      const mgById = new Map(messagingGroups.map((mg) => [mg.id, mg]));
      const wiringsByAgent = new Map<string, WiringRow[]>();
      for (const w of wirings) {
        const list = wiringsByAgent.get(w.agent_group_id) ?? [];
        list.push(w);
        wiringsByAgent.set(w.agent_group_id, list);
      }

      const filteredGroups = filterRaw
        ? agentGroups.filter(
            (g) => g.name.toLowerCase().includes(filterRaw) || g.folder.toLowerCase().includes(filterRaw),
          )
        : agentGroups;

      if (filteredGroups.length === 0) {
        return ok(filterRaw ? `No agent groups matching "${filterRaw}".` : 'No agent groups registered.');
      }

      const lines: string[] = [];

      for (const group of filteredGroups) {
        lines.push(`## ${group.name} (${group.folder})`);

        const groupWirings = wiringsByAgent.get(group.id) ?? [];
        if (groupWirings.length === 0) {
          lines.push('  Channels: (none wired)');
        } else {
          for (const w of groupWirings) {
            const mg = mgById.get(w.messaging_group_id);
            const label = mg
              ? `${mg.channel_type}:${mg.platform_id}${mg.name ? ` (${mg.name})` : ''}`
              : w.messaging_group_id;
            lines.push(`  Channel: ${label} [${w.engage_mode}, ${w.session_mode}]`);
          }
        }

        // Sessions for this agent group
        const sessions = db
          .prepare(
            "SELECT id, agent_group_id, messaging_group_id, thread_id, session_name, container_status, last_active FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY session_name, last_active DESC",
          )
          .all(group.id) as SessionRow[];

        if (sessions.length === 0) {
          lines.push('  Sessions: (none)');
        } else {
          for (const s of sessions) {
            const hbAge = heartbeatAgeSec(group.id, s.id);
            const status = resolveContainerStatus(s.container_status, hbAge);
            const mg = s.messaging_group_id ? mgById.get(s.messaging_group_id) : null;
            const channel = mg ? `${mg.channel_type}:${mg.platform_id}` : '(no channel)';
            const thread = s.thread_id ? ` thread:${s.thread_id}` : '';
            const lastActive = s.last_active ? ` last:${s.last_active}` : '';
            lines.push(`  Session [${s.session_name}] ${channel}${thread} → ${status}${lastActive}`);
          }
        }

        lines.push('');
      }

      return ok(lines.join('\n').trimEnd());
    } finally {
      db.close();
    }
  },
};

registerTools([chatStatus]);

log('Observability tools registered: chat_status');
