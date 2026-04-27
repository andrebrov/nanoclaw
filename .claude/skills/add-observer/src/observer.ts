/**
 * Observer — streams thinking blocks and tool calls from a container to a
 * configured status channel during long agent queries.
 *
 * The container emits `observer:`-prefixed lines to stderr; this module
 * receives them (via container-runner.ts's stderr handler), interprets the
 * events, and forwards them to the configured status channel using the
 * delivery adapter. A watchdog timer alternates ⚡/🔥 emojis and sends
 * escalating pings if no completion event arrives.
 *
 * Config (container.json for the observed group):
 *   {
 *     "observer": {
 *       "statusChannelId": "<platform-specific channel / chat ID>",
 *       "statusChannelType": "telegram",   // or "discord", "slack", etc.
 *       "statusThreadId": null             // optional thread
 *     }
 *   }
 */
import { readContainerConfig } from './container-config.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';

const WATCHDOG_TICK_MS = 30_000;
const PING_THRESHOLDS_MS = [60_000, 120_000, 300_000];
const WATCHDOG_EMOJIS = ['⚡', '🔥'];

interface ObserverConfig {
  statusChannelId: string;
  statusChannelType: string;
  statusThreadId?: string | null;
}

export interface ObserverHandle {
  /** Feed a raw stderr line. Lines prefixed with `observer:` are parsed. */
  line(raw: string): void;
  /** Cancel the watchdog when the container exits. */
  destroy(): void;
}

/**
 * Create an observer for the given agent group, or return null if the
 * group's container.json has no `observer` config.
 */
export function createObserver(agentGroupFolder: string): ObserverHandle | null {
  const config = readContainerConfig(agentGroupFolder);
  const obs = (config as unknown as Record<string, unknown>).observer as ObserverConfig | undefined;
  if (!obs?.statusChannelId || !obs?.statusChannelType) return null;

  const { statusChannelId, statusChannelType, statusThreadId } = obs;

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let queryStartMs: number | null = null;
  let emojiIndex = 0;
  let pingsFired = 0;

  async function send(text: string): Promise<void> {
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    try {
      await adapter.deliver(
        statusChannelType,
        statusChannelId,
        statusThreadId ?? null,
        'chat',
        JSON.stringify({ text }),
      );
    } catch (err) {
      log.debug('Observer: delivery failed', { err });
    }
  }

  function tick(): void {
    if (queryStartMs === null) return;
    const elapsed = Date.now() - queryStartMs;
    const emoji = WATCHDOG_EMOJIS[emojiIndex % WATCHDOG_EMOJIS.length];
    emojiIndex++;
    const nextPingMs = PING_THRESHOLDS_MS[pingsFired];
    if (nextPingMs !== undefined && elapsed >= nextPingMs) {
      void send(`${emoji} Still working… (${Math.round(elapsed / 1000)}s)`);
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

  return {
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
          startWatchdog();
          break;
        case 'thinking': {
          if (typeof value !== 'string' || !value) break;
          const preview = value.length > 300 ? value.slice(0, 300) + '…' : value;
          void send(`💭 ${preview}`);
          break;
        }
        case 'tool_use': {
          const tv = typeof value === 'object' && value !== null ? (value as { name?: string }) : {};
          void send(`🔧 ${tv.name ?? 'tool'}`);
          break;
        }
        case 'result':
          stopWatchdog();
          void send('✅ Done');
          break;
      }
    },
    destroy(): void {
      stopWatchdog();
    },
  };
}
