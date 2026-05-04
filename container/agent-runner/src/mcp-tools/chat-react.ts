/**
 * Admin-only MCP tool: set_chat_react.
 *
 * Lets an admin agent enable or disable the host-driven 👀 reaction on wake
 * for the current chat (or a specified channel), without needing host-side
 * CLI access.
 *
 * Only registered when container.json has isAdmin=true (same gate as
 * chat-emoji.ts). The host re-validates admin status before applying the
 * set_chat_react system action.
 *
 * The change takes effect on the next turn after the system action is
 * applied — no container restart required.
 */
import { getTurnSourceRouting } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

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

export const setChatReact: McpToolDefinition = {
  tool: {
    name: 'set_chat_react',
    description:
      'Enable or disable the host-driven 👀 reaction that appears on inbound messages while the agent is processing. ' +
      'Set enabled=false to stop the reaction from appearing in this chat. ' +
      'Set enabled=true to restore the default behaviour. ' +
      'Admin-only. Change takes effect on the next message turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        enabled: {
          type: 'boolean',
          description: 'true to enable the 👀 reaction on wake (default), false to suppress it.',
        },
      },
      required: ['enabled'],
    },
  },
  async handler(args) {
    const enabled = args.enabled;
    if (typeof enabled !== 'boolean') {
      return err('enabled must be a boolean (true or false).');
    }

    const turnRouting = getTurnSourceRouting();
    const sessionRouting = getSessionRouting();
    const channelType = turnRouting?.channelType ?? sessionRouting.channel_type;
    const platformId = turnRouting?.platformId ?? sessionRouting.platform_id;

    if (!channelType || !platformId) {
      return err('Could not determine current chat routing. No messaging group to update.');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'set_chat_react',
        enabled,
        channelType,
        platformId,
      }),
    });

    log(`set_chat_react: ${requestId} → channelType="${channelType}" platformId="${platformId}" enabled=${enabled}`);
    return ok(
      `React-on-wake change request submitted: this chat → ${enabled ? 'on' : 'off'}. You will be notified when applied. ` +
        `The change takes effect on the next message turn.`,
    );
  },
};

registerTools([setChatReact]);

log('Chat-react tool registered: set_chat_react');
