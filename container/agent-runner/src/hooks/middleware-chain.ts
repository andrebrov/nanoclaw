/**
 * Middleware chain — ordered pipeline of user-defined shell hook commands.
 *
 * Reads `middlewareChain` from container.json to build named, ordered hook
 * callbacks for PreToolUse / PostToolUse / PostToolUseFailure. Each slot
 * maps a name to a shell command. The command receives the hook input as
 * JSON on stdin; its response controls the decision:
 *
 *   exit 0, empty stdout  → continue (pass-through)
 *   exit 0, JSON stdout   → { decision, reason } override (block or continue)
 *                            OR { hookSpecificOutput: { hookEventName, updatedInput } }
 *                            to transparently rewrite the tool input for PreToolUse
 *   exit non-zero         → block, reason from stdout or generic message
 *   any spawn error       → fail-open (continue), warning logged
 *
 * The chain runs in declared order and short-circuits on the first block.
 * If a slot returns an updatedInput, subsequent slots receive the updated
 * tool_input so translations compose correctly.
 */
import { spawn } from 'child_process';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { MiddlewareSlot } from '../config.js';

const MIDDLEWARE_TIMEOUT_MS = 10_000;

function log(msg: string): void {
  console.error(`[middleware-chain] ${msg}`);
}

interface SlotDecision {
  block: boolean;
  reason?: string;
  /** Replacement tool_input from hookSpecificOutput.updatedInput (PreToolUse only). */
  updatedInput?: Record<string, unknown>;
}

async function runSlot(slot: MiddlewareSlot, input: unknown): Promise<SlotDecision> {
  return new Promise<SlotDecision>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(slot.command, [], {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      log(`[${slot.name}] spawn error — fail-open: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ block: false });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      log(`[${slot.name}] timed out after ${MIDDLEWARE_TIMEOUT_MS}ms — fail-open`);
      resolve({ block: false });
    }, MIDDLEWARE_TIMEOUT_MS);

    child.stdout?.on('data', (b: Buffer) => stdout.push(b));
    child.stderr?.on('data', (b: Buffer) => stderr.push(b));

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`[${slot.name}] error — fail-open: ${err.message}`);
      resolve({ block: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;

      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (stderrText) log(`[${slot.name}] stderr: ${stderrText.slice(0, 200)}`);

      const stdoutText = Buffer.concat(stdout).toString('utf8').trim();

      // Try to parse JSON decision from stdout regardless of exit code.
      if (stdoutText) {
        try {
          const parsed = JSON.parse(stdoutText) as {
            decision?: string;
            reason?: string;
            hookSpecificOutput?: {
              hookEventName?: string;
              updatedInput?: Record<string, unknown>;
            };
          };
          const updatedInput = parsed.hookSpecificOutput?.updatedInput;
          if (parsed.decision === 'block') {
            log(`[${slot.name}] blocked: ${parsed.reason ?? '(no reason)'}`);
            resolve({ block: true, reason: parsed.reason ?? `Blocked by middleware '${slot.name}'` });
            return;
          }
          if (parsed.decision === 'continue' || code === 0) {
            resolve({ block: false, updatedInput });
            return;
          }
        } catch {
          // Not JSON — fall through to exit code handling.
        }
      }

      if (code !== 0) {
        const reason = stdoutText || `Middleware '${slot.name}' exited with code ${code ?? 'null'}`;
        log(`[${slot.name}] blocked (exit ${code}): ${reason.slice(0, 200)}`);
        resolve({ block: true, reason });
        return;
      }

      resolve({ block: false });
    });

    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch {
      // stdin may be closed already on fast-exit; decision comes from close handler.
    }
  });
}

/**
 * Build a HookCallback that runs the given middleware slots in declared order.
 * Fails open on any slot error; short-circuits on the first block.
 *
 * For PreToolUse hooks: if any slot returns an updatedInput, the modified
 * tool_input is threaded through subsequent slots and returned to the SDK so
 * the translation is transparent to the agent. Slots compose: each slot sees
 * the tool_input as already modified by earlier slots.
 */
export function createMiddlewareHook(slots: MiddlewareSlot[]): HookCallback {
  return async (input) => {
    const hookInput = input as Record<string, unknown>;
    let currentToolInput: Record<string, unknown> | undefined =
      hookInput.tool_input != null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : undefined;
    let inputModified = false;

    for (const slot of slots) {
      const slotInput =
        currentToolInput !== undefined && currentToolInput !== hookInput.tool_input
          ? { ...hookInput, tool_input: currentToolInput }
          : hookInput;
      const decision = await runSlot(slot, slotInput);
      if (decision.block) {
        return {
          decision: 'block',
          stopReason: decision.reason ?? `Blocked by middleware '${slot.name}'`,
        } as unknown as ReturnType<HookCallback>;
      }
      if (decision.updatedInput !== undefined) {
        currentToolInput = decision.updatedInput;
        inputModified = true;
      }
    }

    if (inputModified && currentToolInput !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: currentToolInput,
        },
      } as unknown as ReturnType<HookCallback>;
    }

    return { continue: true };
  };
}
