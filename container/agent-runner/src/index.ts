/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Session reentry: if a threshold-nuke checkpoint exists, inject it into
  // the system prompt so the agent can restore context from the last session.
  // The checkpoint is written by the previous container before exit (## Reasoning)
  // and optionally augmented by the host orchestrator (## Facts).
  // Only read checkpoints — never delete them here. The agent will update the
  // file itself during the session; the host rotates to previous.md at nuke time.
  let checkpointAddendum = '';
  const checkpointPath = path.join(CWD, '.checkpoints', 'default.md');
  if (fs.existsSync(checkpointPath)) {
    try {
      const checkpoint = fs.readFileSync(checkpointPath, 'utf-8').trim();
      if (checkpoint) {
        log(`Session checkpoint found — injecting into system context`);
        checkpointAddendum =
          `\n\n<session-checkpoint>\n` +
          `The previous session ended because the context window was approaching its limit. ` +
          `The following checkpoint was saved. Resume naturally from this context:\n\n` +
          `${checkpoint}\n` +
          `</session-checkpoint>`;
      }
    } catch (err) {
      log(`Failed to read checkpoint: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  //
  // env passthrough: the SDK spawns each MCP server as a child process with
  // *exactly* the env we pass — no implicit inheritance from the agent-runner
  // process. With env: {}, the spawned bun has no PATH, no HOME, no node_modules
  // visibility, and no session DB paths, so it dies on startup and the SDK
  // silently treats the server as unavailable. The visible symptom is
  // "No such tool available: mcp__nanoclaw__add_reaction" when the agent
  // tries to call a registered tool.
  //
  // We forward the full process.env (filtering only undefined entries to keep
  // the type Record<string, string>). This is fine: the MCP server is the
  // same code path that the agent-runner already runs in — same trust
  // boundary, same secrets posture.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: childEnv,
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    cwd: CWD,
    systemContext: { instructions: instructions + checkpointAddendum },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
