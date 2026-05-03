import type { AgentCapability, MiddlewareChain } from '../config.js';
export type { AgentCapability, MiddlewareChain } from '../config.js';

export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Opt-in capabilities beyond the safe default. Missing or empty means
   * restricted: no shell, no file writes, no network. Providers that
   * understand capability-gating use this to build their tool allowlists.
   */
  allowedCapabilities?: AgentCapability[];
  /**
   * Enable the merchant-advocate LinkedIn-post gate. The Claude provider
   * wraps its PreToolUse hook so Bash commands posting to LinkedIn are
   * routed through the rubric before they execute.
   */
  linkedinPostValidator?: boolean;
  /**
   * Enable the loop-detection gate. The Claude provider tracks a rolling
   * window of tool-call fingerprints and blocks repeated identical calls.
   * Pass `true` for defaults (window=10, threshold=3) or an object to
   * configure thresholds explicitly.
   */
  loopDetection?: boolean | { windowSize?: number; repeatThreshold?: number };
  /**
   * Ordered middleware pipeline per hook event. When present, user-defined
   * shell commands are appended after the provider's built-in hooks for
   * the declared events. See MiddlewareChain for the slot format.
   */
  middlewareChain?: MiddlewareChain;
  /**
   * Hard cap on Task (sub-agent spawn) calls per model turn. When set,
   * calls beyond this limit are blocked before execution and a context note
   * is injected so the model adapts on the next step. Absent → unlimited
   * (or falls back to AGENT_SUBAGENT_LIMIT env var if set).
   *
   * Per-group config (container.json) takes precedence over the env var.
   */
  subagentLimit?: number;
}

/**
 * Per-channel and per-user config overrides resolved at request time.
 * All fields are optional; only present fields are applied.
 */
export interface ConfigOverride {
  /** Claude model string, e.g. "claude-haiku-4-5". */
  model?: string;
  /** Maximum output tokens for this request. */
  maxTokens?: number;
  /** Appended verbatim to the system prompt for this turn. */
  systemPromptAppend?: string;
  /**
   * Additional tool names granted for this scope. Additive union with the
   * group's base allowlist — cannot remove tools, only add them.
   */
  allowedTools?: string[];
  /**
   * Per-chat emoji policy stamped by the router from messaging_groups.emoji_mode.
   * 'auto' = agent decides; 'on' = encourage emoji; 'off' = prohibit + strip.
   */
  emojiMode?: 'auto' | 'on' | 'off';
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * True when all messages in the batch are scheduled tasks (kind='task').
   * Providers can use this to suppress observer side-channel forwarding
   * for silent maintenance runs.
   */
  isScheduledTask?: boolean;

  /**
   * Per-channel and per-user config overrides for this turn.
   * Resolved by the host at routing time and stamped on the triggering
   * message. When present, these values take precedence over the group's
   * static container.json config for this query only.
   */
  overrides?: ConfigOverride;
}

export type McpServerConfig =
  | { command: string; args: string[]; env: Record<string, string>; url?: never }
  | { url: string; type: 'http' | 'sse'; headers?: Record<string, string>; command?: never };

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null; thinkingOnly?: boolean }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Mid-turn context compaction happened. The SDK ended the current
   * Query as a side effect; the user's prompt was NOT answered. The
   * poll-loop must (a) inform the user, (b) re-submit the same prompt
   * so the agent actually answers, AND must NOT mark the inbound batch
   * completed yet — the turn isn't done.
   */
  | { type: 'compaction'; message: string }
  /**
   * Context window approaching threshold. Poll-loop should push a
   * system-reminder asking the agent to write a reasoning checkpoint.
   * Fires once per session at ~70% of the context window.
   */
  | { type: 'threshold_warn'; tokens: number }
  /**
   * Context window at nuke threshold (~80%). Poll-loop must write a
   * checkpoint sentinel and exit with code 75 (EX_TEMPFAIL) so the
   * host can restart with the checkpoint injected.
   * Fires once per session after threshold_warn.
   */
  | { type: 'threshold_nuke'; tokens: number; transcriptPath: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
