/**
 * LinkedIn post validator — pre-execution gate.
 *
 * When the runner config has `linkedinPostValidator: true` and the agent
 * tries to invoke a LinkedIn-posting Bash command (composio-tool linkedin-* /
 * heyreach-tool *), this hook intercepts the call, runs the post text
 * through the finsi/merchant-advocate rubric via the claude CLI, and
 * either lets the command through (SHIP, score >= 4.0) or blocks it with
 * the verdict + reason text (RESHAPE / KILL).
 *
 * Fail-open by design (per specs/linkedin-post-validator.spec.md): if we
 * can't extract the post text from the command, can't reach the evaluator,
 * or the evaluator times out, the command is allowed and a warning is
 * logged. False blocks would be more disruptive than missed gates while
 * the gate is rolling out — flip the spec's defaults if that calculus
 * changes.
 */
import { spawn } from 'child_process';

const LINKEDIN_PATTERNS: RegExp[] = [
  /\bcomposio-tool\s+linkedin-create-post\b/,
  /\bcomposio-tool\s+linkedin-create-linked-in-post\b/,
  /\bcomposio-tool\s+linkedin-share-post\b/,
  /\bcomposio-tool\s+linkedin\s+post-share\b/,
  /\bcomposio-tool\s+linkedin\s+post-create\b/,
  /\bcomposio-tool\s+linkedin\s+update-share\b/,
  /\bheyreach-tool\s+post-share\b/,
  /\bheyreach-tool\s+create-post\b/,
  /\bheyreach-tool\s+share\b/,
];

const EVAL_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  console.error(`[linkedin-post-validator] ${msg}`);
}

export function isLinkedInPostCommand(cmd: string): boolean {
  return LINKEDIN_PATTERNS.some((re) => re.test(cmd));
}

/**
 * Best-effort extraction of the post body from a Bash command line.
 * Recognised shapes, in order:
 *   - --text "..." / --commentary "..." / --content "..."
 *   - last double-quoted positional argument
 *   - last single-quoted positional argument
 * Returns null when nothing plausible is found, which the caller treats as
 * fail-open per the spec.
 */
export function extractPostText(cmd: string): string | null {
  const flag = cmd.match(/--(?:text|commentary|content)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
  if (flag) return (flag[1] ?? flag[2] ?? '').replace(/\\(["'\\])/g, '$1');
  const dq = [...cmd.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  if (dq.length > 0) return dq[dq.length - 1][1].replace(/\\(["\\])/g, '$1');
  const sq = [...cmd.matchAll(/'((?:[^'\\]|\\.)*)'/g)];
  if (sq.length > 0) return sq[sq.length - 1][1];
  return null;
}

const MERCHANT_PROMPT = (
  post: string,
): string => `You are the Merchant Advocate evaluating a LinkedIn POST (not a feature proposal).

Score the post 1-5 on each dimension, from a busy $1M-$50M DTC operator's perspective:
1. Work Reduction — does this post help operators do less / save time?
2. Proactive vs Reactive — does it push insight rather than ask the reader to do work?
3. Revenue Impact — does it connect to retention / CAC / LTV / margin?
4. Time to Value — could the reader apply something within 30 days?
5. Simplicity — could a non-technical operator grasp it in 30 seconds?
6. Overlap — does it duplicate the same takes operators see daily?
7. Differentiation — is the angle uniquely Finsi (multi-source, ML, cross-channel)?

Compute the average. Verdict: SHIP (>=4.0), RESHAPE (2.5-3.9), KILL (<2.5).

Respond ONLY with a single JSON object on one line, nothing else:
{"verdict":"SHIP|RESHAPE|KILL","average":<number>,"reason":"one paragraph"}

Post:
"""
${post}
"""`;

export interface MerchantVerdict {
  verdict: 'SHIP' | 'RESHAPE' | 'KILL';
  average: number;
  reason: string;
}

/**
 * Spawn the claude CLI in one-shot mode with the rubric prompt and parse
 * the JSON response. Returns null on any failure (caller treats as
 * fail-open).
 */
export async function evaluatePost(text: string, timeoutMs = EVAL_TIMEOUT_MS): Promise<MerchantVerdict | null> {
  return new Promise<MerchantVerdict | null>((resolve) => {
    const child = spawn(
      '/pnpm/claude',
      ['--print', '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      log(`evaluator timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (b) => chunks.push(b));
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`evaluator spawn error: ${err.message}`);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (killed) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const wrapper = JSON.parse(raw);
        const result = String(wrapper.result ?? wrapper.text ?? '').trim();
        const inner = result.match(/\{[\s\S]*\}/);
        if (!inner) {
          log(`evaluator output did not contain JSON: ${result.slice(0, 200)}`);
          resolve(null);
          return;
        }
        const parsed = JSON.parse(inner[0]) as MerchantVerdict;
        if (!parsed.verdict || typeof parsed.average !== 'number') {
          log(`evaluator JSON missing required fields`);
          resolve(null);
          return;
        }
        resolve(parsed);
      } catch (err) {
        log(`evaluator parse failed: ${err instanceof Error ? err.message : String(err)}`);
        resolve(null);
      }
    });
    child.stdin.write(MERCHANT_PROMPT(text));
    child.stdin.end();
  });
}

export type GateDecision =
  | { skip: true }
  | { block: true; reason: string }
  | { block: false; verdict?: MerchantVerdict };

/**
 * Decide whether a Bash command should be allowed.
 *   - skip: not a LinkedIn-post command, gate doesn't apply.
 *   - block: RESHAPE or KILL, return reason for the agent to revise.
 *   - allow: SHIP, or fail-open on any error.
 */
export async function gateLinkedInPostCommand(cmd: string): Promise<GateDecision> {
  if (!isLinkedInPostCommand(cmd)) return { skip: true };

  const text = extractPostText(cmd);
  if (!text) {
    log(`could not extract post text — fail-open: ${cmd.slice(0, 100)}`);
    return { block: false };
  }

  const verdict = await evaluatePost(text);
  if (!verdict) return { block: false };

  log(`verdict ${verdict.verdict} avg=${verdict.average.toFixed(2)} chars=${text.length}`);
  if (verdict.verdict === 'SHIP') return { block: false, verdict };
  return {
    block: true,
    reason: `[merchant-advocate gate] ${verdict.verdict} (avg=${verdict.average.toFixed(2)}): ${verdict.reason}\n\nRevise the post to address the merchant's perspective and try again.`,
  };
}
