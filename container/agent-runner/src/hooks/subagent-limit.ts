/**
 * SubagentLimit enforcement — after_model truncation via PreToolUse.
 *
 * The model may plan as many Task (sub-agent spawn) calls as it wants.
 * Calls that exceed AGENT_SUBAGENT_LIMIT per model turn are blocked before
 * execution, and a context note is injected so the model adapts on the next
 * step. The counter resets on PostToolBatch (once per model turn, before the
 * next model request).
 *
 * Inspired by DeerFlow's subagent_limit middleware (after_model phase).
 */

/** Tool name that spawns sub-agents in Claude Code. */
export const SUBAGENT_TOOL = 'Task';

/**
 * Per-turn sub-agent spawn counter. Bun's single-threaded event loop makes
 * the synchronous increment safe even when parallel tool calls are in flight.
 */
export class SubagentLimitTracker {
  private turnCount = 0;

  constructor(readonly limit: number) {}

  /**
   * Called from PreToolUse when a Task tool fires. Increments the counter and
   * returns a stop-reason string if the call exceeds the limit, or undefined
   * if it should be allowed.
   */
  intercept(): string | undefined {
    this.turnCount++;
    if (this.turnCount <= this.limit) return undefined;
    return (
      `SubagentLimit: truncated to ${this.limit} (requested ${this.turnCount} this turn). ` +
      `Only the first ${this.limit} sub-agent spawn(s) per model turn will run.`
    );
  }

  /** Reset the per-turn counter. Called from PostToolBatch before each new model request. */
  reset(): void {
    this.turnCount = 0;
  }
}

/**
 * Parse AGENT_SUBAGENT_LIMIT from env. Returns undefined when unset or ≤ 0.
 */
export function parseSubagentLimit(): number | undefined {
  const raw = process.env.AGENT_SUBAGENT_LIMIT?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
