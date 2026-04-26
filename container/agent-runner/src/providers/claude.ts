import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
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

// Tool allowlist for NanoClaw agent containers
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

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
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
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

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

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
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = '9000000';

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

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
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
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: TOOL_ALLOWLIST,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      let sessionId: string | undefined;
      let transcriptPath: string | undefined;
      let warnEmitted = false;
      let nukeEmitted = false;

      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          transcriptPath = `/home/node/.claude/projects/${CLAUDE_PROJECT_SLUG}/${sessionId}.jsonl`;
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          yield { type: 'result', text };

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
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
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

registerProvider('claude', () => new ClaudeProvider());
