/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo } from '../current-batch.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getDeliveryStatus, getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { getTurnReplyTo, getTurnSourceRouting, setTurnSendInvoked } from '../db/session-state.js';
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

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Poll inbound.db until the host records a delivery result for `messageOutId`,
 * or until `timeoutMs` elapses.
 *
 * The host's active delivery loop runs every ~1 s, so delivery normally
 * appears within 1–2 s. A 5 s timeout gives reasonable headroom for slow
 * network round-trips to the platform API while keeping the tool responsive.
 */
async function waitForDelivery(messageOutId: string, timeoutMs = 5000): Promise<'delivered' | 'failed' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 250));
    const status = getDeliveryStatus(messageOutId);
    if (status !== null) return status;
  }
  return 'timeout';
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    // Prefer the source channel of the current turn's triggering message.
    // When a message arrives from a group chat and the agent calls send_message()
    // without an explicit destination, the reply should go to that group — not
    // to the session's default DM binding. Mirrors the dispatchResultText path
    // for plain text so both delivery paths route consistently.
    const turnSource = getTurnSourceRouting();
    if (turnSource) {
      return {
        channel_type: turnSource.channelType,
        platform_id: turnSource.platformId,
        thread_id: turnSource.threadId,
        resolvedName: '(current conversation)',
      };
    }

    // Fallback: reply to whatever thread/channel this session is bound to
    // (used when there's no active chat turn, e.g. scheduled tasks).
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a message to a named destination. If you have only one destination, you can omit `to`. ' +
      "Pass `inReplyTo` (a message seq) to reply in that message's thread/topic — useful in forum-mode " +
      'group chats where you want to thread your reply under a specific message rather than the ' +
      "session's default thread.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.',
        },
        text: { type: 'string', description: 'Message content' },
        inReplyTo: {
          type: 'integer',
          description:
            'Optional message seq (the numeric id shown next to incoming messages) to thread the ' +
            "reply under. Overrides the destination's default thread for this one message. Use when " +
            'the user wrote in a specific topic and you want your reply in that same topic, not the ' +
            "group's general thread.",
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');

    let routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    // Optional reply target: agent wants to reply to a specific message
    // (forum topic / Discord thread / DM). When `inReplyTo` is set, it
    // OVERRIDES the entire destination — channel_type, platform_id, AND
    // thread_id — so the reply lands wherever the referenced message
    // lives, regardless of what `to` (or session_routing) was inferred to.
    // This is the intuitive contract: "reply to message #N" means "go to
    // where #N is", not "use the session's default chat with #N's
    // thread_id grafted on top". The earlier partial override (thread_id
    // only) caused replies to fly to the DM with a group's topic id —
    // mismatched routing, dropped delivery.
    let inReplyToId: string | null = null;
    if (args.inReplyTo !== undefined && args.inReplyTo !== null) {
      const refSeq = Number(args.inReplyTo);
      if (!refSeq || refSeq <= 0) return err('inReplyTo must be a positive integer message seq');
      const refRouting = getRoutingBySeq(refSeq);
      if (!refRouting || !refRouting.channel_type || !refRouting.platform_id) {
        return err(`inReplyTo: message #${refSeq} not found or has no routing`);
      }
      routing = {
        channel_type: refRouting.channel_type,
        platform_id: refRouting.platform_id,
        thread_id: refRouting.thread_id,
        resolvedName: `(reply to #${refSeq})`,
      };
      const refPlatformMsgId = getMessageIdBySeq(refSeq);
      if (refPlatformMsgId) inReplyToId = refPlatformMsgId;
    } else if (!args.to) {
      // No explicit destination and no explicit inReplyTo: default to the
      // triggering message of the current turn so replies thread correctly.
      inReplyToId = getTurnReplyTo();
    } else {
      // Explicit `to` was given but no `inReplyTo`. If the destination
      // resolves to the same channel/platform as the triggering message,
      // still thread to that message — losing threading just because the
      // agent passed `to:` is a footgun. After a session restart the SDK
      // conversation history primes the agent to keep passing `to:` (e.g.
      // in group chats with multiple destinations), and without this
      // fallback its replies stop threading on every cold-start.
      // Cross-channel sends (different channel/platform) still fall
      // through with no default — threading wouldn't be meaningful there.
      const turnSource = getTurnSourceRouting();
      if (
        turnSource &&
        turnSource.channelType === routing.channel_type &&
        turnSource.platformId === routing.platform_id
      ) {
        inReplyToId = getTurnReplyTo();
      }
    }

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: inReplyToId,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    setTurnSendInvoked();
    log(`send_message: #${seq} → ${routing.resolvedName}${inReplyToId ? ` (reply to ${inReplyToId})` : ''}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const rawFilename = (args.filename as string) || path.basename(resolvedPath);
    // Reject filenames with path components — agent-supplied strings could
    // include `..` or `/` and escape the outbox dir. basename neutralizes
    // them deterministically; reject empty results so we don't write to the
    // outbox dir itself.
    const filename = path.basename(rawFilename);
    if (!filename || filename === '.' || filename === '..') {
      return err(`Invalid filename: ${rawFilename}`);
    }

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    setTurnSendInvoked();
    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Message #${seq} not found`);
    }

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) {
      return err(
        `Message #${seq} hasn't been delivered yet — wait a moment and try again, or it has no platform id to edit.`,
      );
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

/**
 * Map Slack/GitHub-style emoji names to the Unicode characters that
 * platform reaction APIs actually expect. Telegram in particular returns
 * `Bad Request: REACTION_INVALID` for `"white_check_mark"`, `"thumbs_up"`,
 * etc. — it wants the literal `✅`, `👍`. Agents have been trained to use
 * the Slack-style names, so the tool accepts both and we normalize here.
 *
 * Pass-through any value already starting with a non-ASCII character —
 * if you give us `"👍"` we don't second-guess it.
 */
const EMOJI_NAME_MAP: Record<string, string> = {
  thumbs_up: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  '-1': '👎',
  heart: '❤',
  red_heart: '❤',
  fire: '🔥',
  white_check_mark: '✅',
  check: '✅',
  check_mark: '✅',
  done: '✅',
  ok: '✅',
  x: '❌',
  cross: '❌',
  no_entry: '⛔',
  warning: '⚠',
  eyes: '👀',
  thinking: '🤔',
  thinking_face: '🤔',
  rocket: '🚀',
  star: '⭐',
  party: '🎉',
  tada: '🎉',
  clap: '👏',
  pray: '🙏',
  hundred: '💯',
  '100': '💯',
  poop: '💩',
  laugh: '😂',
  joy: '😂',
  cry: '😢',
  sob: '😭',
  rage: '😡',
  angry: '😡',
  confused: '😕',
  smile: '🙂',
  wave: '👋',
  point_up: '☝',
  point_down: '👇',
  zap: '⚡',
  cool: '😎',
  shrug: '🤷',
};

function normalizeEmoji(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  // Strip surrounding `:` if Slack-style (e.g. ":thumbs_up:")
  const stripped = trimmed.replace(/^:|:$/g, '');
  // Already a Unicode emoji (high codepoint) — pass through.
  if (stripped.codePointAt(0)! > 0x7f) return stripped;
  const lower = stripped.toLowerCase().replace(/[\s-]+/g, '_');
  return EMOJI_NAME_MAP[lower] ?? stripped;
}

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: {
          type: 'string',
          description:
            'Emoji to react with. Accepts Slack-style names (`thumbs_up`, `white_check_mark`, `fire`) ' +
            'OR the literal Unicode character (`👍`, `✅`, `🔥`). Slack-style names are normalized ' +
            "because Telegram's reaction API only accepts Unicode.",
        },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const rawEmoji = args.emoji as string;
    if (!seq || !rawEmoji) return err('messageId and emoji are required');

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Message #${seq} not found`);
    }

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) {
      return err(
        `Message #${seq} hasn't been delivered yet — wait a moment and try again, or it has no platform id to react to.`,
      );
    }

    const emoji = normalizeEmoji(rawEmoji);

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${rawEmoji}${rawEmoji === emoji ? '' : ` (→ ${emoji})`} on ${platformId}`);

    const deliveryStatus = await waitForDelivery(id);
    if (deliveryStatus === 'delivered') {
      return ok(`Reaction added to message #${seq}`);
    }
    if (deliveryStatus === 'failed') {
      return err(
        `Reaction delivery failed for #${seq} — the platform rejected it (wrong permissions or unsupported emoji). Check server logs for details.`,
      );
    }
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);
