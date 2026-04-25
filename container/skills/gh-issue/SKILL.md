---
name: gh-issue
description: File a GitHub issue against the nanoclaw repo to trigger an AI-fix run. Use when the user wants a code change to NanoClaw itself — bugs, features, refactors. The issue will get labeled `ai-fix`, a GitHub Action picks it up, Claude opens a PR, CI gates it, and after merge the droplet auto-syncs and restarts.
---

# gh-issue — file a fix request as a GitHub issue

Use when the user reports a bug or asks for a change in NanoClaw's own code (anything under `~/nanoclaw/`). Don't use this for application data, prospecting workflows, or non-NanoClaw repos.

## When to use

- "There's a bug in delivery.ts when X happens"
- "Add a setting to make Y configurable"
- "Refactor Z so it doesn't…"
- "The agent should also do W when…"

## When NOT to use

- For non-code requests (questions, discussions, configuration changes the user can do themselves like updating `.env`).
- For Composio/Attio/CRM data work — that's not NanoClaw code.
- If the user says "just fix it now" — they likely want a direct edit. Ask once before filing an issue.

## How to use

Run the helper script:

```bash
/app/skills/gh-issue/create.sh "<title>" "<body>"
```

- **Title:** one-line summary, action-verb first ("Fix container kill loop on stale heartbeat", "Add foo bar to bar.ts").
- **Body:** Markdown. Include:
  - **Symptom** — what the user is seeing
  - **Expected** — what should happen
  - **Hypothesis / suspected cause** (if any) — point at file:line if known
  - **Acceptance** — how we'll know it's fixed (test that should pass, behavior to verify)

The script POSTs to GitHub's REST API. Auth is auto-injected by OneCLI on `api.github.com` — no token needed in the script. The label `ai-fix` is added automatically; that triggers the AI-fix workflow.

On success, the script prints the issue URL. Send it to the user as `<message>` content so they can follow along on GitHub.

## Example

User: "There's a race in container-runner.ts where the heartbeat file from a prior container instance causes the new container to be killed within 1 second."

You:
```bash
/app/skills/gh-issue/create.sh \
  "Stale .heartbeat file SIGKILLs freshly-spawned container" \
  "## Symptom
Container spawn → host sweep sees old heartbeat mtime → kills container with SIGKILL (exit 137) within 1 second of spawn.

## Hypothesis
\`src/container-runner.ts spawnContainer()\` doesn't unlink the prior \`.heartbeat\` before \`spawn()\`. \`src/host-sweep.ts:79–86\` assumes a fresh container has no heartbeat file.

## Acceptance
- After kill+respawn, new container survives past the 30 min ceiling without being killed by the sweep
- Add a regression test in src/host-sweep.test.ts"
```

Then to user: "Filed as #42 — Action will pick it up shortly. https://github.com/andrebrov/nano-claw/issues/42"
