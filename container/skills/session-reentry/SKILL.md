---
name: session-reentry
description: "Documentation for the automatic session-reentry mechanism that injects the previous session checkpoint into a fresh container start. Reference-only — the agent does not invoke this manually; the agent-runner reads /workspace/agent/.checkpoints/default.md before any user message and surfaces it as a session-checkpoint system block. Use this skill when explaining or debugging how cross-session context survives container restarts, when the user asks about session memory, remembering context between sessions, persistence between sessions, or lost context after a restart."
---

# Session Reentry

**Trigger:** `/session-reentry`

This skill is invoked automatically on every fresh container start via the system context.
You do NOT need to invoke it manually.

## What it does

On container start, the agent runner injects any existing checkpoint from
`/workspace/agent/.checkpoints/default.md` into the system context as a
`<session-checkpoint>` block. This happens before any user message is processed.

## Checkpoint format

```markdown
## Facts
*Written by orchestrator — deterministic extraction from conversation transcript*

[Key participants, ongoing tasks, decisions made, important context]

---

## Reasoning
*Written by agent during the previous session*

[Agent's own notes: current task, key decisions, what to remember]
```

## When a checkpoint is present

The `<session-checkpoint>` in your system context contains the previous session's
saved state. Use it to:
- Resume any in-progress tasks without re-asking for context
- Remember key decisions and their rationale
- Continue conversations naturally without breaking flow

**Example:** If the checkpoint contains:
```
## Facts
User is refactoring the auth module. Step 3 of 5 complete (token validation done).

## Reasoning
Next step is to update the session middleware to use the new token validator.
```
Then on session start, immediately continue from step 4 — update the session middleware — without asking the user to recap. Acknowledge the resumed state briefly: "Picking up where we left off: updating the session middleware next."

## Updating the checkpoint

During a session, you can update the checkpoint at any time:
```
Write /workspace/agent/.checkpoints/default.md
```

After writing, verify the update succeeded by reading the file back and confirming it matches the expected format (both `## Facts` and `## Reasoning` sections present, no truncation).

The `## Reasoning` section is yours to maintain. Be concise — it must survive
a context-full agent writing at 70% capacity.

## No checkpoint (normal session)

If no checkpoint exists, the `<session-checkpoint>` block is absent from the
system context. This is normal for new groups or after a `/clear`.
