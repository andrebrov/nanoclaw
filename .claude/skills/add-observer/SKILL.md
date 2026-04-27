---
name: add-observer
description: Add an Observer layer that streams thinking blocks, tool calls, and watchdog pings to a status channel during long agent tasks. Makes agent reasoning visible in real time. Based on the LoMBot Observer pattern.
---

# Add Observer

Adds a live-status observer layer to NanoClaw. While an agent is working:

- **Thinking blocks** are forwarded as `💭 <summary>` to a configured status channel
- **Tool calls** appear as `🔧 <tool-name>`
- **Query completion** sends `✅ Done`
- **Watchdog** alternates ⚡/🔥 emoji every 30s so the status visibly changes; escalating pings at 60s / 120s / 300s if no completion

## Architecture

```
Agent (container)
  └─ claude.ts: extract thinking/tool blocks → write "observer:..." to stderr
Host (container-runner.ts)
  └─ stderr handler → ObserverHandle.line()
     └─ observer.ts: parse events → delivery adapter → status channel
        └─ watchdog timer: ping if no result within threshold
```

## Pre-flight (idempotent)

Skip to **Step 1** if all of these are already present:

- `src/observer.ts` exists
- `src/container-config.ts` has an `observer` field in `ContainerConfig`
- `src/container-runner.ts` imports and wires `createObserver`
- `container/agent-runner/src/providers/claude.ts` handles `message.type === 'assistant'` and emits `observer:` lines

## Step 1 — Copy the observer module

```bash
cp "${CLAUDE_SKILL_DIR}/src/observer.ts" src/observer.ts
```

## Step 2 — Extend ContainerConfig with the observer field

In `src/container-config.ts`, add the `observer` field to the `ContainerConfig` interface (after the `isAdmin` field):

```typescript
  /** Observer config — stream thinking/tool events to a status channel. */
  observer?: {
    statusChannelId: string;
    statusChannelType: string;
    statusThreadId?: string | null;
  };
```

Also update `readContainerConfig` to pass the field through. Inside the `try` block of `readContainerConfig`, add `observer: raw.observer,` to the returned object.

## Step 3 — Wire the observer in container-runner.ts

### 3a. Add the import

At the top of `src/container-runner.ts`, add this import alongside the other host module imports:

```typescript
import { createObserver } from './observer.js';
```

### 3b. Create the observer after container spawn

In `spawnContainer()`, after this existing line:

```typescript
  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);
```

Add:

```typescript
  const observer = createObserver(agentGroup.folder);
```

### 3c. Update the stderr handler

Replace the existing stderr handler:

```typescript
  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });
```

With:

```typescript
  // Log stderr and forward observer: lines to the status channel
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) {
        log.debug(line, { container: agentGroup.folder });
        observer?.line(line);
      }
    }
  });
```

### 3d. Destroy the observer on container close

In the `container.on('close', ...)` handler, add `observer?.destroy();` after `stopTypingRefresh(session.id);`:

```typescript
  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    observer?.destroy();
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });
```

## Step 4 — Emit observer events from the container

In `container/agent-runner/src/providers/claude.ts`, inside the `translateEvents()` generator, handle the `assistant` message type to extract thinking blocks and tool calls.

Find the last `else if` in the event loop (the `task_notification` branch) and add after it:

```typescript
        } else if (message.type === 'assistant') {
          const aMsg = message as { type: 'assistant'; message: { content?: unknown[] } };
          for (const block of aMsg.message?.content ?? []) {
            const b = block as { type?: string; thinking?: string; name?: string; id?: string };
            if (b.type === 'thinking' && b.thinking) {
              process.stderr.write(`observer:thinking=${JSON.stringify(b.thinking.slice(0, 500))}\n`);
            } else if (b.type === 'tool_use') {
              process.stderr.write(`observer:tool_use=${JSON.stringify({ name: b.name, id: b.id })}\n`);
            }
          }
```

Also emit `query_start` and `result` events. Find the result branch:

```typescript
        } else if (message.type === 'result') {
          const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          yield { type: 'result', text };
```

Change it to:

```typescript
        } else if (message.type === 'result') {
          const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          process.stderr.write('observer:result=done\n');
          yield { type: 'result', text };
```

And find the `init` branch:

```typescript
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          transcriptPath = `/home/node/.claude/projects/${CLAUDE_PROJECT_SLUG}/${sessionId}.jsonl`;
          yield { type: 'init', continuation: message.session_id };
```

Change it to:

```typescript
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          transcriptPath = `/home/node/.claude/projects/${CLAUDE_PROJECT_SLUG}/${sessionId}.jsonl`;
          process.stderr.write('observer:query_start=1\n');
          yield { type: 'init', continuation: message.session_id };
```

## Step 5 — Pin thinking display for Opus 4.7

In `container/agent-runner/src/providers/claude.ts`, find the `sdkQuery({...})` call. Inside its `options` object, add:

```typescript
        thinking: { type: 'adaptive' as const, display: 'summarized' as const },
```

This ensures Opus 4.7 returns thinking summaries rather than omitting them. Models that don't support adaptive thinking ignore this option.

## Step 6 — Build and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Fix any type errors before proceeding.

## Step 7 — Configure the observer for a group

Edit `groups/<folder>/container.json` for the group you want to observe, adding an `observer` block:

```json
{
  "observer": {
    "statusChannelId": "<your-telegram-chat-id-or-discord-channel-id>",
    "statusChannelType": "telegram",
    "statusThreadId": null
  }
}
```

`statusChannelType` must match a registered channel adapter (e.g. `telegram`, `discord`, `slack`).

Restart NanoClaw for the change to take effect:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Verify

Send a long task to the observed agent. You should see:
- `💭 <thinking summary>` messages as the agent reasons
- `🔧 <tool-name>` as tools are invoked
- `✅ Done` when the task completes
- `⚡ / 🔥 Still working… (Xs)` if the task runs longer than 60s

## Opus 4.7 note

Opus 4.7 returns thinking blocks with an encrypted signature and empty text when `display` is not explicitly set. The `display: 'summarized'` option added in Step 5 ensures the `thinking` field contains human-readable content. Without this, the `observer:thinking=` lines are emitted but with empty strings, so `💭` messages never appear in the status channel.

## Troubleshooting

**No messages in the status channel**
1. Check `logs/nanoclaw.error.log` for `Observer: delivery failed` lines
2. Verify the `statusChannelId` and `statusChannelType` match a real registered channel
3. Confirm the channel adapter is loaded (`src/channels/index.ts` has the right import)

**Thinking blocks not appearing (`💭` missing)**
- Confirm Step 5 (thinking pin) was applied and the container image was rebuilt (`./container/build.sh`)
- Verify the model supports adaptive thinking (Opus 4.6+, Opus 4.7)
- For earlier models, thinking blocks don't exist — only tool calls (`🔧`) will appear

**Watchdog not firing**
- The watchdog starts on `observer:query_start`. Verify Step 4 (init branch patch) was applied.
