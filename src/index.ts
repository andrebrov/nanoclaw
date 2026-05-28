/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { setIsMainGroupResolver } from './container-runner.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupByPlatform, updateMessagingGroup } from './db/messaging-groups.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  const { initMessageStore } = await import('./message-store.js');
  initMessageStore();

  // 1b. Backfill container_configs from legacy container.json files (incl.
  // fork-specific fields via the extensions column). Idempotent — skips
  // groups that already have a config row.
  backfillContainerConfigs();

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // Wire the main-DM bypass resolver now that the DB is ready. Returns false
  // for any group whose folder isn't 'main', so only the owner's primary DM
  // agent bypasses the concurrency cap on user-facing (default) sessions.
  setIsMainGroupResolver((session) => getAgentGroup(session.agent_group_id)?.folder === 'main');

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          isGroup: message.isGroup,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        // Update the messaging_groups row's `name` and `is_group` once the
        // adapter discovers them. Without this the auto-create path in
        // router.ts uses defaults (name=null, is_group=0), and downstream
        // engage logic — notably mention-sticky — refuses to engage on
        // non-mention follow-up replies because mg.is_group=0 means "DM,
        // sticky doesn't apply". The chat-sdk bridge emits this on first
        // sight of each thread; if no row exists yet, it's a no-op and the
        // following onInbound will auto-create with default 0 (next
        // metadata emission self-heals it).
        const existing = getMessagingGroupByPlatform(adapter.channelType, platformId);
        if (!existing) return;
        const updates: { name?: string; is_group?: number } = {};
        if (name !== undefined && existing.name !== name) updates.name = name;
        if (isGroup !== undefined) {
          const next = isGroup ? 1 : 0;
          if (existing.is_group !== next) updates.is_group = next;
        }
        if (Object.keys(updates).length > 0) {
          updateMessagingGroup(existing.id, updates);
          log.info('Messaging group metadata updated', {
            id: existing.id,
            channelType: adapter.channelType,
            platformId,
            updates,
          });
        }
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
      replyToId?: string | null,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files, replyToId });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 6b. Notify maintenance agents about tasks missed while the host was down.
  // Best-effort — failures inside notifyMissedTasks are already logged.
  void (async () => {
    try {
      const { notifyMissedTasks } = await import('./modules/scheduling/recovery.js');
      const notified = await notifyMissedTasks();
      if (notified > 0) {
        log.info('Missed-task recovery notices sent', { sessions: notified });
      }
    } catch (err) {
      log.warn('Missed-task recovery scan failed', { err });
    }
  })();

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last-resort crash containment. Pre-patch, a single thrown error from
// anywhere in the long-running host (channel adapter callback, sweep
// async hop, delivery poll, MCP gateway response) would propagate up to
// the event loop and exit the process. systemd's RestartLimitBurst=5/300s
// caps that — after 5 such crashes the service goes dead until manual
// intervention. For a personal assistant where uptime beats correctness
// at the host layer (state lives in per-session DBs, not in memory),
// catching here and continuing is the right trade-off. The error is
// fully logged so we don't lose bug surface.
//
// The exception we deliberately do NOT catch is startup failure — that's
// the `main().catch(...)` below. If init can't even finish, restarting
// is the right move because the process can't be sane.
process.on('uncaughtException', (err, origin) => {
  log.error('uncaughtException — continuing', {
    origin,
    message: err.message,
    stack: err.stack,
  });
});
process.on('unhandledRejection', (reason, promise) => {
  log.error('unhandledRejection — continuing', {
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
    promiseString: String(promise),
  });
});

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
