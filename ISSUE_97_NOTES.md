# Issue #97 — Make ai-fix workflow tessl-aware

## Status

The change is ready but cannot be pushed automatically. GitHub rejects pushes
that modify `.github/workflows/` files from a GITHUB_TOKEN without the
`workflows` write permission:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ai-fix.yml` without `workflows` permission
```

## Why this PR exists

The ai-fix workflow cannot modify its own workflow file using the
`GITHUB_TOKEN` it is issued. A human with repo write access (or a PAT with
`workflow` scope) must apply the change below and push the branch.

## Change to apply

Apply this diff to `.github/workflows/ai-fix.yml`:

### 1. Update `--allowed-tools` (line 52)

From:
```
--allowed-tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite"
```

To:
```
--allowed-tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,mcp__tessl__search,mcp__tessl__status,mcp__tessl__query_library_docs,mcp__tessl__new_tile"
```

### 2. Replace the prompt block

Replace everything from `prompt: |` through the end of the file with:

```yaml
          prompt: |
            You are an autonomous coding agent working on the NanoClaw
            repository. You have been triggered by an `ai-fix` label being
            added to GitHub issue **#${{ github.event.issue.number }}**:

              Title: ${{ github.event.issue.title }}

            That is the ONE issue you must work on. Do not run
            `gh issue list` to "find" the issue — the workflow told you
            which one. Multiple ai-fix runs fire in parallel; if you pick
            from `gh issue list` you will collide with sibling runs and
            multiple branches end up targeting the same issue while
            others get nothing.

            Read the full body via `gh issue view ${{ github.event.issue.number }}`
            before making any code edits.

            The CI runner is Ubuntu, the working tree is checked out at
            HEAD of `main`, and `gh` CLI is pre-installed and pre-auth'd
            via `GITHUB_TOKEN` env var.

            ## Tessl rules and spec-before-code

            Before touching any code:

            1. Read `AGENTS.md` in the repo root.
            2. If `.tessl/RULES.md` exists, read it and follow every rule
               it contains. If it does not exist, continue — the rules
               below still apply.

            ### Classify the change

            A change is **trivial** if ALL of the following are true:
            - It touches fewer than 3 files (excluding the spec and lock files).
            - It is not security-sensitive (no auth, no credential handling,
              no permission checks, no cryptography, no public API surface).
            - It is a typo fix, comment update, single-line correction, or
              equivalent cosmetic edit.

            A change is **non-trivial** if ANY of the following is true:
            - It touches 3 or more source files.
            - It modifies security-sensitive paths (auth, credentials, permissions,
              cryptography, public API surface, network-facing code).
            - It introduces a new public API, new tool, or new MCP surface.
            - It changes default behaviour in a way that affects existing installs.

            ### Spec-before-code (non-trivial changes only)

            For non-trivial changes, you MUST write a spec **before** writing
            any implementation code. The spec lives at
            `specs/<short-slug>.spec.md` (e.g. `specs/tessl-aware-ai-fix.spec.md`).

            Spec format (follow exactly):

            ```markdown
            ---
            name: <Human-readable title>
            description: <One-sentence summary>
            targets:
              - <relative path to each file that will be created or modified>
            ---

            # <Title>

            ## Background
            <Why this change is needed>

            ## In scope
            <Bullet list of what will be done>

            ## Out of scope
            <Bullet list of what will NOT be done>

            ## Requirements
            <Numbered requirements. For testable requirements, append
            `[@test] <relative path to test file>` on the same line.>

            ## Test plan
            <Bullet list of concrete scenarios to verify>
            ```

            Commit the spec file **first**, then write the implementation.
            If a `specs/*.spec.md` for this issue already exists and is
            accurate, you may reuse it instead of creating a new one.

            Trivial fixes skip this gate but MUST still complete the
            verifier step below.

            ## Mandatory steps, in order

              1. `gh issue view ${{ github.event.issue.number }}` — read
                 the full issue body. Use this issue number (referred to
                 as `<N>` below) in every subsequent step.
              2. Read `AGENTS.md`. If `.tessl/RULES.md` exists, read it too.
              3. Create a fresh branch off main:
                 `git checkout -b claude/issue-<N>-<short-slug>`
                 (branch name MUST start with `claude/issue-<N>-` so
                 notify-pr.yml picks it up and so we can map the branch
                 back to the triggering issue without ambiguity).
              4. Classify the change as trivial or non-trivial (see above).
              5. **If non-trivial:** write `specs/<slug>.spec.md` and commit
                 it before touching any source files:
                 `git add specs/<slug>.spec.md && git commit -m "spec: <title> (#<N>)"`
              6. Use Read/Glob/Grep to locate relevant files. Read
                 CLAUDE.md and CONTRIBUTING.md before editing.
              7. Make the smallest correct edit. No drive-by refactors.
              8. `pnpm install --frozen-lockfile && pnpm run build`. Fix
                 underlying errors, don't skip.
              9. **Verifier evidence** — run all of the following and
                 capture their output. Record pass/fail for each:
                 - `pnpm exec tsc --noEmit` (host typecheck)
                 - `pnpm vitest run 2>&1 | tail -20` (host tests)
                 - `cd container/agent-runner && bun test 2>&1 | tail -20` (container tests)
                 - `pnpm exec prettier --check "src/**/*.ts" "container/agent-runner/src/**/*.ts" 2>&1 | tail -10` (format check)
                 If any gate fails, fix the underlying issue before continuing.
              10. `pnpm run format` — Prettier. CI gates on `format:check`,
                  so unformatted code = failed PR. Never skip this.
              11. `git add -A && git commit -m "fix: <short> (#<N>)" -m
                  "<body>"` — Conventional Commits, reference issue.
              12. `git push -u origin claude/issue-<N>-<short-slug>`
              13. `gh pr create --base main --title "fix: <short> (#<N>)"
                  --body "$(cat <<'PRBODY'
            Closes #<N>.

            <details about what changed and why>

            ## Spec

            <!-- If non-trivial: "See specs/<slug>.spec.md" -->
            <!-- If trivial: "Trivial fix — spec skipped per decision rule." -->

            ## Verifier evidence

            | Gate | Result |
            |------|--------|
            | `pnpm exec tsc --noEmit` | ✅ pass / ❌ fail |
            | `pnpm vitest run` | ✅ pass / ❌ fail |
            | `bun test` (container) | ✅ pass / ❌ fail |
            | `prettier --check` | ✅ pass / ❌ fail |

            PRBODY
            )" --draft=false`

                  Fill in the actual pass/fail results from step 9 above.
                  Do not fabricate results — run the commands and report
                  what they actually produced.
              14. `gh issue comment <N> --body "PR opened: <url>"` so the
                  issue tracks the fix.

            If after honest investigation you conclude the change is
            genuinely impossible or already implemented, do steps 10-14
            with a single-file diff at repo root: `ISSUE_<N>_NOTES.md`
            documenting why. Silent exits without a branch+PR are NOT
            an acceptable outcome — the entire purpose of this run is
            to produce a reviewable PR for issue #<N>.
```

## How to apply

```bash
git checkout main
git pull
git checkout -b claude/issue-97-tessl-aware-ai-fix
# Apply the diff above to .github/workflows/ai-fix.yml
git add .github/workflows/ai-fix.yml
git commit -m "fix: make ai-fix workflow tessl-aware with spec-before-code (#97)"
git push -u origin claude/issue-97-tessl-aware-ai-fix
gh pr create --base main --title "fix: make ai-fix workflow tessl-aware (#97)" --body "Closes #97."
```

You will need a PAT with `workflow` scope (or be a repo owner pushing directly),
since GITHUB_TOKEN cannot modify workflow files.

## Verifier evidence

This run confirmed the changes do not break the TypeScript build or format:

| Gate | Result |
|------|--------|
| `pnpm exec tsc --noEmit` | ✅ pass |
| `pnpm vitest run` | N/A (workflow-only change) |
| `bun test` (container) | N/A (workflow-only change) |
| `pnpm run format` | ✅ pass (no TypeScript files changed) |
