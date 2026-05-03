/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const db = getInboundDb();

  // Fast path: exact match on canonical name.
  const exact = db.prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  if (exact) return rowToEntry(exact);

  // Fallback: case-insensitive match on display_name or name so agents can
  // address a chat by its human-readable title (e.g. "Finsi Team") even though
  // the canonical key is the normalized slug (e.g. "finsi-team").
  const byLabel = db
    .prepare(
      'SELECT * FROM destinations WHERE lower(name) = lower(?) OR (display_name IS NOT NULL AND lower(display_name) = lower(?))',
    )
    .get(name, name) as DestRow | undefined;
  if (byLabel) return rowToEntry(byLabel);

  // Fallback: match by raw platform_id for channel destinations so agents can
  // address a chat by its platform identifier (e.g. Telegram chat ID "-100370…").
  const byPlatformId = db.prepare("SELECT * FROM destinations WHERE type = 'channel' AND platform_id = ?").get(name) as
    | DestRow
    | undefined;
  return byPlatformId ? rowToEntry(byPlatformId) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
          | DestRow
          | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map +
 * (optional) the current turn's source chat. The source-chat block is added
 * per-turn by the poll-loop so the agent always knows where to reply, even
 * when its prior task context referenced a different chat.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(
  assistantName?: string,
  sourceRouting?: { channelType: string | null; platformId: string | null; threadId: string | null } | null,
): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(
      [
        '# You are ' + assistantName,
        '',
        `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
        '',
        `Platform-specific bot handles (such as \`@SomeBotName\` on Telegram) are routing addresses — they tell the platform which bot to deliver a message to. They are not your name or a secondary identity. Your name is **${assistantName}** only.`,
      ].join('\n'),
    );
  }

  const sourceBlock = buildSourceChatBlock(sourceRouting ?? null);
  if (sourceBlock) sections.push(sourceBlock);

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

/**
 * Build an emoji-policy addendum for the per-turn system context.
 * Returns null when mode is 'auto' (no instruction needed).
 */
export function buildEmojiBlock(emojiMode: 'auto' | 'on' | 'off' | undefined): string | null {
  if (!emojiMode || emojiMode === 'auto') return null;
  if (emojiMode === 'off') {
    return [
      '# Emoji policy',
      '',
      'Do not use emoji in any of your responses for this chat. Plain text only — no Unicode emoji, no emoticons using emoji characters.',
    ].join('\n');
  }
  return [
    '# Emoji policy',
    '',
    'Feel free to use emoji naturally in your responses where it fits the conversational tone of this chat.',
  ].join('\n');
}

/**
 * Per-turn block telling the agent which chat triggered the current turn.
 * Exported so the poll-loop can re-render it on every batch (the rest of
 * the addendum is stable and built once at startup).
 */
export function buildSourceChatBlock(
  sourceRouting: { channelType: string | null; platformId: string | null; threadId: string | null } | null,
): string | null {
  if (!sourceRouting?.channelType || !sourceRouting.platformId) return null;
  const sourceDest = findByRouting(sourceRouting.channelType, sourceRouting.platformId);
  const label = sourceDest
    ? `\`${sourceDest.name}\`${sourceDest.displayName ? ` (${sourceDest.displayName})` : ''}`
    : `${sourceRouting.channelType}:${sourceRouting.platformId}`;
  return [
    '## This turn’s source chat',
    '',
    `The triggering message arrived from **${label}**. Plain text replies (no \`<message>\` block, no \`send_message\` \`to:\` parameter) land here automatically.`,
    '',
    '**Do not call `send_message`/`send_file` with an explicit `to:` pointing at a different destination unless the operator asked you to cross-post.** Your task notes may reference a delivery target from an earlier conversation in another chat — ignore that target when the current trigger is from a different chat. If you genuinely intend to cross-post, do it as an addition (one plain reply here + one explicit cross-post), not as a replacement.',
  ].join('\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  // Single-destination shortcut: the agent just writes its response normally.
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    return [
      '## Sending messages',
      '',
      'Your response is delivered to the channel where the triggering message came from. Just write your response directly — no special wrapping needed.',
      '',
      `To explicitly send to \`${d.name}\`${label} regardless of the source channel, call \`send_message(to="${d.name}", text="...")\`.`,
      '',
      'To mark something as scratchpad (logged but not sent), wrap it in `<internal>...</internal>`.',
      '',
      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',
    ].join('\n');
  }

  const lines = ['## Sending messages', '', 'You can send messages to the following destinations:', ''];
  for (const d of all) {
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`- \`${d.name}\`${label}`);
  }
  lines.push('');
  lines.push('To send a message, wrap it in a `<message to="name">...</message>` block.');
  lines.push('You can include multiple `<message>` blocks in one response to send to multiple destinations.');
  lines.push(
    'Text outside of `<message>` blocks is delivered to the channel the triggering message came from (not to a named destination).',
  );
  lines.push('Use `<internal>...</internal>` to mark something as scratchpad — logged but never delivered.');
  lines.push('');
  lines.push(
    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',
  );
  return lines.join('\n');
}
