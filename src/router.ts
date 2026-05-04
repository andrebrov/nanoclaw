/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { getChannelAdapter } from './channels/channel-registry.js';
import { gateCommand } from './command-gate.js';
import { checkInboundRateLimit } from './inbound-rate-limiter.js';
import { getAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { resolveOverrides } from './db/config-overrides.js';
import { getDb } from './db/connection.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { startTypingRefresh } from './modules/typing/index.js';
import { startSessionObserver } from './observer.js';
import { log } from './log.js';
import { indexMessage } from './message-store.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import { readContainerConfig } from './container-config.js';
import {
  classifyNeedsAgent,
  getRecentGroupMessages,
  isAddressedToOtherBot,
  isReplyToOurMessage,
  threadHasBotInvolvement,
} from './cost-gate.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Minimal sender-id extraction for the core DM gate (no permissions module).
 * Mirrors the senderId parsing in permissions/index.ts but without the
 * users-table upsert — we only need to know who is knocking, not to create
 * a row for them.
 */
function extractCoreSenderId(event: InboundEvent): string | null {
  const content = safeParseContent(event.message.content);
  const raw = content.senderId ?? content.sender ?? null;
  if (!raw) return null;
  return raw.includes(':') ? raw : `${event.channelType}:${raw}`;
}

/**
 * Core DM-gate trust check. Queries user_roles and agent_group_members
 * directly — no dependency on the optional permissions module.
 * Used only when accessGate is not registered (module absent).
 */
function isDmSenderTrusted(userId: string, agentGroupId: string): boolean {
  const db = getDb();
  const hasRole = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (
           (role = 'owner' AND agent_group_id IS NULL)
           OR (role = 'admin' AND agent_group_id IS NULL)
           OR (role = 'admin' AND agent_group_id = ?)
         )
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  if (hasRole) return true;
  const isMember = db
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!isMember;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Adapter's thread policy. For non-threaded adapters (Telegram,
  // WhatsApp, iMessage, email) we collapse threads at SESSION-RESOLUTION
  // time (one session per group, regardless of topic) but PRESERVE
  // event.threadId on the inbound row so outbound replies route back
  // to the same topic.
  //
  // Previously this stripped event.threadId globally — which made all
  // group messages collapse correctly into one session, but all replies
  // landed in the chat root instead of the topic the user wrote in.
  // Telegram users in forum-mode supergroups saw the agent answering
  // in the general channel even when the conversation was in a topic.
  //
  // The session-resolution shim below uses `sessionThreadId = null` for
  // non-threaded adapters so existing sessions (created with thread_id
  // null) keep matching; messages_in.thread_id keeps the real value so
  // poll-loop's extractRouting picks it up for outbound delivery.
  const adapter = getChannelAdapter(event.channelType);
  const sessionThreadId = adapter && !adapter.supportsThreads ? null : event.threadId;

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam.
  const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. For group chats, auto-create on any message
    // (chatbot mode — no @mention required). For DMs or unknown channel types,
    // only auto-create when the bot was explicitly addressed (@mention / DM).
    if (!isMention && !event.isGroup) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: event.isGroup ? 1 : 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
      isGroup: mg.is_group,
    });

    if (mg.is_group === 1) {
      // Auto-wire new group chats to the Main agent group in chatbot mode.
      // Any message triggers a reply — no manual approval or DB wiring needed.
      const mainGroup = getAgentGroupByFolder('main');
      if (mainGroup) {
        const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createMessagingGroupAgent({
          id: mgaId,
          messaging_group_id: mgId,
          agent_group_id: mainGroup.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: new Date().toISOString(),
        });
        log.info('Auto-wired new group chat to Main', {
          messagingGroupId: mgId,
          agentGroupId: mainGroup.id,
        });
        agentCount = 1;
      } else {
        log.warn('Auto-wire skipped — no agent group with folder="main" found', {
          messagingGroupId: mgId,
        });
        agentCount = 0;
      }
    } else {
      agentCount = 0;
    }
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2a. Rate limit: token-bucket per messaging group. Applies to chat messages
  //     only — scheduled tasks bypass routeInbound entirely (host-sweep writes
  //     them directly to the session DB) so they are naturally exempt.
  const rl = checkInboundRateLimit(mg.id, mg.inbound_rate_limit ?? null);
  if (!rl.allowed) {
    if (rl.firstDrop) {
      void adapter
        ?.deliver(event.platformId, event.threadId, {
          kind: 'chat',
          content: {
            text: 'Too many messages — I am temporarily pausing responses for this chat. Please wait a moment before sending more.',
          },
        })
        .catch((err) => log.warn('rate-limit notice delivery failed', { messagingGroupId: mg.id, err }));
    }
    log.debug('Message dropped — inbound rate limit', { messagingGroupId: mg.id, firstDrop: rl.firstDrop });
    return;
  }

  // 2. Sender resolution. The permissions module registers a full resolver
  //    that upserts the users row so later role lookups find a real record.
  //    Without the module, fall back to a minimal parse so the core DM gate
  //    below can still identify the sender without writing to the DB.
  const userId: string | null = senderResolver ? senderResolver(event) : extractCoreSenderId(event);

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    const engages = evaluateEngage(agent, messageText, isMention, mg, sessionThreadId);

    // Gate evaluation order matters: gates may have side effects (drop-row
    // writes, approval cards). We only run them when the engage decision
    // would otherwise let the message through, to avoid spurious gate work
    // for agents whose engage_mode already declined.
    //
    // When the permissions module is installed it registers a full accessGate.
    // When it is absent, DM channels fall back to a direct DB check so an
    // unknown sender cannot spawn a container just by DMing the bot.
    // Non-DM channels keep the existing allow-all behaviour when ungated.
    let accessAllowed: boolean;
    if (accessGate) {
      accessAllowed = accessGate(event, userId, mg, agent.agent_group_id).allowed;
    } else if (mg.is_group === 0) {
      accessAllowed = userId !== null && isDmSenderTrusted(userId, agent.agent_group_id);
      if (engages && !accessAllowed) {
        recordDroppedMessage({
          channel_type: event.channelType,
          platform_id: event.platformId,
          user_id: userId,
          sender_name: parsed.sender ?? null,
          reason: 'dm_sender_not_authorized',
          messaging_group_id: mg.id,
          agent_group_id: agent.agent_group_id,
        });
        log.warn('DM blocked by core gate — sender not in user_roles or agent_group_members', {
          userId,
          agentGroupId: agent.agent_group_id,
        });
      }
    } else {
      accessAllowed = true;
    }
    const accessOk = engages && accessAllowed;
    const scopeOk = engages && accessOk && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      // Three-stage cost gate (issues #174, #175).
      //
      // Stage 1 (deterministic, microseconds): fast-pass on DMs and explicit
      // @mentions of our bot. For group match-all wirings also check:
      //   • isExplicitNewRequest — short directive or question
      //   • reply-to-our-message — inbound replies to one of our outbound msgs
      //   • thread bot-involvement — we already engaged in this thread
      //   • other-bot skip — message @-mentions only a sibling bot → no wake,
      //     no Stage 2 (clearly not our responsibility)
      //
      // Stage 2 (Haiku classifier, ~$0.003/call): fired only when Stage 1 did
      // not fast-pass AND costGating.enabled=true in container.json. Wraps all
      // user content in <untrusted-input> (OWASP LLM01/LLM08).
      //
      // For all other wirings (mention, mention-sticky, custom pattern) only
      // the existing isExplicitNewRequest heuristic applies (Stage 1 only).

      // Is this wiring a match-all pattern on a group chat? Cost gating only
      // applies to this shape (every-message-triggers pattern in group chats).
      const isMatchAll = mg.is_group !== 0 && agent.engage_mode === 'pattern' && (agent.engage_pattern ?? '.') === '.';
      const costGatingCfg = isMatchAll ? readContainerConfig(agentGroup.folder).costGating : undefined;

      // Fast-pass: DM or explicit @mention of our bot → always wake.
      let wake = mg.is_group === 0 || isMention;

      if (!wake) {
        // Stage 1: existing heuristic (applies to all group wiring types).
        wake = isExplicitNewRequest(messageText);

        // Stage 1 extended checks — match-all group wirings only.
        if (!wake && isMatchAll) {
          // Reply-to-our-message: extract platform reply reference from content.
          let replyToMsgId: string | number | null = null;
          try {
            const rawContent = JSON.parse(event.message.content) as Record<string, unknown>;
            replyToMsgId = (rawContent.replyToMessageId ?? rawContent.reply_to_message_id ?? null) as
              | string
              | number
              | null;
          } catch {
            /* non-JSON content — no reply id */
          }

          if (isReplyToOurMessage(event.channelType, event.platformId, replyToMsgId)) {
            log.debug('Stage 1 gate: reply-to-our-message → wake', { agentGroupId: agent.agent_group_id });
            wake = true;
          } else if (event.threadId && threadHasBotInvolvement(event.channelType, event.platformId, event.threadId)) {
            log.debug('Stage 1 gate: thread bot-involvement → wake', { agentGroupId: agent.agent_group_id });
            wake = true;
          }

          // Other-bot skip: message @-mentions only a sibling bot.
          // Store silently without waking; skip Stage 2 — it's not our message.
          if (!wake) {
            const otherHandles = costGatingCfg?.otherBotHandles ?? [];
            if (otherHandles.length > 0 && isAddressedToOtherBot(messageText, otherHandles)) {
              log.debug('Stage 1 gate: addressed to sibling bot — stored without wake', {
                agentGroupId: agent.agent_group_id,
                text: messageText.slice(0, 80),
              });
              // deliver with wake=false; no Stage 2
              await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false);
              engagedCount++;
              // engage_mode='pattern' so the mention-sticky block below is a no-op;
              // using continue to be explicit about skipping it.
              continue;
            }
          }

          // Stage 2: Haiku classifier.
          if (!wake && costGatingCfg?.enabled) {
            const contextCount = costGatingCfg.contextMessageCount ?? 10;
            const biasNo = (costGatingCfg.classifierBias ?? 'no') === 'no';
            const context = getRecentGroupMessages(event.channelType, event.platformId, contextCount);
            wake = await classifyNeedsAgent(messageText, context, biasNo);
            if (!wake) {
              log.debug('Stage 2 classifier: no bot engagement needed — stored without wake', {
                agentGroupId: agent.agent_group_id,
                text: messageText.slice(0, 120),
              });
            }
          }
        }

        if (!wake) {
          log.debug('Cost gate: context-only message — stored without container wake', {
            agentGroupId: agent.agent_group_id,
            text: messageText.slice(0, 120),
          });
        }
      }

      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, wake);
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Threaded-adapter only; DMs and
      // non-threaded platforms skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.supportsThreads &&
        adapter.subscribe &&
        event.threadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, event.threadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: event.threadId, err });
        });
      }
    } else if (!engages && agent.ignored_message_policy === 'accumulate') {
      // Accumulate ONLY when the engage_mode declined — never when access
      // or scope gates denied. Accumulate stores the message as silent
      // context, but a policy-denied user's message must not leak into
      // the agent's session context just because some other agent on the
      // same MG happens to have accumulate set; those refusals are
      // security decisions about an untrusted sender, and silently
      // storing their message (which also stages their attachments to
      // disk via writeSessionMessage → extractAttachmentFiles) is exactly
      // what the gate is meant to prevent. The access gate already
      // recorded a dropped_messages row for the refusal above.
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false);
      accumulatedCount++;
    } else {
      log.debug('Message not delivered to agent', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Stage 1 gate: deterministic check for explicit new-request intent.
 *
 * Returns true for messages that carry a clear new directive — questions,
 * imperatives, short bursts, or any text that does not open with a known
 * context-only or continuation phrase. Returns false only when the opener
 * unambiguously signals "this is reference material / I'm just continuing"
 * without a directive, which is the pattern that causes repeated no-op
 * container spawns (issue #175).
 *
 * Biases toward true so existing spawn behaviour is preserved for normal
 * messages. DMs and explicit @mentions bypass this gate in the caller.
 *
 * Exported for unit testing.
 */
export function isExplicitNewRequest(text: string): boolean {
  if (!text || !text.trim()) return true;
  const t = text.trim();

  // Very short messages (≤ 5 words) are almost always directives, never dumps.
  if (t.split(/\s+/).length <= 5) return true;

  // Direct questions always indicate a request.
  if (t.includes('?')) return true;

  // "continue from where you left off" and close variants.
  if (/\b(continue|continuing)\s+from\s+(where|the\s+last|where\s+(you|we)\s+left)\b/i.test(t)) return false;
  if (/\bpick(?:ing)?\s+up\s+from\s+(where|the\s+last)\b/i.test(t)) return false;
  if (/\bresume\s+(?:from\s+)?(?:where|the\s+last)\b/i.test(t)) return false;

  // Context / background / reference dump openers without a follow-on directive.
  if (
    /^(?:here(?:'s|\s+is)\s+(?:the\s+|some\s+)?(?:context|background|reference|history|summary|code|file|link|data))/i.test(
      t,
    )
  )
    return false;
  if (
    /^(?:for\s+(?:context|background|(?:your\s+)?reference)|as\s+(?:context|background|(?:per|an?\s+)?update))[,:\s]/i.test(
      t,
    )
  )
    return false;
  if (/^fyi[,:\s]/i.test(t)) return false;

  return true;
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
): Promise<void> {
  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  // Session resolution uses sessionThreadId — null for non-threaded
  // adapters so all topics in a group collapse to one session. The
  // outbound row keeps the real event.threadId via writeSessionMessage
  // below so replies route back to the originating topic.
  const sessionThreadIdForResolve = adapterSupportsThreads ? event.threadId : null;
  const { session, created } = resolveSession(
    agent.agent_group_id,
    mg.id,
    sessionThreadIdForResolve,
    effectiveSessionMode,
  );

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event). When the caller supplied `replyTo` (CLI admin
  // transport acting on operator intent), the reply is redirected there.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  const resolvedOverrides = resolveOverrides(getDb(), mg.id, userId, agent.agent_group_id);
  const emojiMode = mg.emoji_mode ?? 'auto';
  const effectiveOverrides = emojiMode !== 'auto' ? { ...(resolvedOverrides ?? {}), emojiMode } : resolvedOverrides;
  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
    overrides: effectiveOverrides ? JSON.stringify(effectiveOverrides) : null,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  const parsedForIndex = safeParseContent(event.message.content);
  indexMessage({
    messaging_group_id: mg.id,
    channel_type: event.channelType,
    platform_id: event.platformId,
    thread_id: event.threadId,
    direction: 'in',
    kind: event.message.kind,
    sender_user_id: userId,
    sender_name: parsedForIndex.sender ?? null,
    text: parsedForIndex.text ?? null,
    content_json: event.message.content,
    platform_msg_id: event.message.id,
    session_id: session.id,
    agent_group_id: agent.agent_group_id,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
    // Start observer: 👀 reaction + watchdog. Use the original event channel
    // (not deliveryAddr) so reactions land on the message the user sent.
    //
    // Suppress 👀 (and all reaction cycle emojis) when a match-all pattern
    // ('engage_pattern=.') engages on a group message the bot was not
    // explicitly addressed in. In multi-bot group chats this otherwise
    // produces a 👀 on every message — including bot-to-bot conversations
    // that have nothing to do with this agent. Exceptions:
    //   • DMs (is_group=0) — always react, it's a direct conversation
    //   • @mention — the bot was explicitly addressed
    //   • Non-match-all patterns — engagement already implies a trigger hit
    //
    // Match-all wirings in group chats only react when explicitly addressed,
    // even for the Main agent group: chatbot-mode pattern='.' fires on
    // every message, and reacting to every message is spammy. Operators
    // who want eager reactions can flip back via a per-mga override later.
    const isMatchAll = agent.engage_mode === 'pattern' && (agent.engage_pattern ?? '.') === '.';
    const reactOnWake = (mg.react_on_wake ?? 1) !== 0;
    const shouldReact = reactOnWake && (mg.is_group === 0 || event.message.isMention === true || !isMatchAll);
    startSessionObserver(
      session,
      shouldReact ? event.message.id : null,
      event.channelType,
      event.platformId,
      event.threadId,
      agentGroup.folder,
    );
    const freshSession = getSession(session.id);
    if (freshSession) {
      await wakeContainer(freshSession);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
