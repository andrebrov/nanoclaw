---
name: agent-mesh
description: Share learnings across agents using write_shared_memory and /workspace/global/skills-discovered.md, send messages to all agents with broadcast, or hand off to the primary DM agent with the main destination.
---

# Agent Mesh — Shared Memory and Broadcast

The shared pool at `/workspace/global/` is readable by all agents. Use `write_shared_memory` to publish discoveries so other agents don't repeat the same research or mistakes. The canonical shared file for agent learnings is `skills-discovered.md`.

## Shared Knowledge: /workspace/global/skills-discovered.md

Check this file at the start of a turn when you're about to solve a problem that another agent might already have figured out. After you discover something useful (a working API call, a correct parameter name, an effective pattern), append it using `write_shared_memory`.

**Format — one entry per discovery:**

```
## [short title] — [ISO date]
Agent: [your name]
What: [one sentence — what you discovered]
How: [optional — the exact call/pattern/fix that works]
```

**When to read it:**

- Before calling an external API or tool for the first time this session
- When a task references a domain where another agent is known to be active

**When to write to it:**

- After discovering a working API action name, OAuth scope, or request format that wasn't obvious
- After correcting a mistake that another agent could easily repeat
- Keep entries short — this is a shared file, not a notebook

**How to write:**

```
write_shared_memory({
  filename: "skills-discovered.md",
  content: "\n## [title] — 2026-01-15\nAgent: MyAgent\nWhat: ...\n",
  mode: "append"
})
```

## Broadcasting to All Agents

The `broadcast` destination is always available. Use `send_message({ to: 'broadcast', text: '...' })` to send a message to every other agent simultaneously.

Good uses for broadcast:

- Publishing a critical correction: "Calendar agent: GOOGLECALENDAR_FIND_EVENT is the correct action, not SEARCH_EVENTS"
- Announcing that a shared resource has changed
- Coordinating a handoff when multiple agents need to act

Keep broadcasts short — every active agent receives and processes them.

## Cross-Channel Handoff

The `main` destination is always available — no operator wiring required. It routes to the oldest agent group (the one the user set up first), which is typically their primary DM agent. Use it to hand off a conversation from a group chat to the user's DM.

All other agents are automatically available as destinations — no manual wiring is needed. The destination name is the agent's display name in lowercase with dashes (e.g. an agent named "Main" is reachable as `main`, "AyeAye" as `ayeaye`).

Example:

```
send_message({ to: 'main', text: 'User wants to continue in DM. Context: [summary]' })
```

The target agent receives the message in its agent-shared session and can pick up the context from your message content.

To hand off to a specific named agent (other than main or broadcast), use that agent's destination name. Every peer agent is auto-injected as a destination — see the destinations listed in your system prompt for the full set available in this session.
