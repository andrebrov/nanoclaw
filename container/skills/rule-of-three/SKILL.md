---
name: rule-of-three
description: Detect when you are performing the same kind of action 3+ times and promote it to a reusable skill. After any significant external action, track a fingerprint. On the 3rd occurrence, search existing skills for a match; if none found, draft and propose a new container skill.
---

# Rule of Three

After you complete any significant external action — creating content, calling an API,
sending a message, filing a ticket — fingerprint the action and update the counter.
On the 3rd repetition, check existing skills for a match and propose or promote a new skill.

## When to fingerprint

Fingerprint actions that:
- Create, post, send, update, or delete content in an external system
- Follow a consistent pattern: same verb + same target domain + same input shape

Do NOT fingerprint:
- Read-only operations (reading files, searching, listing)
- One-time setup steps
- Actions inside a helper or sub-agent task
- Responses to ad-hoc user requests with highly variable inputs

## Fingerprint format

Construct a key from three parts, lowercase, separated by `/`:

```
<verb>/<domain>/<shape>
```

| Part   | Examples                                                           |
| ------ | ------------------------------------------------------------------ |
| verb   | `create`, `send`, `post`, `update`, `delete`, `file`               |
| domain | `github`, `email`, `slack`, `calendar`, `file`, `api`              |
| shape  | `issue`, `pr`, `message`, `event`, `newsletter`, `report`          |

Examples:
- Filing a GitHub issue → `create/github/issue`
- Sending a newsletter email → `send/email/newsletter`
- Posting a LinkedIn comment → `post/linkedin/comment`
- Creating a Slack message → `send/slack/message`

When unsure how to classify, prefer the broader shape (e.g. `create/github/issue`
not `create/github/issue-titled-foo`).

## Tracking

After each fingerprintable action, run:

```bash
/app/skills/rule-of-three/scripts/track.sh "<fingerprint>" "<one-line summary>"
```

The script updates `/workspace/memory/rule-of-three.json` and prints the new count.

If the count reaches 3 or more, proceed to the **On 3rd hit** section below.

## On 3rd hit

### Step 1 — Check existing skills first

```
mcp__nanoclaw__list_skills()
```

Scan the results. If a skill's description matches this action pattern, tell the user:

> "I notice I've done `<action>` 3 times. We already have the `<skill-name>` skill
> for this — I'll use that going forward."

Load the full instructions with `mcp__nanoclaw__get_skill({ name: "<skill-name>" })`
and use it from now on. Skip step 2 if an existing skill matched.

### Step 2 — Propose a new skill (if no match found)

Draft a new skill and ask the user for confirmation before filing anything:

```
I've done <action-description> 3 times now. This looks like a recurring workflow.

Proposed skill: **<name>**
Description: <one-sentence description>

SKILL.md draft:
---
name: <name>
description: <description>
---
# <Name>

<instructions based on the 3 examples observed>

## Usage
<example invocation>
---

Scripts needed:
- scripts/<name>.sh — <what it does>

Shall I file a GitHub issue to implement this skill so it's available permanently?
```

### Step 3 — File the implementation issue (on confirmation)

On user confirmation, use the `gh-issue` skill to file an implementation request:

```bash
/app/skills/gh-issue/scripts/create.sh \
  "New container skill: <name>" \
  "$(cat <<'EOF'
## Proposal
Promote repeated action pattern into a container skill.

**Fingerprint:** <fingerprint>
**Observed 3x:**
1. <example 1>
2. <example 2>
3. <example 3>

## SKILL.md
\`\`\`markdown
<full SKILL.md content>
\`\`\`

## Scripts

### scripts/<name>.sh
\`\`\`bash
<script content if applicable>
\`\`\`

## Acceptance
- \`container/skills/<name>/SKILL.md\` created with the above content
- Scripts scaffolded under \`container/skills/<name>/scripts/\`
- Skill available to all agents on next container start
EOF
)"
```

Tell the user the issue URL. The AI-fix workflow will create the files; the skill
becomes available after the droplet syncs.

### Step 4 — Propose Tessl tile promotion (optional, separate confirmation)

After the skill issue is filed, ask separately:

> "Should I also register this as a Tessl tile (`.tessl/tiles/nanoclaw/<name>/`)?
> Tiles make the skill discoverable across installs — they are more public than
> a local container skill."

If the user confirms, file a second gh-issue:

```bash
/app/skills/gh-issue/scripts/create.sh \
  "Tessl tile for skill: <name>" \
  "$(cat <<'EOF'
## Proposal
Register \`<name>\` as a Tessl tile for cross-install distribution.

After the container skill lands (see #<skill-issue-number>), create:

### .tessl/tiles/nanoclaw/<name>/tile.json
\`\`\`json
{
  "name": "nanoclaw/<name>",
  "version": "0.1.0",
  "summary": "<description>",
  "skills": {
    "<name>": { "path": "SKILL.md" }
  }
}
\`\`\`

### .tessl/tiles/nanoclaw/<name>/SKILL.md
(copy from container/skills/<name>/SKILL.md)

## Acceptance
- \`.tessl/tiles/nanoclaw/<name>/\` exists with \`tile.json\` and \`SKILL.md\`
- Tile is discoverable via the Tessl tile registry
EOF
)"
```

## Cross-session persistence

The counter lives in `/workspace/memory/rule-of-three.json`, mounted from
`data/agent-memory/<group-id>/` on the host. Counts survive container restarts
and session boundaries for this agent group.

## Suppressing false positives

If the user says "this doesn't need a skill", mark the fingerprint as suppressed:

```bash
/app/skills/rule-of-three/scripts/track.sh --suppress "<fingerprint>"
```

Suppressed fingerprints are never promoted again, but their count continues to
increment (for observability). The promotion check is skipped for suppressed keys.
