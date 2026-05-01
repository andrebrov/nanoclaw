/**
 * LoopDetection hook — rolling-hash guard against repeated tool call sequences.
 *
 * Maintains a circular buffer of the last N tool-call fingerprints. A
 * fingerprint is "<tool_name>:<JSON(tool_input)>". If the same fingerprint
 * appears K or more times in the window the call is blocked and the agent
 * receives a message asking it to change approach.
 *
 * Fail-open: errors during hashing are swallowed and the call is allowed,
 * consistent with the LinkedIn gate's policy (a missed detection is less
 * disruptive than a false block).
 */

export interface LoopDetectionOptions {
  /** Rolling-window size (default: 10). */
  windowSize?: number;
  /** How many times the same fingerprint must appear to trigger a block (default: 3). */
  repeatThreshold?: number;
}

const DEFAULT_WINDOW = 10;
const DEFAULT_THRESHOLD = 3;

function log(msg: string): void {
  console.error(`[loop-detection] ${msg}`);
}

/**
 * Fingerprint a tool call as "<tool_name>:<JSON(tool_input)>".
 * Large inputs are truncated to avoid O(n) string growth; the first 512
 * characters capture enough structure to distinguish repeated calls.
 */
function fingerprint(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  try {
    const raw = JSON.stringify(toolInput ?? {});
    return `${toolName}:${raw.length > 512 ? raw.slice(0, 512) : raw}`;
  } catch {
    return toolName;
  }
}

/**
 * Create a stateful loop-detection gate.
 *
 * Returns a function with the same signature as the PreToolUse hook body.
 * State (the rolling buffer) lives in the closure and is therefore
 * per-session (reset each time a new ClaudeProvider is constructed for
 * a new query session).
 *
 * Usage:
 *   const gate = createLoopDetectionGate({ windowSize: 10, repeatThreshold: 3 });
 *   // inside PreToolUse hook:
 *   const result = gate(toolName, toolInput);
 *   if (result.block) return { decision: 'block', stopReason: result.reason };
 */
export function createLoopDetectionGate(
  opts: LoopDetectionOptions = {},
): (
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
) => { block: false } | { block: true; reason: string } {
  const windowSize = Math.max(1, opts.windowSize ?? DEFAULT_WINDOW);
  const threshold = Math.max(2, opts.repeatThreshold ?? DEFAULT_THRESHOLD);
  const window: string[] = [];

  return (toolName, toolInput) => {
    let fp: string;
    try {
      fp = fingerprint(toolName, toolInput);
    } catch (err) {
      log(`fingerprint error — fail-open: ${err instanceof Error ? err.message : String(err)}`);
      return { block: false };
    }

    // Slide the window
    window.push(fp);
    if (window.length > windowSize) {
      window.shift();
    }

    // Count occurrences of this fingerprint in the current window
    let count = 0;
    for (const entry of window) {
      if (entry === fp) count++;
    }

    if (count >= threshold) {
      log(`Loop detected: "${toolName}" fingerprint seen ${count}x in last ${window.length} calls`);
      return {
        block: true,
        reason:
          `Loop detected: you have called the same tool (${toolName}) with the same arguments ` +
          `${count} times in the last ${window.length} tool calls. ` +
          `Change your approach — try a different tool, different arguments, or re-read the ` +
          `context to understand why repeated calls are not making progress.`,
      };
    }

    return { block: false };
  };
}
