/**
 * extend_ceiling MCP tool — lets the agent declare a task-level ceiling
 * override so the host sweep does not kill a long-running container that is
 * making real progress but goes long stretches without a Claude SDK event.
 *
 * The host reads `declared_max_ms` from container_state and uses
 * max(ABSOLUTE_CEILING_MS, tool_declared_timeout_ms, declared_max_ms) as
 * the effective ceiling. Call extend_ceiling at the start of a long phase;
 * the override is automatically cleared when the turn ends (host-sweep
 * resets on kill, and a natural turn-end does not persist across restarts).
 */
import { clearDeclaredMaxMs, setDeclaredMaxMs } from '../db/connection.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const extendCeiling: McpToolDefinition = {
  tool: {
    name: 'extend_ceiling',
    description:
      'Declare that the current task needs more than the default 30-minute host-sweep ceiling. Call this at the start of a long phase (deep research, batch processing, multi-stage pipelines). The host sweep will keep this container alive for up to `seconds` from the last heartbeat instead of the default 30 min. Call with seconds=0 to clear the override early.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        seconds: {
          type: 'number',
          description:
            'Headroom in seconds. Must be > 0 (e.g. 3600 for 1 hour). Pass 0 to clear a previously set ceiling.',
        },
      },
      required: ['seconds'],
    },
  },
  async handler(args) {
    const seconds = args.seconds as number;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      return err('seconds must be a non-negative finite number');
    }

    if (seconds === 0) {
      clearDeclaredMaxMs();
      return ok('Ceiling override cleared — host-sweep will use the default 30-minute ceiling.');
    }

    const ms = Math.round(seconds * 1000);
    setDeclaredMaxMs(ms);
    return ok(
      `Ceiling extended to ${seconds}s (${Math.round(ms / 60000)} min). Host sweep will keep this container alive for up to ${seconds}s from the last heartbeat.`,
    );
  },
};

registerTools([extendCeiling]);
