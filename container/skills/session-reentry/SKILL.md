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

## Updating the checkpoint

During a session, you can update the checkpoint at any time:
```
Write /workspace/agent/.checkpoints/default.md
```

The `## Reasoning` section is yours to maintain. Be concise — it must survive
a context-full agent writing at 70% capacity.

## No checkpoint (normal session)

If no checkpoint exists, the `<session-checkpoint>` block is absent from the
system context. This is normal for new groups or after a `/clear`.
