import type { AgentCapability } from '../config.js';
export type { AgentCapability } from '../config.js';

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
