/**
 * Admin-only MCP tool: set_chat_emoji.
 *
 * Lets an admin agent toggle the per-chat emoji mode (auto | on | off) for
 * any messaging group the current session is operating in, without needing
 * host-side CLI access.
 *
 * Only registered when container.json has isAdmin=true (same gate as
 * channel-model.ts). The host re-validates admin status before applying
 * the set_chat_emoji system action.
 *
 * The change takes effect on the *next* turn after the system action is
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

export const setChatEmoji: McpToolDefinition = {
  tool: {
    name: 'set_chat_emoji',
    description:
      'Set the emoji mode for the current chat (or a specified channel). ' +
      '"off" disables emoji in agent replies and strips any from outbound text. ' +
      '"on" encourages emoji where natural. ' +
      '"auto" (default) lets the agent decide. ' +
      'Admin-only. Change takes effect on the next message turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['auto', 'on', 'off'],
          description:
            'Emoji mode to set: "auto" (default), "on" (encourage emoji), or "off" (no emoji, strip from output).',
        },
      },
      required: ['mode'],
    },
  },
  async handler(args) {
    const mode = (args.mode as string | undefined)?.trim();
    if (!mode || !['auto', 'on', 'off'].includes(mode)) {
      return err('mode must be one of "auto", "on", or "off".');
    }

    // Resolve routing: prefer the per-turn source (current chat) over the
    // session default so the toggle applies to the chat being replied to.
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
        action: 'set_chat_emoji',
        mode,
        channelType,
        platformId,
      }),
    });

    log(`set_chat_emoji: ${requestId} → channelType="${channelType}" platformId="${platformId}" mode="${mode}"`);
    return ok(
      `Emoji mode change request submitted: this chat → ${mode}. You will be notified when applied. ` +
        `The change takes effect on the next message turn.`,
    );
  },
};

registerTools([setChatEmoji]);

log('Chat-emoji tool registered: set_chat_emoji');
