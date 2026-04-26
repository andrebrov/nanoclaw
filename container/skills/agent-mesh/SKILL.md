---
name: agent-mesh
description: Share learnings across agents using /workspace/global/skills-discovered.md, and send messages to all agents at once with the broadcast destination.
---

# Agent Mesh — Shared Memory and Broadcast

You have access to a shared memory file at `/workspace/global/skills-discovered.md` that all agents read and write. Use it to publish discoveries so other agents don't repeat the same research or mistakes.

## Shared Knowledge: /workspace/global/skills-discovered.md

Check this file at the start of a turn when you're about to solve a problem that another agent might already have figured out. After you discover something useful (a working API call, a correct parameter name, an effective pattern), append it.

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

## Broadcasting to All Agents

The `broadcast` destination is always available. Use `send_message({ to: 'broadcast', text: '...' })` to send a message to every other agent simultaneously.

Good uses for broadcast:
- Publishing a critical correction: "Calendar agent: GOOGLECALENDAR_FIND_EVENT is the correct action, not SEARCH_EVENTS"
- Announcing that a shared resource has changed
- Coordinating a handoff when multiple agents need to act

Keep broadcasts short — every active agent receives and processes them.

## Cross-Channel Handoff

To hand off a conversation to another agent (e.g., moving from a group chat to DM), use `send_message` with that agent's name as the destination. The target agent receives the message in its agent-shared session and can pick up the context from your message content.

Example:
```
send_message({ to: 'main', text: 'User wants to continue in DM. Context: [summary]' })
```

The `main` agent must have been wired as a destination by the operator. If the destination isn't listed, ask the user to have an admin wire it up via /manage-channels.
