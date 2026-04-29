---
name: wiki-briefing
description: "Documents the automatic session-start wiki briefing mechanism. At container startup, the agent-runner reads /workspace/global/knowledge/wiki/INDEX.md and injects the most relevant articles as a <knowledge-base> block in the system context. Reference-only — the agent does not invoke this manually. Use this skill when explaining how wiki knowledge is loaded, debugging missing briefings, or configuring an agent's wiki tags."
---

# Wiki Briefing

**Trigger:** Automatic on every fresh container start.

This is not a slash command — you do NOT invoke it manually. The agent-runner
reads the shared wiki index and injects relevant articles before the first
message is processed.

## What it does

On container start, the agent-runner looks for
`/workspace/global/knowledge/wiki/INDEX.md`. If it exists, it:

1. Parses the index to get article titles, file paths, summaries, and tags.
2. Scores each article for relevance to this agent (see Scoring below).
3. Reads the full content of the top-scoring articles (up to 5).
4. Injects them into the system context as a `<knowledge-base>` block.

The agent starts the session with this knowledge already loaded — no need to
re-read wiki files manually each turn.

## Scoring

Each article gets a score based on:

| Criterion | Points |
|-----------|--------|
| Has a tag in `core`, `finsi`, `process` | +2 |
| Tag matches one of "My tags" in `CLAUDE.local.md` | +1 per match |
| Tag matches a keyword in the agent or group name | +1 per match |
| Updated within the last 7 days | +1 |

Articles with a score of 0 are excluded. The top 5 by score are injected.

## Configuring an agent's wiki tags

Add a `## Knowledge Wiki` section to the agent's `CLAUDE.local.md`:

```markdown
## Knowledge Wiki
Index: /workspace/global/knowledge/wiki/INDEX.md
My tags: [finsi, outreach, contacts]
```

The `My tags` line is what the agent-runner reads. Tags are comma-separated,
case-insensitive, and matched against each article's tag list.

## INDEX.md format

The agent-runner supports two INDEX.md formats:

### Table format (preferred)

```markdown
| Article | Summary | Tags |
|---------|---------|------|
| [Finsi ICP](articles/icp.md) | Ideal customer profile for Finsi | finsi, icp, core |
| [PE Prospects](articles/prospects.md) | Current prospect list and research | research, prospects |
```

### Section format

```markdown
## Finsi ICP
File: articles/icp.md
Tags: finsi, icp, core
Updated: 2024-03-15
Summary: Ideal customer profile for Finsi — verticals, size, buying triggers.

## PE Prospects
File: articles/prospects.md
Tags: research, prospects
Updated: 2024-03-10
Summary: Current prospect list with research notes and contact status.
```

## Graceful no-ops

The briefing is silently skipped if:
- `/workspace/global/knowledge/wiki/INDEX.md` does not exist
- The index exists but contains no parseable articles
- No article meets the minimum relevance threshold

This means agents without a wiki (most setups) are unaffected — no errors,
no empty blocks in context.

## Debugging a missing briefing

1. Check that the wiki index exists at the expected path:
   ```bash
   ls /workspace/global/knowledge/wiki/
   ```
2. Check the agent-runner logs for `[wiki-briefing]` lines:
   ```bash
   # From the host
   docker logs <container-id> 2>&1 | grep wiki-briefing
   ```
3. Verify the index format matches one of the two supported formats above.
4. Check that at least one article has a relevant tag — articles scoring 0
   are excluded.
5. Confirm `My tags` is set in `CLAUDE.local.md` if you need role-based
   inclusion:
   ```
   My tags: [your, tags, here]
   ```
