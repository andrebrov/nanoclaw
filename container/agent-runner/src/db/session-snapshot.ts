/**
 * Auto-persist session snapshots on every inbound message batch.
 *
 * Written by the poll-loop (not the agent) so that a container crash mid-turn
 * still leaves enough context for the next container to know what was in-flight.
 * Debounced to 5s to absorb rapid-fire message bursts without excessive I/O.
 *
 * Snapshot lives at /workspace/agent/.session-snapshot.md — inside the
 * agent-group directory which is host-mounted (persists across container
 * restarts). On startup the runner reads this file and injects it into the
 * system prompt so the agent can resume naturally.
 */
import fs from 'fs';

import type { MessageInRow } from './messages-in.js';

const SNAPSHOT_PATH = '/workspace/agent/.session-snapshot.md';
const DEBOUNCE_MS = 5000;

let _timer: ReturnType<typeof setTimeout> | null = null;
let _pending: string | null = null;

/**
 * Schedule a debounced snapshot write for the given message batch.
 * Resets the 5s timer on each call — rapid bursts produce one write.
 */
export function scheduleSnapshotWrite(messages: MessageInRow[]): void {
  _pending = buildSnapshotContent(messages);
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    if (_pending !== null) {
      try {
        fs.writeFileSync(SNAPSHOT_PATH, _pending, 'utf-8');
      } catch {
        // Non-critical — workspace may not be mounted in tests or edge cases
      }
      _pending = null;
    }
    _timer = null;
  }, DEBOUNCE_MS);
}

/** Read the last persisted snapshot, or null if none exists. */
export function readSnapshot(): string | null {
  try {
    return fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
  } catch {
    return null;
  }
}

/** Clear snapshot on /clear — the session is intentionally reset. */
export function clearSnapshot(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    _pending = null;
  }
  try {
    fs.unlinkSync(SNAPSHOT_PATH);
  } catch {
    // Already absent — fine
  }
}

function buildSnapshotContent(messages: MessageInRow[]): string {
  const timestamp = new Date().toISOString();
  const lines: string[] = [`<!-- snapshot: ${timestamp} -->`, ''];

  for (const msg of messages) {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content) as Record<string, unknown>;
    } catch {
      content = { text: msg.content };
    }

    const channelInfo = msg.channel_type ? ` · ${msg.channel_type}` : '';
    const sender =
      (content.sender as string | undefined) ||
      ((content.author as Record<string, unknown> | undefined)?.displayName as string | undefined);
    const text = (content.text as string | undefined) || (content.prompt as string | undefined) || '';

    if (msg.kind === 'chat' || msg.kind === 'chat-sdk') {
      lines.push(`**${msg.kind}${channelInfo}**${sender ? ` · ${sender}` : ''}`);
      if (text) lines.push(`> ${text.replace(/\n/g, '\n> ')}`);
    } else if (msg.kind === 'task') {
      lines.push(`**task**`);
      if (text) lines.push(`> ${text.replace(/\n/g, '\n> ')}`);
    } else {
      lines.push(`**${msg.kind}${channelInfo}**`);
      const summary = text || JSON.stringify(content).slice(0, 200);
      if (summary) lines.push(`> ${summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
