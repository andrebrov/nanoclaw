/**
 * Session observer — reaction cycle + watchdog heartbeat.
 *
 * Items 1 + 2 (upstream platform code):
 *   Reaction cycle: 👀 on arrival → 🤔 on thinking → ⚡ on tool calls → ✍ on result.
 *   Watchdog: sends "Still working…" to the main chat at 60s / 120s / 300s if no
 *   reply has been delivered yet (sentReply flag suppresses further pings once the
 *   agent has responded).
 *
 * Item 3 (optional, via container.json observer field):
 *   Status channel: streams thinking/tool events + watchdog pings to a separate
 *   configured channel for real-time observability.
 *
 * Architecture:
 *   router.ts       → startSessionObserver() when a message wake fires
 *   container-runner.ts → feedObserverLine() per stderr line; destroySessionObserver() on exit
 *   delivery.ts     → notifyObserverReply() when a real message lands
 *   claude.ts       → writes observer:* lines to process.stderr
 */
import { readContainerConfig } from './container-config.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import type { Session } from './types.js';

const WATCHDOG_TICK_MS = 30_000;
const PING_THRESHOLDS_MS = [60_000, 120_000, 300_000];
const WATCHDOG_EMOJIS = ['⚡', '🔥'];

// ── Reaction cycle ──────────────────────────────────────────────────────────

type ReactionStage = 'watching' | 'thinking' | 'tool' | 'composing';

const REACTION_EMOJI: Record<ReactionStage, string> = {
  watching: '👀',
  thinking: '🤔',
  tool: '⚡',
  composing: '✍',
};

// ── Status-channel config (item 3) ──────────────────────────────────────────

interface StatusChannelConfig {
  statusChannelId: string;
  statusChannelType: string;
  statusThreadId?: string | null;
}

// ── Observer handle ─────────────────────────────────────────────────────────

export interface SessionObserverHandle {
  /** Feed a raw stderr line. Lines prefixed with `observer:` are parsed. */
  line(raw: string): void;
  /** Called when a user-facing reply has been delivered — stops the watchdog. */
  onReply(): void;
  /** Cancel timers and remove from the registry. Called on container exit. */
  destroy(): void;
}

// In-flight observers keyed by session ID.
const observers = new Map<string, SessionObserverHandle>();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a session observer. Emits 👀 on the original inbound message
 * immediately, starts the watchdog, and registers the handle so
 * container-runner.ts can pipe stderr lines to it.
 *
 * Safe to call while a prior observer exists for the same session — the old
 * one is cleanly destroyed first so its watchdog doesn't fire twice.
 *
 * @param session          Active session
 * @param platformMsgId    Platform message ID of the inbound message (for reactions)
 * @param channelType      Channel type of the inbound message (for reactions + watchdog)
 * @param platformId       Platform ID of the inbound chat (for reactions + watchdog)
 * @param threadId         Thread ID, or null for non-threaded channels
 * @param agentGroupFolder Agent group folder name (to read container.json for status-channel config)
 */
