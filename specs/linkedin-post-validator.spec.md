---
name: LinkedIn Post Validator (Merchant-Advocate Gate)
description: Pre-execution hook that runs Finsi's merchant-advocate skill over any LinkedIn post draft before the agent's posting CLI call is allowed to proceed.
targets:
  - ../container/agent-runner/src/providers/claude.ts
  - ../container/agent-runner/src/hooks/linkedin-post-validator.ts
  - ../groups/main/container.json
---

# LinkedIn Post Validator

## Background

Agents in the `main` group post to LinkedIn by invoking `composio-tool linkedin
post-share <text>` (and similar `linkedin-create-post` / `linkedin-share-post`
variants) and via `heyreach-tool` Bash commands. The text never enters the
host's outbound delivery pipeline, so the existing host-side delivery-action
registry cannot intercept it.

The `finsi/merchant-advocate` skill (at `~/.claude/skills/merchant-advocate/`)
scores content from the perspective of a $1M–$50M DTC operator. The user wants
every LinkedIn post run through that lens before it is published, so posts that
score poorly are surfaced for revision rather than going out as-is.

## In scope

- Adding a `PreToolUse` hook in the Claude Agent SDK provider configuration so
  Bash commands matching the LinkedIn-posting patterns are intercepted before
  execution.
- A new helper module `container/agent-runner/src/hooks/linkedin-post-validator.ts`
  that:
  - Detects the LinkedIn-post commands.
  - Extracts the post text from the command arguments.
  - Runs an inline merchant-advocate evaluation prompt against that text.
  - Returns an `allow` / `block-with-reason` decision.
- Per-group opt-in via a new `linkedinPostValidator: true` field in
  `container.json`. Initially set on `groups/main/container.json` only.
- Tests under `container/agent-runner/src/hooks/linkedin-post-validator.test.ts`.

## Out of scope

- The `Outreach Manager` and `Content Writer` groups (can be enabled later by
  flipping the same flag in their `container.json`).
- HeyReach-specific scoring (HeyReach campaign drafts are sequenced messages
  that flow differently — same gate covers their `linkedin-post-share` calls
  but not their templated outreach copy).
- Content-safety / hallucination / link-safety checks. This gate is strictly
  the merchant-advocate scorecard, nothing else.
- Replacing the existing prompt-level instructions to agents about how to write
  LinkedIn posts.

## Requirements

### Detection

- The hook MUST trigger on Bash commands whose first non-shell-builtin token is
  `composio-tool` and whose arguments include any of: `linkedin-create-post`,
  `linkedin-create-linked-in-post`, `linkedin-share-post`, `linkedin post-share`,
  `linkedin post-create`, or `linkedin update-share`.
  `[@test] ../container/agent-runner/src/hooks/linkedin-post-validator.test.ts`
- The hook MUST also trigger on `heyreach-tool` invocations whose subcommand is
  `post-share`, `create-post`, or `share`.
  `[@test] ../container/agent-runner/src/hooks/linkedin-post-validator.test.ts`
- The hook MUST NOT trigger on other `composio-tool` subcommands (gmail,
  attio, calendar, twitter, etc.) or unrelated Bash commands.
  `[@test] ../container/agent-runner/src/hooks/linkedin-post-validator.test.ts`

### Text extraction

- For `composio-tool linkedin-create-post --text "..."` style invocations, the
  hook MUST extract the value of the `--text` (or `--commentary`, `--content`)
  flag.
- For positional-argument invocations (`composio-tool linkedin post-share "the
  post text"`), the hook MUST extract the last positional argument that is not
  a flag.
- If text extraction fails (no recognisable text argument), the hook MUST allow
  the command to proceed and log a warning rather than block, since false
  blocks would be more disruptive than missed gates during the rollout phase.

### Evaluation

- The hook MUST send a prompt to Claude (via the same SDK already in use)
  containing the merchant-advocate rubric (work reduction, proactivity, revenue
  impact, time-to-value, simplicity, overlap, differentiation) adapted from
  feature-proposal review to LinkedIn-post review, plus the post text, and ask
  for `SHIP / RESHAPE / KILL` plus a one-paragraph reason.
- The model used MUST be the same provider/model the parent agent is running
  on (read from container.json `provider` + the host-injected `assistantName` /
  api key — no separate API call path).
- Evaluation MUST time out after 30 seconds. On timeout the hook allows the
  command and logs a warning (fail-open, same rationale as text-extraction
  failures during rollout).

### Decision behaviour

- On `SHIP` (score >= 4.0): the hook MUST allow the Bash command to proceed.
- On `RESHAPE` (2.5 <= score < 4.0) and on `KILL` (score < 2.5): the hook MUST
  block the command and return the rubric verdict + reason as the tool result
  so the agent can revise and try again.
- The block message MUST start with `[merchant-advocate gate]` so it is greppable
  in logs.

### Configuration

- A new `linkedinPostValidator` boolean field MUST be added to
  `ContainerConfig` (host-side `src/container-config.ts`) and the per-agent
  `container/agent-runner/src/config.ts` schema.
- The hook MUST be a no-op when this flag is `false` or absent.
- `groups/main/container.json` MUST set `linkedinPostValidator: true` as part
  of this change.

### Observability

- Every gate decision (allow / block) MUST log a single line at info level via
  the existing `log()` helper, including: the command pattern that matched,
  the verdict, and the rubric scores.

## Test plan

- `composio-tool linkedin-create-post --text "..."` matches and triggers the
  evaluator.
- `composio-tool gmail send` does NOT match.
- `heyreach-tool post-share` matches.
- Plain Bash like `ls` is unaffected.
- A SHIP verdict allows the original command through unchanged.
- A KILL verdict blocks the command and returns the verdict text.
- Evaluator timeout (>30s) results in allow + warning log.
- Hook is a no-op when `linkedinPostValidator: false`.
