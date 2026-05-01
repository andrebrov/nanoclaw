import fs from 'fs';
import path from 'path';

import { buildSourceChatBlock, findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  getStoredSessionId,
  setStoredSessionId,
  clearStoredSessionId,
  setTurnReplyTo,
  clearTurnReplyTo,
  setTurnSourceRouting,
  clearTurnSourceRouting,
  getTurnSendInvoked,
  clearTurnSendInvoked,
  clearContinuation,
  migrateLegacyContinuation,
  setContinuation,
  getSeriesContinuation,
  setSeriesContinuation,
  clearSeriesContinuation,
} from './db/session-state.js';
import { scheduleSnapshotWrite, clearSnapshot } from './db/session-snapshot.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isSilenceNarration,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ConfigOverride, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/**
 * Extract the resolved config overrides from the triggering message in a batch.
 * Uses the last trigger=1 message's overrides field; falls back to the last
 * message in the batch. Returns null when no overrides are set.
 */
function extractTurnOverrides(messages: MessageInRow[]): ConfigOverride | null {
  const trigger = [...messages].reverse().find((m) => m.trigger === 1) ?? messages[messages.length - 1];
  if (!trigger?.overrides) return null;
  try {
    return JSON.parse(trigger.overrides) as ConfigOverride;
  } catch {
    return null;
  }
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    // Persist a snapshot of the incoming batch before handing off to the
    // provider. If the container crashes mid-turn, the next startup loads
    // this file and injects it into the system prompt so the agent knows
    // what was in-flight. Debounced to absorb rapid message bursts.
    scheduleSnapshotWrite(messages);

    const routing = extractRouting(messages);

    // Publish the triggering message ID so MCP send_message can default
    // in_reply_to correctly without the agent tracking it manually.
    if (routing.inReplyTo) {
      setTurnReplyTo(routing.inReplyTo);
    } else {
      clearTurnReplyTo();
    }

    // Publish the source channel so send_message defaults to the channel the
    // triggering message came from (e.g. a group chat), not the session's
    // bound default (e.g. a DM). Mirrors the dispatchResultText behaviour for
    // plain text so both paths route consistently.
    setTurnSourceRouting(routing.channelType, routing.platformId, routing.threadId);

    // Reset the per-turn send flag so a fresh turn starts clean.
    clearTurnSendInvoked();

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearStoredSessionId();
        clearSnapshot();
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    // Determine the series ID for task batches. Recurring tasks share a stable
    // series_id across fires (set to the original task id on creation and carried
    // forward by the recurrence fanout). One-shot tasks have series_id === id, so
    // they each get a unique per-series key — effectively the same fresh-session
    // behaviour as before. Different task series (e.g. heartbeat vs prospecting)
    // use different keys, preventing cross-task session contamination.
    const taskMessages = keep.filter((m) => m.kind === 'task');
    const isTaskBatch = taskMessages.length > 0;
    const batchSeriesId = isTaskBatch ? (taskMessages[0].series_id ?? taskMessages[0].id) : null;

    // Resolve the continuation to resume. Task batches use the per-series slot so
    // each recurring task resumes its own prior SDK session rather than always
    // starting from scratch (which causes a full cache_create on every fire).
    // Chat batches use the global per-provider continuation as before.
    let batchContinuation: string | undefined;
    if (batchSeriesId !== null) {
      batchContinuation = getSeriesContinuation(config.providerName, batchSeriesId);
    } else {
      batchContinuation = continuation;
    }

    // Callback written at SDK init time (before the first result) so a container
    // crash mid-turn still persists the continuation for the next wake.
    const onContinuationReady =
      batchSeriesId !== null
        ? (id: string) => setSeriesContinuation(config.providerName, batchSeriesId, id)
        : (id: string) => setContinuation(config.providerName, id);

    // Per-turn source-chat block tells the agent which chat triggered this
    // batch. Without it, agents juggling multi-chat workflows confuse the
    // current trigger with task notes from an earlier conversation in a
    // different chat (e.g. routing replies to a DM destination from a
    // group-chat trigger).
    const sourceBlock = buildSourceChatBlock(routing);
    const turnSystemContext = sourceBlock
      ? {
          ...config.systemContext,
          instructions: [config.systemContext?.instructions, sourceBlock].filter(Boolean).join('\n\n'),
        }
      : config.systemContext;

    // Extract config overrides from the triggering message (highest-priority
    // trigger=1 row in the batch, or the last message if none). The host
    // stamps resolved channel+user overrides onto each message at routing time.
    const turnOverrides = extractTurnOverrides(keep);

    const query = config.provider.query({
      prompt,
      continuation: batchContinuation,
      cwd: config.cwd,
      systemContext: turnSystemContext,
      isScheduledTask: keep.every((m) => m.kind === 'task'),
      overrides: turnOverrides ?? undefined,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    let queryError: unknown = null;
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        prompt,
        config.providerName,
        onContinuationReady,
      );
      if (result.clearContinuation) {
        if (batchSeriesId !== null) {
          clearSeriesContinuation(config.providerName, batchSeriesId);
        } else {
          log('Clearing continuation anchor (thinking-only result)');
          continuation = undefined;
          clearStoredSessionId();
        }
      } else if (result.continuation) {
        if (batchSeriesId !== null) {
          setSeriesContinuation(config.providerName, batchSeriesId, result.continuation);
        } else if (result.continuation !== continuation) {
          continuation = result.continuation;
          setContinuation(config.providerName, continuation);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error (attempt 1/2): ${errMsg}`);

      // Stale/corrupt continuation recovery: clear it before the retry so the
      // fresh attempt doesn't resume a broken session.
      if (config.provider.isSessionInvalid(err)) {
        if (batchSeriesId !== null && batchContinuation) {
          log(`Stale task session detected (series: ${batchSeriesId}) — clearing for retry`);
          clearSeriesContinuation(config.providerName, batchSeriesId);
          batchContinuation = undefined;
        } else if (continuation) {
          log(`Stale session detected (${continuation}) — clearing for retry`);
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      }

      // Single automatic retry with a fresh session.
      try {
        const retryQuery = config.provider.query({
          prompt,
          continuation: undefined,
          cwd: config.cwd,
          systemContext: turnSystemContext,
          isScheduledTask: keep.every((m) => m.kind === 'task'),
        });
        const onContinuationReadyRetry =
          batchSeriesId !== null
            ? (id: string) => setSeriesContinuation(config.providerName, batchSeriesId, id)
            : (id: string) => {
                setContinuation(config.providerName, id);
                setStoredSessionId(id);
              };
        const retryResult = await processQuery(
          retryQuery,
          routing,
          processingIds,
          prompt,
          config.providerName,
          onContinuationReadyRetry,
        );
        if (retryResult.clearContinuation) {
          if (batchSeriesId !== null) {
            clearSeriesContinuation(config.providerName, batchSeriesId);
          } else {
            continuation = undefined;
            clearStoredSessionId();
          }
        } else if (retryResult.continuation) {
          if (batchSeriesId !== null) {
            setSeriesContinuation(config.providerName, batchSeriesId, retryResult.continuation);
          } else {
            continuation = retryResult.continuation;
            setStoredSessionId(continuation);
          }
        }
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`RETRY ALSO FAILED — giving up: ${retryErrMsg}`);
        queryError = retryErr;
      }
    }

    if (queryError) {
      const errMsg = queryError instanceof Error ? queryError.message : String(queryError);
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    clearTurnReplyTo();
    clearTurnSourceRouting();
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
  clearContinuation?: boolean;
}

/**
 * Write a checkpoint stub so the host (and next session) know why the
 * container exited. If the agent already wrote a ## Reasoning section
 * (from threshold_warn), that content is preserved.
 * Exit code 75 (EX_TEMPFAIL) tells the host this was a planned nuke,
 * not a crash — future orchestrator work can trigger Facts writing +
 * container restart on that code.
 */
function writeNukeCheckpoint(tokens: number, transcriptPath: string, cwd: string): void {
  const checkpointDir = path.join(cwd, '.checkpoints');
  const checkpointPath = path.join(checkpointDir, 'default.md');
  try {
    fs.mkdirSync(checkpointDir, { recursive: true });

    // Rotate existing checkpoint (agent may have written ## Reasoning in it)
    if (fs.existsSync(checkpointPath)) {
      fs.copyFileSync(checkpointPath, path.join(checkpointDir, 'previous.md'));
    }

    // Read existing content so we keep agent's ## Reasoning if present
    let existing = '';
    try {
      existing = fs.readFileSync(checkpointPath, 'utf-8');
    } catch {
      /* new file */
    }

    const timestamp = new Date().toISOString();
    const contextPct = Math.round(
      (tokens / parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_WINDOW || '200000', 10)) * 100,
    );
    const metadata = [
      `<!-- nuke: ${timestamp} | tokens: ${tokens.toLocaleString()} (${contextPct}%) | transcript: ${transcriptPath} -->`,
    ].join('\n');

    // Prepend metadata marker; preserve existing reasoning content below
    const content = existing.trim()
      ? `${metadata}\n\n${existing.trim()}\n`
      : `${metadata}\n\n## Reasoning\n\n*Session ended at context threshold. No reasoning checkpoint was written before nuke.*\n`;

    fs.writeFileSync(checkpointPath, content, 'utf-8');
    log(`Nuke checkpoint written: ${checkpointPath} (${contextPct}% context used)`);
  } catch (err) {
    log(`Failed to write nuke checkpoint: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  prompt: string,
  providerName: string,
  onContinuationReady?: (id: string) => void,
): Promise<QueryResult> {
  // Provider-agnostic query lifecycle signals for the host observer.
  // claude.ts also emits these from within translateEvents(), but emitting
  // here covers non-Claude providers and gives an earlier query_start
  // timestamp (before the SDK subprocess even spawns).
  process.stderr.write('observer:query_start=1\n');

  let queryContinuation: string | undefined;
  let clearContinuation = false;
  let done = false;

  // Replay buffer for compaction recovery. SDK auto-compaction wipes the
  // turn's prior messages and replaces them with a summary; the agent must
  // be re-prompted to actually answer post-compaction. Track every prompt
  // we sent (initial + follow-ups pushed by the active poll) so the
  // recovery path replays all of them, not just the initial batch.
  const pushedPrompts: string[] = [prompt];

  // IDs of follow-up messages pushed mid-query. Marked completed at the
  // query boundary (finally block) rather than immediately after push —
  // if the container crashes mid-turn, they stay in 'processing' state and
  // clearStaleProcessingAcks() on the next startup can reset them for retry.
  const pushedIds: string[] = [];

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open is
  // strictly cheaper than close+reopen (no cold prompt cache, no reconnect).
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  const pollHandle = setInterval(() => {
    if (done) return;

    // Skip system messages (MCP tool responses) and /clear (needs fresh query).
    // Thread routing is the router's concern — if a message landed in this
    // session, the agent should see it. Per-thread sessions already isolate
    // threads into separate containers; shared sessions intentionally merge
    // everything. Filtering on thread_id here caused deadlocks when the
    // initial batch and follow-ups had mismatched thread_ids (e.g. a
    // host-generated welcome trigger with null thread vs a Discord DM reply).
    //
    // Guard the entire poll body: tests can tear down the session DB while
    // an interval is still scheduled (Bun fires intervals through the
    // microtask queue even after `clearInterval`). Without this, a
    // post-teardown poll throws "SQLiteError: unable to open database
    // file" inside getPendingMessages → bun:test reports an "Unhandled
    // error between tests" → CI Container-tests step fails despite all
    // assertions passing. In production the DB is always open, so the
    // catch is a pure test-stability guard.
    try {
      const newMessages = getPendingMessages().filter((m) => {
        if (m.kind === 'system') return false;
        if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
        return true;
      });
      if (newMessages.length > 0) {
        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        const followUp = formatMessages(newMessages);
        log(`Pushing ${newMessages.length} follow-up message(s) into active query`);
        query.push(followUp);
        pushedPrompts.push(followUp);
        pushedIds.push(...newIds);
      }
    } catch (err) {
      // Most likely the session DB was closed under us (test teardown).
      // Production sees this only on session-manager bugs we'd want to
      // hear about, so log at warn rather than swallowing silently.
      log(`active-poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        if (onContinuationReady) {
          onContinuationReady(event.continuation);
        } else {
          setContinuation(providerName, event.continuation);
        }
      } else if (event.type === 'result') {
        // Write the reply to messages_out BEFORE marking the batch completed
        // in processing_ack. If the container crashes between the two writes,
        // processing_ack stays 'processing' and the host sweep's crash-recovery
        // path (resetStuckProcessingRows) can reset the message for retry. With
        // the reverse order, the message would be marked complete with no reply
        // in messages_out, silently dropping it. Both writes are synchronous
        // SQLite calls so the window between them is negligible in normal
        // operation — only a crash scenario is affected.
        //
        // Duplicate suppression: if send_message or send_file already delivered
        // a reply this turn, the SDK still surfaces the agent's closing text as
        // a Result. Sending it would produce a second message. Log it but skip
        // delivery. add_reaction does NOT set this flag — reaction + closing
        // summary is a valid reply path.
        if (event.thinkingOnly) {
          // Model produced only thinking blocks — clear continuation so the
          // next turn starts fresh rather than resuming a stuck session.
          log('Thinking-only result: clearing continuation anchor');
          clearStoredSessionId();
          queryContinuation = undefined;
          clearContinuation = true;
        }
        if (event.text) {
          if (getTurnSendInvoked()) {
            log(`Suppressing result text (send already fired this turn): ${event.text.slice(0, 200)}`);
          } else {
            dispatchResultText(event.text, routing);
          }
        }
        markCompleted(initialBatchIds);
      } else if (event.type === 'threshold_warn') {
        const contextPct = Math.round(
          (event.tokens / parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_WINDOW || '200000', 10)) * 100,
        );
        log(`Context threshold warn: ${event.tokens.toLocaleString()} tokens (${contextPct}%)`);
        // Ask the agent to write a reasoning checkpoint while still coherent.
        query.push(
          `<system-reminder>Context window is ${contextPct}% full (${event.tokens.toLocaleString()} tokens). ` +
            `Please write a brief reasoning checkpoint to /workspace/agent/.checkpoints/default.md ` +
            `with a ## Reasoning section: current task, key decisions made, important context to preserve. ` +
            `Be concise — this is used to restore context if the session must restart. ` +
            `Create the .checkpoints directory if needed.</system-reminder>`,
        );
      } else if (event.type === 'threshold_nuke') {
        const contextPct = Math.round(
          (event.tokens / parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_WINDOW || '200000', 10)) * 100,
        );
        log(
          `Context threshold nuke: ${event.tokens.toLocaleString()} tokens (${contextPct}%) — checkpointing and exiting`,
        );
        writeNukeCheckpoint(event.tokens, event.transcriptPath, '/workspace/agent');
        // Wipe the stored session ID so the next container starts a fresh
        // session instead of resuming this full-context one. Without this,
        // the next spawn would resume the same high-context transcript, hit
        // the threshold again on the first reply, and loop indefinitely.
        clearStoredSessionId();
        // Exit code 75 (EX_TEMPFAIL): planned nuke, not a crash.
        // Host orchestrator can watch for this code to trigger Facts writing + restart.
        process.exit(75);
      } else if (event.type === 'compaction') {
        // SDK auto-compact fired (window set to 9M so this should not happen
        // in practice). Compaction wipes the turn's prior messages and
        // replaces them with a summary, so we must re-submit every prompt
        // we sent so the agent answers them post-compaction. Replaying just
        // the initial batch would silently drop any follow-up that arrived
        // mid-turn via the active-poll push above.
        log(`Compaction event: ${event.message} — replaying ${pushedPrompts.length} pushed prompt(s)`);
        for (const p of pushedPrompts) {
          query.push(p);
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
    process.stderr.write('observer:query_done=1\n');
    // Drain at query boundary: mark all follow-ups pushed mid-turn completed now
    // that the query has ended (normally or via exception). Deferring this from
    // the push site means a container crash leaves them in 'processing' state,
    // so clearStaleProcessingAcks() on the next startup can reset them for retry.
    if (pushedIds.length > 0) {
      markCompleted(pushedIds);
    }
  }

  return { continuation: queryContinuation, clearContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'compaction':
      log(`Compaction: ${event.message}`);
      break;
    case 'threshold_warn':
      log(`Threshold warn: ${event.tokens.toLocaleString()} tokens`);
      break;
    case 'threshold_nuke':
      log(`Threshold nuke: ${event.tokens.toLocaleString()} tokens`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  // Suppress silence-narration placeholders. Per container/CLAUDE.md the
  // agent must output NOTHING when a message doesn't need a response. If
  // it accidentally typed "[silence]", "*stays silent*", "no response
  // needed", etc. as plain text (no <internal> wrapping), don't deliver
  // it to the channel — it just makes the bot look broken.
  if (sent === 0 && scratchpad && isSilenceNarration(scratchpad)) {
    log(`Suppressing silence-narration placeholder: ${scratchpad}`);
    return;
  }

  // Single-destination shortcut: the agent wrote plain text — send to
  // the session's originating channel (from session_routing) if available,
  // otherwise fall back to the single destination.
  if (sent === 0 && scratchpad) {
    if (routing.channelType && routing.platformId) {
      // Reply to the channel/thread the message came from
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Inherit thread_id from the inbound routing context so replies land in the
  // same thread the conversation is in. For non-threaded adapters the router
  // strips thread_id at ingest, so this will already be null.
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
