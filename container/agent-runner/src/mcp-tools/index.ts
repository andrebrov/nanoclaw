/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 *
 * Admin-only tools (observability) are dynamically imported after config load
 * so they are never registered in non-admin containers.
 *
 * Trust-gated tools are skipped for untrusted (public-channel) sessions to
 * reduce the tool catalog token cost (~11 tools, 13-16K tokens saved).
 * Untrusted sessions receive: ceiling, core, interactive, skills.
 */
import './ceiling.js';
import './core.js';
import './interactive.js';
import './skills.js';
import { loadConfig } from '../config.js';
import { getSessionTrustLevel } from '../db/session-routing.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

async function start(): Promise<void> {
  const config = loadConfig();
  const trustLevel = getSessionTrustLevel();

  if (trustLevel === 'trusted') {
    await import('./scheduling.js');
    await import('./agents.js');
    await import('./self-mod.js');
    await import('./memory.js');
    await import('./send-voice.js');
  } else {
    log('Untrusted session: scheduling, agent, self-mod, memory, and voice tools omitted');
  }

  if (config.isAdmin) {
    await import('./observability.js');
    await import('./channel-model.js');
  }
  await startMcpServer();
}

start().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
