import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { evaluateInReplyToGroupGate } from '../hooks/inreplyto-group-validator.js';
import { gateLinkedInPostCommand } from '../hooks/linkedin-post-validator.js';
import { createLoopDetectionGate } from '../hooks/loop-detection.js';
import { isSubagentTool, parseSubagentLimit, SUBAGENT_TOOL, SubagentLimitTracker } from '../hooks/subagent-limit.js';
import { createMiddlewareHook } from '../hooks/middleware-chain.js';
import { repairDanglingToolCalls } from '../hooks/dangling-tool-call-recovery.js';
import type { MiddlewareChain } from '../config.js';
import { getSessionTrustLevel } from '../db/session-routing.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Workspace sub-paths the agent must not echo back to untrusted-origin turns.
// A message from a public channel (unknown_sender_policy='public') could contain
// prompt-injection that forces the agent to read and forward private data.
const SENSITIVE_PATH_PREFIXES = [
  '/workspace/memory/',
  '/workspace/agent/memory/',
  '/workspace/agent/pending-followups/',
];

function isSensitiveWorkspacePath(p: string): boolean {
  const normalized = p.replace(/\/+$/, '');
  return SENSITIVE_PATH_PREFIXES.some((prefix) => {
    const base = prefix.slice(0, -1); // strip trailing slash
    return normalized === base || normalized.startsWith(base + '/');
  });
}

// Cached session trust level — read once per container start-up.
// Trust level is a property of the session's messaging_group and does not
// change while the container is running.
let sessionTrustLevel: 'trusted' | 'untrusted' | null = null;
function resolveSessionTrustLevel(): 'trusted' | 'untrusted' {
  if (sessionTrustLevel === null) {
    try {
      sessionTrustLevel = getSessionTrustLevel();
    } catch {
      sessionTrustLevel = 'trusted';
    }
  }
  return sessionTrustLevel;
}

// Safe default tools: read-only filesystem access + agent communication.
// These are available to every agent regardless of allowedCapabilities.
// MCP-tool entries are derived at the call site from the registered `mcpServers`
// map so that any server added via `add_mcp_server` (or wired in container.json
// directly) is reachable to the agent — without this, the SDK's allowedTools
// filter silently drops every MCP namespace not listed here.
const BASE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Task',
  'Agent',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'mcp__nanoclaw__*',
];

// Tools unlocked by explicit capability grants in container.json.
const CAPABILITY_TOOLS: Record<string, string[]> = {
  shell_exec: ['Bash'],
  file_write: ['Write', 'Edit', 'NotebookEdit'],
  network: ['WebSearch', 'WebFetch'],
};

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

// ── Observer side channel ──

/**
 * Parse OBSERVER_CHAT_JID env var ("channel_type:platform_id").
 * Returns null when unset or malformed — observer is disabled by default.
 */
function parseObserverJid(): { channelType: string; platformId: string } | null {
  const jid = process.env.OBSERVER_CHAT_JID;
  if (!jid) return null;
  const colonIdx = jid.indexOf(':');
  if (colonIdx <= 0) {
    log(`OBSERVER_CHAT_JID "${jid}" must be "channel_type:platform_id" — observer disabled`);
    return null;
  }
  // platform_id in messaging_groups stores the full prefixed form ("telegram:-12345"),
  // so keep the JID intact rather than stripping the channel prefix.
  return { channelType: jid.slice(0, colonIdx), platformId: jid };
}

const OBSERVER = parseObserverJid();

/** Max characters per observer thinking chunk before splitting into multiple messages. */
const OBSERVER_CHUNK_SIZE = 2000;

/**
 * Write a message to the observer chat via the outbound DB.
 * Swallows errors so observer failures never affect the main query.
 */
