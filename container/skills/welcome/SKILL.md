---
name: welcome
description: Introduces the agent to a newly connected channel by sending a warm greeting, listing available commands, explaining supported features, and providing example prompts to guide the user. Use when onboarding a new channel, introducing the agent for the first time, handling a first message, or setting up a new channel connection. Relevant for terms like 'introduce', 'new channel setup', 'onboarding', 'first message', 'channel wired', or 'getting started'.
---

# /welcome — Channel Onboarding

You've just been connected to a new user. Introduce yourself and guide them through what you can do.

## What to do

1. Send a short, warm greeting
2. State your name (from your system prompt / CLAUDE.md)
3. Signal broad capability without listing everything upfront
4. Ask: would they like to explore what you can do, or jump straight into something?

**If they want to explore:** reveal one capability at a time (see order below). Keep each reveal to 2–4 sentences, offer a demo or let them try it.

**If they want to jump in:** just go.

---

## Example opening messages

**Casual (Telegram/Discord):**
> Hey! I'm [Name] — your AI agent. I can do a lot more than answer questions. Want a quick tour, or shall we dive straight in?

**Professional (Slack/Teams):**
> Hi there — I'm [Name], your connected AI agent. I'm set up and ready to help. Would you like a brief overview of what I can do, or is there something specific you'd like to tackle?

---

## Capabilities to reveal (in order, one at a time)

1. **Memory & Context Over Time** — Remembers projects, preferences, and decisions across sessions.
2. **Spawning Persistent Agents (`create_agent`)** — Spins up named sub-agents with their own memory and workspace.
3. **Scheduled & Background Tasks** — Runs tasks on a schedule or in the background while conversation continues.
4. **Research & Web Browsing** — Browses the web live for current data beyond training knowledge.
5. **Code & Building Things** — Writes, debugs, and deploys full applications from script to live URL.
6. **Interactive UI** — Sends structured cards and multiple-choice buttons directly into chat.
7. **Files & Artifacts** — Produces and delivers real files (reports, PDFs, charts, images) as attachments.
8. **Self-Customization** — Can add new tools and MCP servers to extend its own capabilities.

---

## Trust & Control — always include these

**Approvals:** Sensitive actions (installing packages, adding MCP servers) require explicit user approval before proceeding — nothing happens automatically.

**Access Control:** The user controls who can interact with the agent. Adding it to a new group or sharing a bot link triggers an approval request — nobody gets access without the user's say-so.

---

## Interaction model — always mention this

No special commands. Users just talk naturally. If they want something done, they say so.

---

## Wrapping up

Close with an open invitation. Ask what they're working on and any challenges they're facing — offer to suggest ways you can help.

---

## Tone

Warm, confident, inviting. Casual for Telegram/Discord; slightly more professional for Slack/Teams.

## Important

- Scan available MCP tools and skills before starting — know what you have, keep it in reserve
- Never overwhelm with a full capability list; reveal capabilities one at a time
- Save any corrections or preferences the user expresses during onboarding to memory for future sessions
