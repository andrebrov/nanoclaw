#!/usr/bin/env bun
/**
 * Path-translation PreToolUse middleware for NanoClaw.
 *
 * Reads the Claude Code hook input from stdin (JSON), rewrites every string
 * value inside tool_input that starts with NANOCLAW_VIRTUAL_PREFIX to the
 * corresponding path under NANOCLAW_PHYSICAL_BASE, then writes the SDK
 * hookSpecificOutput envelope to stdout so the middleware-chain picks it up.
 *
 * If nothing changed, exits 0 with no output (pass-through).
 *
 * Environment variables (set in container.json middlewareChain command):
 *   NANOCLAW_VIRTUAL_PREFIX   — virtual root the agent sees (default: /mnt/user-data)
 *   NANOCLAW_PHYSICAL_BASE    — physical root on the container FS (default: /workspace/agent)
 */

const VIRTUAL_PREFIX = process.env.NANOCLAW_VIRTUAL_PREFIX ?? '/mnt/user-data';
const PHYSICAL_BASE = process.env.NANOCLAW_PHYSICAL_BASE ?? '/workspace/agent';

function translatePath(p: string): string {
  if (!p.startsWith(VIRTUAL_PREFIX)) return p;
  const rel = p.slice(VIRTUAL_PREFIX.length);
  // Block directory traversal in the virtual path.
  if (rel.split('/').some((seg) => seg === '..')) return p;
  return PHYSICAL_BASE + (rel.startsWith('/') ? rel : `/${rel}`);
}

function translateValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const translated = translatePath(value);
    return { value: translated, changed: translated !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item: unknown) => {
      const r = translateValue(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: changed ? result : value, changed };
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = translateValue(v);
      if (r.changed) changed = true;
      result[k] = r.value;
    }
    return { value: changed ? result : value, changed };
  }
  return { value, changed: false };
}

const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
process.stdin.on('end', () => {
  let hookInput: Record<string, unknown>;
  try {
    hookInput = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    // Malformed input — fail open.
    process.exit(0);
  }

  const toolInput = hookInput.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') {
    process.exit(0);
  }

  const { value: updatedInput, changed } = translateValue(toolInput);
  if (!changed) {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput,
      },
    }),
  );
  process.exit(0);
});
