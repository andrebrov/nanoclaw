/**
 * Shared memory module — host-side handler for write_shared_memory actions.
 *
 * Agents cannot write to /workspace/global directly (RO mount). When an agent
 * calls the write_shared_memory MCP tool, it emits a system action that lands
 * here. The host validates the path and writes to groups/global/<filename>.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

// Mirror of the container-side validation — must stay in sync.
export const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Collapse all whitespace runs to a single space and trim edges. Used for dedup comparison only. */
export function normalizeForDedup(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

async function handleWriteSharedMemory(content: Record<string, unknown>, session: Session): Promise<void> {
  const filename = content.filename as string;
  const text = content.content as string;
  const mode = (content.mode as string) || 'append';

  if (!filename || !SAFE_FILENAME_RE.test(filename)) {
    log.warn('write_shared_memory: invalid filename rejected', { filename, sessionId: session.id });
    return;
  }
  if (typeof text !== 'string') {
    log.warn('write_shared_memory: missing content', { sessionId: session.id });
    return;
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });

  const target = path.join(globalDir, filename);
  // Belt-and-suspenders: confirm the resolved path is still inside globalDir
  // even though the regex already prevents traversal characters.
  if (!target.startsWith(globalDir + path.sep)) {
    log.warn('write_shared_memory: resolved path escapes globalDir', { filename, target, sessionId: session.id });
    return;
  }

  const tmpPath = path.join(globalDir, `.tmp_${crypto.randomUUID()}`);

  if (mode === 'overwrite') {
    // Atomic overwrite: write to temp then rename so readers never see a partial file.
    fs.writeFileSync(tmpPath, text, 'utf-8');
    fs.renameSync(tmpPath, target);
  } else {
    // Append with dedup: skip if a whitespace-normalised match already exists.
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
    const normalizedCandidate = normalizeForDedup(text);
    if (normalizedCandidate && existing && normalizeForDedup(existing).includes(normalizedCandidate)) {
      log.info('Shared memory write skipped (duplicate entry)', { filename, agentGroupId: session.agent_group_id });
      return;
    }
    // Atomic append: read-modify-write via temp + rename to avoid torn writes.
    fs.writeFileSync(tmpPath, existing + text, 'utf-8');
    fs.renameSync(tmpPath, target);
  }

  log.info('Shared memory written', { filename, mode, agentGroupId: session.agent_group_id });
}

registerDeliveryAction('write_shared_memory', handleWriteSharedMemory);
