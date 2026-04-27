/**
 * Shared memory MCP tool: write_shared_memory.
 *
 * The global memory pool (/workspace/global) is mounted read-only to prevent
 * accidental cross-agent contamination. This tool provides the explicit API
 * for writing to the shared pool — it sends a system action to the host, which
 * applies the write to the filesystem.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

// Only allow safe filenames — no path traversal, no absolute paths.
const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const writeSharedMemory: McpToolDefinition = {
  tool: {
    name: 'write_shared_memory',
    description:
      'Write or append to the shared memory pool readable by all agents (/workspace/global/). Use this to publish cross-agent learnings (e.g. discovered API patterns, shared corrections). Prefer per-agent /workspace/memory/ for private notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description:
            'Filename in the shared pool (e.g. "skills-discovered.md"). No path separators or ".." allowed.',
        },
        content: { type: 'string', description: 'Content to write' },
        mode: {
          type: 'string',
          enum: ['append', 'overwrite'],
          description: 'Whether to append to or overwrite the file. Default: append.',
        },
      },
      required: ['filename', 'content'],
    },
  },
  async handler(args) {
    const filename = args.filename as string;
    const content = args.content as string;
    const mode = (args.mode as string) || 'append';

    if (!filename) return err('filename is required');
    if (!content) return err('content is required');
    if (!SAFE_FILENAME_RE.test(filename)) {
      return err(
        `Invalid filename: "${filename}". Use only letters, digits, hyphens, underscores, and periods. No path separators.`,
      );
    }
    if (mode !== 'append' && mode !== 'overwrite') {
      return err('mode must be "append" or "overwrite"');
    }

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'write_shared_memory', filename, content, mode }),
    });

    return ok(`Queued ${mode} to shared memory: ${filename}`);
  },
};

registerTools([writeSharedMemory]);