function sendObserverMessage(text: string): void {
  if (!OBSERVER) return;
  try {
    writeMessageOut({
      id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'chat',
      channel_type: OBSERVER.channelType,
      platform_id: OBSERVER.platformId,
      content: JSON.stringify({ text }),
    });
  } catch (err) {
    log(`Observer send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build the tool allowlist for a given capability set.
 * Returns BASE_TOOLS plus any extra tools unlocked by the granted capabilities,
 * plus dynamic MCP server patterns derived from the registered mcpServers map.
 */
export function buildToolAllowlist(allowedCapabilities: string[], mcpServers: Record<string, unknown> = {}): string[] {
  const extra = allowedCapabilities.flatMap((cap) => CAPABILITY_TOOLS[cap] ?? []);
  const mcpPatterns = Object.keys(mcpServers).map(mcpAllowPattern);
  return [...BASE_TOOLS, ...extra, ...mcpPatterns];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook factory. Records the current tool + its declared timeout
 * so the host sweep can widen its stuck tolerance while Bash is running a
 * long-declared script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips
 * through somehow, block the call here instead of letting the agent hang.
 *
 * When `linkedinPostValidator` is true, Bash commands matching the
 * LinkedIn-posting patterns are also routed through the merchant-advocate
 * gate before they execute (see ../hooks/linkedin-post-validator.ts).
 *
 * When `loopDetection` is set, a rolling-hash guard checks every tool call
 * against the last N calls and blocks repeated identical sequences
 * (see ../hooks/loop-detection.ts).
 */
function createPreToolUseHook(options: {
  linkedinPostValidator: boolean;
  loopDetection: false | { windowSize?: number; repeatThreshold?: number };
  subagentLimitTracker?: SubagentLimitTracker;
}): HookCallback {
  const loopGate = options.loopDetection !== false ? createLoopDetectionGate(options.loopDetection) : null;

  return async (input) => {
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
    const toolName = i.tool_name ?? '';
    if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
      return {
        decision: 'block',
        stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
      } as unknown as ReturnType<HookCallback>;
    }
    if (options.subagentLimitTracker && isSubagentTool(toolName)) {
      const stopReason = options.subagentLimitTracker.intercept();
      if (stopReason) {
        log(`[subagent-limit] blocking ${toolName} call: ${stopReason}`);
        return { decision: 'block', stopReason } as unknown as ReturnType<HookCallback>;
      }
    }
    // LLM06 guard: block reads of sensitive workspace paths when the session
    // channel is public (anyone-can-post). A prompt injection in such a message
    // could otherwise force the agent to read and forward private memory or
    // pending-followup files back to the attacker's chat.
    if (resolveSessionTrustLevel() === 'untrusted' && (toolName === 'Read' || toolName === 'Grep')) {
      const pathArg =
        toolName === 'Read'
          ? (i.tool_input?.file_path as string | undefined)
          : (i.tool_input?.path as string | undefined);
      if (pathArg && isSensitiveWorkspacePath(pathArg)) {
        log(`[security/LLM06] Blocked ${toolName} on sensitive path "${pathArg}" (untrusted session origin)`);
        return {
          decision: 'block',
          stopReason:
            'Reading sensitive workspace paths (memory/, pending-followups/) is not permitted when responding to messages from public (untrusted) channels.',
        } as unknown as ReturnType<HookCallback>;
      }
    }
    if (toolName === 'send_message') {
      const decision = evaluateInReplyToGroupGate(i.tool_input);
      if (decision.block) {
        log(`[inreplyto-group] blocking send_message to "${decision.destination.name}" — group chat without inReplyTo`);
        return {
          decision: 'block',
          stopReason: decision.reason,
        } as unknown as ReturnType<HookCallback>;
      }
    }
    if (options.linkedinPostValidator && toolName === 'Bash') {
      const cmd = typeof i.tool_input?.command === 'string' ? (i.tool_input.command as string) : '';
      if (cmd) {
        const decision = await gateLinkedInPostCommand(cmd);
        if ('block' in decision && decision.block) {
          return {
            decision: 'block',
            stopReason: decision.reason,
          } as unknown as ReturnType<HookCallback>;
        }
      }
    }
    if (loopGate) {
      const decision = loopGate(toolName, i.tool_input);
      if (decision.block) {
        return {
          decision: 'block',
          stopReason: decision.reason,
        } as unknown as ReturnType<HookCallback>;
      }
    }
    // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
    // tool: no declared timeout.
    const declaredTimeoutMs =
      toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
    try {
      setContainerToolInFlight(toolName, declaredTimeoutMs);
    } catch (err) {
      log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { continue: true };
  };
}

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Reset the sub-agent turn counter on PostToolBatch (before the next model request). */
function createPostToolBatchHook(tracker: SubagentLimitTracker): HookCallback {
  return async () => {
    tracker.reset();
    return { continue: true };
  };
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find(
            (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
          )?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(
        path.join(conversationsDir, filename),
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Context threshold detection ──

/**
 * Set a large window so SDK auto-compact never fires at normal usage.
 * Threshold-based nuke (below) replaces SDK compaction with deterministic
 * checkpointing and clean container restart.
 * Configurable via AGENT_AUTO_COMPACT_WINDOW or CLAUDE_CODE_AUTO_COMPACT_WINDOW
 * env variables (AGENT_AUTO_COMPACT_WINDOW takes precedence).
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW =
  process.env.AGENT_AUTO_COMPACT_WINDOW ?? process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? '9000000';

/**
 * Context window size from env (Opus 4.7[1m] uses 1M, Sonnet 4.6 uses 200K).
 * The orchestrator sets CLAUDE_CODE_MAX_CONTEXT_WINDOW at spawn time.
 */
const CONTEXT_WINDOW_TOKENS = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_WINDOW || '200000', 10);

/**
 * Warn when context reaches 70% (or leaves 50K headroom if smaller).
 * At warn: agent is still coherent enough to write a useful checkpoint.
 */
const THRESHOLD_WARN_TOKENS = Math.max(Math.floor(CONTEXT_WINDOW_TOKENS * 0.7), CONTEXT_WINDOW_TOKENS - 50000);

/**
 * Nuke when context reaches 80% (or leaves 25K headroom if smaller).
 * At nuke: container exits with code 75 so host can restart with checkpoint.
 */
const THRESHOLD_NUKE_TOKENS = Math.max(Math.floor(CONTEXT_WINDOW_TOKENS * 0.8), CONTEXT_WINDOW_TOKENS - 25000);

/**
 * Claude Code SDK stores sessions at /home/node/.claude/projects/<slug>/<id>.jsonl
 * where slug = cwd path with leading slash removed and interior slashes → dashes.
 * For cwd=/workspace/agent this is '-workspace-agent'.
 */
const CLAUDE_PROJECT_SLUG = '-workspace-agent';

/**
 * Read the most recent cumulative input token count from the session transcript.
 * Returns 0 if the file is missing or has no usage data.
 */
function readLatestTokens(transcriptPath: string): number {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    // Scan from end — the last assistant message has the highest token count.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const tokens = entry.message?.usage?.input_tokens;
        if (typeof tokens === 'number' && tokens > 0) return tokens;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* file not found */
  }
  return 0;
}

// ── Thinking-only end_turn detection ──

/**
 * Returns true when the SDK result message represents a thinking-only end_turn:
 * the model produced thinking blocks but no text output. The caller should
 * clear the continuation anchor so the next turn starts fresh instead of
 * resuming a session that will loop on empty replies.
 */
export function isThinkingOnlyEndTurn(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  return (
    m.type === 'result' &&
    m.subtype === 'success' &&
    m.stop_reason === 'end_turn' &&
    typeof m.result === 'string' &&
    m.result.trim() === ''
  );
}

// ── System-prompt resolution ──

/**
 * Build the `systemPrompt` option for sdkQuery from the base instructions and
 * any per-turn append override.
 *
 * When instructions is a plain string the SDK receives it via the `append`
 * field of the `preset` form — no cache_control markup is added, so prompt
 * caching for this block is controlled by the SDK / Claude Code layer rather
 * than by the caller.
 */
export function resolveSystemPrompt(
  baseInstructions: string | undefined,
  systemPromptAppend: string | undefined,
): { type: 'preset'; preset: 'claude_code'; append: string } | undefined {
  const parts = [baseInstructions, systemPromptAppend].filter((s): s is string => Boolean(s));
  if (parts.length === 0) return undefined;
  return { type: 'preset', preset: 'claude_code', append: parts.join('\n\n') };
}

// ── Provider ──

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private toolAllowlist: string[];
  private model: string | undefined;
  private effort?: string;
  private preToolUseHook: HookCallback;
  private postToolBatchHook: HookCallback | undefined;
  private middlewareChain: MiddlewareChain;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.toolAllowlist = buildToolAllowlist(options.allowedCapabilities ?? [], options.mcpServers ?? {});
    const loopDetectionOpt = options.loopDetection;
    const loopDetection: false | { windowSize?: number; repeatThreshold?: number } =
      loopDetectionOpt === true
        ? {}
        : loopDetectionOpt && typeof loopDetectionOpt === 'object'
          ? loopDetectionOpt
          : false;
    // Per-group container.json config takes precedence over the global env var.
    const subagentLimit = options.subagentLimit ?? parseSubagentLimit();
    const subagentLimitTracker = subagentLimit !== undefined ? new SubagentLimitTracker(subagentLimit) : undefined;
    if (subagentLimitTracker) {
      const source = options.subagentLimit !== undefined ? 'container.json' : 'env';
      log(`SubagentLimit enabled: max ${subagentLimit} Task spawn(s) per model turn (source: ${source})`);
    }
    this.preToolUseHook = createPreToolUseHook({
      linkedinPostValidator: options.linkedinPostValidator === true,
      loopDetection,
      subagentLimitTracker,
    });
    this.postToolBatchHook = subagentLimitTracker ? createPostToolBatchHook(subagentLimitTracker) : undefined;
    this.middlewareChain = options.middlewareChain ?? {};
    this.effort = options.effort;
    // Force-merge ANTHROPIC_API_KEY (and other auth env) explicitly. The
    // Claude Agent SDK does NOT auto-forward process.env to the claude
    // subprocess — it spawns with a filtered/sanitized env. Symptom when
    // missing: claude subprocess returns "Not logged in · Please run
    // /login" as a successful result event, on every push, regardless
    // of bun process.env or container docker-run env.
    // We pull from process.env directly here so the values picked up
    // are whatever the container was started with (host-side passthrough
    // adds them via -e ANTHROPIC_API_KEY=...).
    this.env = {
      ...(options.env ?? {}),
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
    const rawModel = process.env.AGENT_MODEL?.trim();
    this.model = rawModel || undefined;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    // Repair dangling tool calls before resuming so the model doesn't refuse
    // to continue a session interrupted mid-tool-loop (crash/nuke/compaction).
    if (input.continuation) {
      repairDanglingToolCalls(`/home/node/.claude/projects/${CLAUDE_PROJECT_SLUG}/${input.continuation}.jsonl`);
    }

    const stream = new MessageStream();
    stream.push(input.prompt);

    // Apply per-turn overrides on top of the group's static config.
    const ov = input.overrides;
    const effectiveModel = ov?.model?.trim() || this.model;
    const effectiveTools = ov?.allowedTools
      ? [...new Set([...this.toolAllowlist, ...ov.allowedTools])]
      : this.toolAllowlist;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: resolveSystemPrompt(input.systemContext?.instructions, ov?.systemPromptAppend),
        allowedTools: effectiveTools,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: effectiveModel,
        ...(ov?.maxTokens !== undefined ? { maxTokens: ov.maxTokens } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(this.effort !== undefined ? { effort: this.effort as any } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        // Opus 4.7 flipped the thinking display default to 'omitted', silencing
        // thinking blocks in the transcript and observer output. Pin to
        // 'summarized' so thinking is always visible when the model uses it.
        thinking: { type: 'adaptive', display: 'summarized' },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                this.preToolUseHook,
                ...(this.middlewareChain.PreToolUse?.length
                  ? [createMiddlewareHook(this.middlewareChain.PreToolUse)]
                  : []),
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                postToolUseHook,
                ...(this.middlewareChain.PostToolUse?.length
                  ? [createMiddlewareHook(this.middlewareChain.PostToolUse)]
                  : []),
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                postToolUseHook,
                ...(this.middlewareChain.PostToolUseFailure?.length
                  ? [createMiddlewareHook(this.middlewareChain.PostToolUseFailure)]
                  : []),
              ],
            },
          ],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
          ...(this.postToolBatchHook ? { PostToolBatch: [{ hooks: [this.postToolBatchHook] }] } : {}),
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      // Observer is disabled for scheduled tasks (silent maintenance runs) and when unconfigured.
      const observerEnabled = !!(OBSERVER && !input.isScheduledTask);
      let messageCount = 0;
      let sessionId: string | undefined;
      let transcriptPath: string | undefined;
      let warnEmitted = false;
      let nukeEmitted = false;
      // Track tool_use_ids forwarded to the observer so tool_progress duplicates are skipped.
      const reportedToolUseIds = new Set<string>();

      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          transcriptPath = `/home/node/.claude/projects/${CLAUDE_PROJECT_SLUG}/${sessionId}.jsonl`;
          // Always emit to stderr so the host-side observer can start its watchdog.
          process.stderr.write('observer:query_start=1\n');
          yield { type: 'init', continuation: message.session_id };
          if (observerEnabled) {
            const promptPreview = input.prompt.slice(0, 150).replace(/\s+/g, ' ');
            sendObserverMessage(`[query:start] ${promptPreview}${input.prompt.length > 150 ? '...' : ''}`);
          }
        } else if (message.type === 'assistant') {
          // Extract thinking blocks and tool-use blocks for host observer (stderr)
          // and the optional status-channel observer (outbound DB).
          const contentBlocks = (
            message as {
              message: {
                content: Array<{
                  type: string;
                  thinking?: string;
                  name?: string;
                  id?: string;
                  input?: unknown;
                }>;
              };
            }
          ).message.content;
          for (const block of contentBlocks) {
            if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
              // Stderr: compact preview for host observer reaction cycle.
              process.stderr.write(`observer:thinking=${JSON.stringify(block.thinking.slice(0, 500))}\n`);
              // Outbound DB: full text (chunked) for status channel (gated).
              if (observerEnabled) {
                for (let i = 0; i < block.thinking.length; i += OBSERVER_CHUNK_SIZE) {
                  sendObserverMessage(`[thinking] ${block.thinking.slice(i, i + OBSERVER_CHUNK_SIZE)}`);
                }
              }
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              if (block.id) reportedToolUseIds.add(block.id);
              // Stderr: tool name + id for host observer reaction cycle.
              process.stderr.write(`observer:tool_use=${JSON.stringify({ name: block.name, id: block.id })}\n`);
              // Outbound DB: tool + input preview for status channel (gated).
              if (observerEnabled) {
                const inputPreview = block.input ? JSON.stringify(block.input).slice(0, 100) : '';
                sendObserverMessage(`[tool] ${block.name}: ${inputPreview}`);
              }
            }
          }
        } else if (message.type === 'tool_progress') {
          // Forward the first progress event per tool call; skip subsequent ones to avoid flooding.
          if (observerEnabled) {
            const tp = message as {
              tool_use_id: string;
              tool_name: string;
              elapsed_time_seconds: number;
            };
            if (!reportedToolUseIds.has(tp.tool_use_id)) {
              reportedToolUseIds.add(tp.tool_use_id);
              sendObserverMessage(`[tool:progress] ${tp.tool_name} (${Math.round(tp.elapsed_time_seconds)}s)`);
            }
          }
        } else if (message.type === 'result') {
          const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          const thinkingOnly = isThinkingOnlyEndTurn(message);
          if (thinkingOnly) {
            log('Thinking-only end_turn detected — will clear continuation anchor');
          }
          // Always emit to stderr so the host observer advances to ✍ and stops watchdog.
          process.stderr.write('observer:result=done\n');
          yield { type: 'result', text, thinkingOnly };

          if (observerEnabled) {
            const preview = text ? text.slice(0, 300) : '(empty)';
            sendObserverMessage(`[query:done] ${preview}${text && text.length > 300 ? '...' : ''}`);
          }

          // Check token threshold after each completed turn.
          // Only fires when we have a transcript path (after init) and haven't nuked yet.
          if (transcriptPath && !nukeEmitted) {
            const tokens = readLatestTokens(transcriptPath);
            if (tokens > 0) {
              if (tokens >= THRESHOLD_NUKE_TOKENS) {
                nukeEmitted = true;
                warnEmitted = true;
                log(`Threshold nuke: ${tokens.toLocaleString()} tokens >= ${THRESHOLD_NUKE_TOKENS.toLocaleString()}`);
                yield { type: 'threshold_nuke', tokens, transcriptPath };
              } else if (!warnEmitted && tokens >= THRESHOLD_WARN_TOKENS) {
                warnEmitted = true;
                log(`Threshold warn: ${tokens.toLocaleString()} tokens >= ${THRESHOLD_WARN_TOKENS.toLocaleString()}`);
                yield { type: 'threshold_warn', tokens };
              }
            }
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
          if (observerEnabled) sendObserverMessage('[error] API retry');
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
          if (observerEnabled) sendObserverMessage('[error] Rate limit');
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'progress', message: `Context compacted${detail}.` };
          // Distinct event type from `result` so the poll-loop can
          // (a) NOT mark the inbound batch completed (the user's prompt
          //     hasn't actually been answered yet),
          // (b) re-submit the prompt to make the agent actually answer
          //     post-compaction (Claude Code SDK does not auto-resume).
          yield { type: 'compaction', message: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
