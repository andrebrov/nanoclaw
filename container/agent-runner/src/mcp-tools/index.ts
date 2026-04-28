/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 *
 * Admin-only tools (observability) are dynamically imported after config load
 * so they are never registered in non-admin containers.
 */
import './ceiling.js';
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './memory.js';
import './send-voice.js';
import { loadConfig } from '../config.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

async function start(): Promise<void> {
  const config = loadConfig();
  if (config.isAdmin) {
    await import('./observability.js');
  }
  await startMcpServer();
}

start().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
