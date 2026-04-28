import { log } from './log.js';

const KNOWN_MODEL_RE = /^claude-/;

/**
 * Resolve the agent model from the AGENT_MODEL env var.
 * Returns undefined when unset/empty — the Claude CLI default applies.
 * Warns on unrecognized prefix but still forwards the value so operators
 * can use newly-released model IDs before the pattern is updated.
 */
export function resolveAgentModel(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env['AGENT_MODEL'];
  if (!raw) return undefined;
  const model = raw.trim();
  if (!model) return undefined;
  if (!KNOWN_MODEL_RE.test(model)) {
    log.warn('AGENT_MODEL has unrecognized prefix — forwarding anyway', { model });
  }
  return model;
}
