/**
 * DanglingToolCall recovery middleware.
 *
 * Scans a Claude Code session transcript for tool_use blocks that have no
 * matching tool_result. For each dangling call, appends a synthetic
 * tool_result placeholder so the model can resume without refusing.
 *
 * Call this before resuming a session continuation. A session interrupted
 * mid-tool-loop (container crash, nuke, compaction, timeout) leaves the
 * transcript with unresolved tool_use blocks. Without this repair, the
 * resumed session is "poisoned" — the model refuses to continue because
 * every tool_use must have a corresponding tool_result.
 *
 * Idempotent: a second call on an already-repaired transcript is a no-op
 * because the injected tool_result entries satisfy the lookup on re-scan.
 */
import fs from 'fs';

function log(msg: string): void {
  console.error(`[dangling-tool-call-recovery] ${msg}`);
}

/**
 * Detect and repair dangling tool_use calls in a JSONL session transcript.
 *
 * For each tool_use id that has no matching tool_result, appends a single
 * synthetic user message containing all the placeholder results, marked
 * is_error=true so the model understands the tools were interrupted rather
 * than returning empty output.
 */
export function repairDanglingToolCalls(transcriptPath: string): void {
  if (!fs.existsSync(transcriptPath)) return;

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return;
  }

  const lines = content.split('\n').filter((l) => l.trim());
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content as Array<{ type: string; id?: string }>) {
          if (block.type === 'tool_use' && typeof block.id === 'string') {
            toolUseIds.add(block.id);
          }
        }
      } else if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content as Array<{ type: string; tool_use_id?: string }>) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }
    } catch {
      /* skip unparseable lines */
    }
  }

  const dangling = [...toolUseIds].filter((id) => !toolResultIds.has(id));
  if (dangling.length === 0) return;

  log(`Injecting ${dangling.length} placeholder tool_result(s) for interrupted tool call(s): ${dangling.join(', ')}`);

  const placeholderContent = dangling.map((id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: '[interrupted — result unavailable]',
    is_error: true,
  }));

  const placeholderEntry =
    '\n' +
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: placeholderContent },
      parent_tool_use_id: null,
      session_id: '',
    });

  try {
    fs.appendFileSync(transcriptPath, placeholderEntry);
  } catch (err) {
    log(`Failed to repair dangling tool calls: ${err instanceof Error ? err.message : String(err)}`);
  }
}
