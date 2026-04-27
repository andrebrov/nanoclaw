/**
 * Shared memory module — host-side handler for write_shared_memory actions.
 *
 * Agents cannot write to /workspace/global directly (RO mount). When an agent
 * calls the write_shared_memory MCP tool, it emits a system action that lands
 * here. The host validates the path and writes to groups/global/<filename>.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

// Mirror of the container-side validation — must stay in sync.
const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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
  if (mode === 'overwrite') {
    fs.writeFileSync(target, text, 'utf-8');
  } else {
    fs.appendFileSync(target, text, 'utf-8');
  }

  log.info('Shared memory written', { filename, mode, agentGroupId: session.agent_group_id });
}

registerDeliveryAction('write_shared_memory', handleWriteSharedMemory);
