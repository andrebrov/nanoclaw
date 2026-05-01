/**
 * Three-stage cost gate for multi-bot social group chats (issue #174).
 *
 * Sits between the engage decision and the container wake in the inbound
 * routing path. For match-all group wirings that did not pass Stage 1 (DM /
 * explicit @mention / short directive), the Stage 2 Haiku classifier asks
 * "is this message addressed to any bot?" using recent message history.
 *
 * Stage 1 helpers (deterministic, microsecond-cost):
 *   - isReplyToOurMessage  — checks messages.db for a matching outbound platform_msg_id
 *   - threadHasBotInvolvement — any prior bot outbound in this thread
 *   - isAddressedToOtherBot — message mentions a known other-bot handle only
 *
 * Stage 2 (Haiku, ~$0.003/call):
 *   - classifyNeedsAgent — binary YES/NO via claude-haiku-4-5
 *   - All user content wrapped in <untrusted-input> (OWASP LLM01/LLM08)
 *   - Configurable per-group bias direction
 *
 * Uses native fetch() — no @anthropic-ai/sdk dependency in the host.
 */

import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const MESSAGES_DB_PATH = path.join(DATA_DIR, 'messages.db');

interface RecentMessage {
  direction: 'in' | 'out';
  sender_name: string | null;
  text: string | null;
}

/**
 * Retrieve the last N messages for a messaging group (inbound and outbound)
 * ordered by insertion time ascending (oldest first). Used to build Stage 2
 * classifier context.
 */
export function getRecentGroupMessages(channelType: string, platformId: string, limit = 10): RecentMessage[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(MESSAGES_DB_PATH, { readonly: true });
    // Subquery retrieves the N most recent rows; outer query reverses to
    // chronological order so the classifier sees the conversation in time order.
    const rows = db
      .prepare(
        `SELECT direction, sender_name, text
           FROM (
             SELECT direction, sender_name, text, id
               FROM messages
              WHERE channel_type = ? AND platform_id = ?
                AND text IS NOT NULL
              ORDER BY id DESC
              LIMIT ?
           )
           ORDER BY id ASC`,
      )
      .all(channelType, platformId, limit) as RecentMessage[];
    return rows;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Stage 1 signal: check whether an inbound message is a reply to one of our
 * previously-sent messages on this channel.
 *
 * `replyToMsgId` is the platform message ID extracted from the inbound content
 * (e.g. `content.replyToMessageId` for the Chat SDK bridge or
 * `content.reply_to_message_id` for native Telegram). Returns false when the
 * value is absent.
 */
export function isReplyToOurMessage(
  channelType: string,
  platformId: string,
  replyToMsgId: string | number | null | undefined,
): boolean {
  if (replyToMsgId === null || replyToMsgId === undefined) return false;
  const id = String(replyToMsgId);
  if (!id) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(MESSAGES_DB_PATH, { readonly: true });
    const row = db
      .prepare(
        `SELECT 1 FROM messages
          WHERE channel_type = ?
            AND platform_id = ?
            AND direction = 'out'
            AND platform_msg_id = ?
          LIMIT 1`,
      )
      .get(channelType, platformId, id);
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Stage 1 signal: check whether this thread already has bot involvement
 * (any outbound message from us in this channel+thread). If we've engaged
 * before, follow-up messages are likely still relevant.
 */
export function threadHasBotInvolvement(channelType: string, platformId: string, threadId: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(MESSAGES_DB_PATH, { readonly: true });
    const row = db
      .prepare(
        `SELECT 1 FROM messages
          WHERE channel_type = ?
            AND platform_id = ?
            AND thread_id = ?
            AND direction = 'out'
          LIMIT 1`,
      )
      .get(channelType, platformId, threadId);
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Stage 1 filter: return true when the message text contains a mention of a
 * known OTHER-BOT handle but NOT a mention of our own bot (i.e. `isMention`
 * is false). In that case the message is clearly meant for a sibling bot and
 * we should not engage — skip Stage 2 too.
 *
 * `otherBotHandles` comes from `container.json → costGating.otherBotHandles`.
 */
export function isAddressedToOtherBot(text: string, otherBotHandles: string[]): boolean {
  if (otherBotHandles.length === 0) return false;
  return otherBotHandles.some((handle) =>
    new RegExp(`@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
  );
}

let cachedApiKey: string | null | undefined = undefined;

function getAnthropicApiKey(): string | null {
  if (cachedApiKey !== undefined) return cachedApiKey;
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv) {
    cachedApiKey = fromEnv;
    return cachedApiKey;
  }
  const fromFile = readEnvFile(['ANTHROPIC_API_KEY']);
  cachedApiKey = fromFile.ANTHROPIC_API_KEY ?? null;
  return cachedApiKey;
}

// Russian collective references that signal "addressing bots generally"
const CLASSIFIER_SYSTEM = `You are a binary classifier for a multi-bot group chat. Your task: decide whether the most recent user message is addressed to a bot (any bot, including ours).

Signals that mean YES (addressed to a bot):
- Direct @mention of any bot handle
- Collective references to bots: "боты", "агентики", "ребят", "ии", "ai", "bot"
- A question or task clearly directed at an AI
- A reply to something a bot just said

Signals that mean NO (human-to-human):
- Casual conversation between people
- Message clearly continues a topic between humans
- No bot mention, no bot-directed phrasing

CRITICAL: Respond with exactly one word: YES or NO. Nothing else.`;

/**
 * Stage 2 Haiku classifier.
 *
 * Calls claude-haiku-4-5 with recent message history and the current message,
 * and asks "is this addressed to a bot?" Returns true to wake a container,
 * false to store the message silently.
 *
 * All user content is wrapped in `<untrusted-input>` tags to prevent prompt
 * injection (OWASP LLM01/LLM08). The classifier is intentionally constrained
 * to a single YES/NO token so there is no reasoning chain that could be
 * influenced by injected instructions.
 *
 * @param currentText    - Text of the current message to classify
 * @param context        - Recent messages for conversational context
 * @param biasNo         - true → bias toward NO (social/high-volume chats);
 *                         false → bias toward YES (dev/ops chats)
 */
export async function classifyNeedsAgent(
  currentText: string,
  context: RecentMessage[],
  biasNo: boolean,
): Promise<boolean> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    log.debug('Stage 2 classifier: no ANTHROPIC_API_KEY configured, using bias fallback', { biasNo });
    return !biasNo;
  }

  const contextLines = context
    .map((m) => {
      const role = m.direction === 'out' ? '[bot]' : `[${m.sender_name ?? 'user'}]`;
      return `${role}: ${m.text}`;
    })
    .join('\n');

  const classifyBlock = contextLines
    ? `<untrusted-input>\nConversation history (oldest first):\n${contextLines}\n\nMessage to classify:\n${currentText}\n</untrusted-input>`
    : `<untrusted-input>\n${currentText}\n</untrusted-input>`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: classifyBlock }],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      log.warn('Stage 2 classifier API error', { status: resp.status, biasNo });
      return !biasNo;
    }

    const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
    const answer = (data.content?.[0]?.text ?? '').trim().toUpperCase();
    const wake = answer.startsWith('YES');
    log.debug('Stage 2 classifier', { answer, wake });
    return wake;
  } catch (err) {
    log.warn('Stage 2 classifier request failed, using bias fallback', { err, biasNo });
    return !biasNo;
  }
}
