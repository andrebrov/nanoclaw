---
name: add-observer
description: Add an Observer layer that streams thinking blocks, tool calls, and watchdog pings to a status channel during long agent tasks. Makes agent reasoning visible in real time. Based on the LoMBot Observer pattern.
---

# Add Observer

The observer is built into NanoClaw v2 — no source changes are needed.

While an agent is working, the observer provides:

- **Reaction cycle** on the triggering message: 👀 (arrived) → 🤔 (thinking) → ⚡ (tool call) → ✍ (composing reply)
- **Watchdog pings**: "Still working… (Xs)" in the main chat at 60s / 120s / 300s if no reply has been delivered
- **Status channel** (optional): streams `💭 thinking`, `🔧 tool-name`, and `✅ Done` to a separate configured channel

## Architecture

```
Agent (container)
  └─ providers/claude.ts: extract thinking/tool blocks → write "observer:..." to stderr
     poll-loop.ts: query_start / query_done boundary events → stderr
Host
  └─ container-runner.ts: feedObserverLine() per stderr line
     src/observer.ts: parse events → reaction emoji + watchdog + status-channel delivery
```

The reaction cycle and watchdog run for every session with no configuration. The status channel requires an `observer` block in `container.json`.

## Configure a status channel (optional)

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
- 👀 → 🤔 → ⚡ → ✍ reactions on your original message
- `💭 <thinking summary>` in the status channel as the agent reasons
- `🔧 <tool-name>` in the status channel as tools are invoked
- `✅ Done` in the status channel when the task completes
- `⚡ / 🔥 Still working… (Xs in, N tools so far)` in the **main** chat if the task runs longer than 60s

## Troubleshooting

**No reaction emoji**
1. Check `logs/nanoclaw.error.log` for delivery errors
2. Verify the channel adapter supports reactions (Discord, Slack, Telegram do; some adapters don't)

**No messages in the status channel**
1. Check `logs/nanoclaw.error.log` for `Observer: status-channel delivery failed` lines
2. Verify the `statusChannelId` and `statusChannelType` match a real registered channel
3. Confirm the channel adapter is loaded (`src/channels/index.ts` has the right import)

**Thinking blocks not appearing (`💭` missing)**
- Opus 4.7 with `display` unset omits thinking blocks. NanoClaw pins `display: 'summarized'` automatically — if you're using a custom provider or overriding this option, restore it.
- For models that don't support adaptive thinking (pre-Opus 4.6), only tool calls (`🔧`) will appear.

**Watchdog not firing**
- The watchdog starts when a message wake fires in `router.ts`. Verify the host process is running and receiving messages.