export function startSessionObserver(
  session: Session,
  platformMsgId: string | null,
  channelType: string,
  platformId: string,
  threadId: string | null,
  agentGroupFolder: string,
): void {
  destroySessionObserver(session.id);

  const cfg = readContainerConfig(agentGroupFolder);
  const statusCfg = cfg.observer ?? null;

  let sentReply = false;
  let queryStartMs: number | null = null;
  let emojiIndex = 0;
  let pingsFired = 0;
  let toolCount = 0;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStage: ReactionStage = 'watching';

  // ── Delivery helpers ────────────────────────────────────────────────────

  async function sendReaction(emoji: string): Promise<void> {
    if (!platformMsgId) return;
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    try {
      await adapter.deliver(
        channelType,
        platformId,
        threadId,
        'chat',
        JSON.stringify({ operation: 'reaction', messageId: platformMsgId, emoji }),
      );
    } catch {
      // Reactions are cosmetic — never surface errors.
    }
  }

  async function sendToMain(text: string): Promise<void> {
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    try {
      await adapter.deliver(channelType, platformId, threadId, 'chat', JSON.stringify({ text }));
    } catch (err) {
      log.debug('Observer: watchdog ping failed', { err });
    }
  }

  async function sendToStatus(text: string): Promise<void> {
    if (!statusCfg) return;
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    try {
      await adapter.deliver(
        statusCfg.statusChannelType,
        statusCfg.statusChannelId,
        statusCfg.statusThreadId ?? null,
        'chat',
        JSON.stringify({ text }),
      );
    } catch (err) {
      log.debug('Observer: status-channel delivery failed', { err });
    }
  }

  // ── Reaction cycle ──────────────────────────────────────────────────────

  async function setStage(stage: ReactionStage): Promise<void> {
    if (currentStage === stage) return;
    currentStage = stage;
    await sendReaction(REACTION_EMOJI[stage]);
  }

  // ── Watchdog ────────────────────────────────────────────────────────────

  function tick(): void {
    if (sentReply || queryStartMs === null) return;
    const elapsed = Date.now() - queryStartMs;
    const emoji = WATCHDOG_EMOJIS[emojiIndex % WATCHDOG_EMOJIS.length];
    emojiIndex++;
    const nextPingMs = PING_THRESHOLDS_MS[pingsFired];
    if (nextPingMs !== undefined && elapsed >= nextPingMs) {
      const secs = Math.round(elapsed / 1000);
      const text = `${emoji} Still working… (${secs}s in, ${toolCount} tools so far)`;
      void sendToMain(text);
      if (statusCfg) void sendToStatus(text);
      pingsFired++;
    }
    watchdogTimer = setTimeout(tick, WATCHDOG_TICK_MS);
  }

  function startWatchdog(): void {
    stopWatchdog();
    queryStartMs = Date.now();
    emojiIndex = 0;
    pingsFired = 0;
    watchdogTimer = setTimeout(tick, WATCHDOG_TICK_MS);
  }

  function stopWatchdog(): void {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    queryStartMs = null;
  }

  // ── Initialise ──────────────────────────────────────────────────────────

  void sendReaction(REACTION_EMOJI.watching); // 👀 immediately
  startWatchdog();

  // ── Handle ──────────────────────────────────────────────────────────────

  const handle: SessionObserverHandle = {
    line(raw: string): void {
      if (!raw.startsWith('observer:')) return;
      const payload = raw.slice('observer:'.length);
      const eqIdx = payload.indexOf('=');
      if (eqIdx === -1) return;
      const kind = payload.slice(0, eqIdx);
      const valueStr = payload.slice(eqIdx + 1);

      let value: unknown;
      try {
        value = JSON.parse(valueStr);
      } catch {
        value = valueStr;
      }

      switch (kind) {
        case 'query_start':
          // Container confirmed a new query — restart watchdog so elapsed time
          // is measured from when the container actually began processing.
          stopWatchdog();
          startWatchdog();
          break;

        case 'thinking': {
          void setStage('thinking');
          if (statusCfg && typeof value === 'string' && value) {
            const preview = value.length > 300 ? value.slice(0, 300) + '…' : value;
            void sendToStatus(`💭 ${preview}`);
          }
          break;
        }

        case 'tool_use': {
          toolCount++;
          void setStage('tool');
          if (statusCfg) {
            const tv = typeof value === 'object' && value !== null ? (value as { name?: string }) : {};
            void sendToStatus(`🔧 ${tv.name ?? 'tool'}`);
          }
          break;
        }

        case 'result':
          void setStage('composing');
          stopWatchdog();
          if (statusCfg) void sendToStatus('✅ Done');
          break;
      }
    },

    onReply(): void {
      sentReply = true;
      stopWatchdog();
    },

    destroy(): void {
      stopWatchdog();
      observers.delete(session.id);
    },
  };

  observers.set(session.id, handle);
}

/** Destroy the observer for a session (called on container exit). */
export function destroySessionObserver(sessionId: string): void {
  observers.get(sessionId)?.destroy();
}

/** Notify the observer that a user-facing reply was delivered (stops watchdog). */
export function notifyObserverReply(sessionId: string): void {
  observers.get(sessionId)?.onReply();
}

/** Feed a raw stderr line from the container to the session observer. */
export function feedObserverLine(sessionId: string, raw: string): void {
  observers.get(sessionId)?.line(raw);
}
