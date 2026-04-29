---
name: add-karpathy-llm-wiki
description: Add a persistent wiki knowledge base to a NanoClaw group. Based on Karpathy's LLM Wiki pattern. Triggers on "add wiki", "wiki", "knowledge base", "llm wiki", "karpathy wiki".
---

# Add Karpathy LLM Wiki

Set up a persistent wiki knowledge base on NanoClaw, based on Karpathy's LLM Wiki pattern.

## Step 1: Read the pattern

Read `${CLAUDE_SKILL_DIR}/llm-wiki.md` — this is the full LLM Wiki idea as written by Karpathy. Understand it thoroughly before proceeding. Summarize the core idea to the user briefly, then discuss what they want to build.

## Step 2: Choose a group

AskUserQuestion: "Which group should have the wiki?"

1. **Main group** — add to your existing main chat
2. **Dedicated group** — create a new group just for the wiki
3. **Other** — pick an existing group

If dedicated: ask which channel and chat, then register with `pnpm exec tsx setup/index.ts --step register`.

## Step 3: Design collaboratively

Discuss with the user based on the pattern:
- What's the wiki's domain or topic?
- What kinds of sources will they add? (URLs, PDFs, images, voice notes, books, transcripts)
- Do they want the full three-layer architecture or a lighter version?
- Any specific conventions they care about? (The pattern intentionally leaves this open.)

Based on this discussion, create three things:

### 3a. Directory structure

Create `wiki/` and `sources/` directories in the group folder. Create initial `index.md` and `log.md` per the pattern's Indexing and Logging section. Adapt to the user's domain.

### 3b. Container skill

Create a `container/skills/wiki/SKILL.md` tailored to this user's wiki. This is the schema layer from the pattern — it tells the agent how to maintain the wiki. Base it on the pattern's Operations section (ingest, query, lint) and the conventions you agreed on with the user. Don't over-prescribe — the pattern says "your LLM figures out the rest."

### 3c. Group CLAUDE.md

Edit the group's CLAUDE.md to add a wiki section. This is critical — it's what turns the agent into a wiki maintainer. It should:

- Explain the wiki system concisely: what it is, the three layers (sources, wiki, schema), the three operations (ingest, query, lint)
- Index the key files and folders (`wiki/`, `sources/`, `wiki/index.md`, `wiki/log.md`)
- Point to the container skill for detailed workflow
- **Ingest discipline:** Be very explicit that when the user provides multiple files or points at a folder with many files, the agent MUST process them one at a time. For each file: read it, discuss takeaways, create/update all wiki pages (summary, entities, concepts, cross-references, index, log), and completely finish with that file before moving to the next. Never batch-read all files and then process them together — this produces shallow, generic pages instead of the deep integration the pattern requires.

## Step 4: Source handling capabilities

Based on the source types the user plans to ingest (discussed in Step 3), check whether the agent can already handle those formats — some are supported natively, others need a skill (e.g. `/add-image-vision`, `/add-pdf-reader`, `/add-voice-transcription`). If a needed capability isn't installed, check if there's an available skill for it and help the user get it set up.

### URL handling note

claude has built-in `WebFetch`, but it returns a summary, not the full document. For wiki ingestion of a URL where the full text matters, the container skill and CLAUDE.md should instruct claude to use bash commands to download full files instead. For example:

```bash
curl -sLo sources/filename.pdf "<url>"
```

If the document is a webpage, then claude can use fetch or `agent-browser` to open the page and extract full text if available. The container skill and CLAUDE.md should note this so claude gets full content for sources rather than summaries.


## Step 5: Install lint.sh and set up a schedule

Install the wiki linting script, then optionally schedule it to run weekly.

### 5a. Install lint.sh

```bash
cp "${CLAUDE_SKILL_DIR}/scripts/lint.sh" groups/global/knowledge/scripts/lint.sh
chmod +x groups/global/knowledge/scripts/lint.sh
```

The script is now available inside every agent container at `/workspace/global/knowledge/scripts/lint.sh`.

### 5b. Smoke test

Run a quick check to confirm the script works (requires at least one compiled article in `knowledge/wiki/`):

```bash
bash groups/global/knowledge/scripts/lint.sh --knowledge-dir groups/global/knowledge
```

Reports appear in `groups/global/knowledge/lint/`.

### 5c. Optional: weekly schedule

AskUserQuestion: "Want lint to run automatically every week?"

1. **Yes — weekly (Sundays at 2am)**
2. **Skip — I'll run it manually**

If yes, ask the wiki agent to set up the schedule. Send it a message like:

> "Schedule the wiki lint to run every Sunday at 2am. Use: bash /workspace/global/knowledge/scripts/lint.sh --knowledge-dir /workspace/global/knowledge"

The agent will use its `schedule` MCP tool to create the recurring task. After each run the script writes reports to `/workspace/global/knowledge/lint/` and prints a `LINT_SUMMARY:` line — the agent will relay that summary to the group chat so you can see issues at a glance.

On-demand: any agent can run `bash /workspace/global/knowledge/scripts/lint.sh` directly.


## Step 6: Set up the compilation engine

Install `compile.sh` — the automated batch compiler that transforms `knowledge/raw/` documents into structured wiki articles in `knowledge/wiki/`.

### 6a. Create the knowledge directory structure

Create `knowledge/raw/` and `knowledge/wiki/` in the agent's global workspace host directory (`groups/global/`). This makes the knowledge base accessible to all agent groups as a read-only shared mount:

```bash
mkdir -p groups/global/knowledge/raw/processed
mkdir -p groups/global/knowledge/wiki
mkdir -p groups/global/knowledge/scripts
mkdir -p groups/global/knowledge/lint
```

### 6b. Install the compilation script

```bash
cp "${CLAUDE_SKILL_DIR}/scripts/compile.sh" groups/global/knowledge/scripts/compile.sh
chmod +x groups/global/knowledge/scripts/compile.sh
```

The script is now available inside every agent container at `/workspace/global/knowledge/scripts/compile.sh`.

### 6c. Test on sample input

Drop a sample file into `groups/global/knowledge/raw/` and run a quick smoke test (requires `claude` CLI on the host):

```bash
echo "Test note: Claude is an AI assistant made by Anthropic." > groups/global/knowledge/raw/test-note.txt
bash groups/global/knowledge/scripts/compile.sh --knowledge-dir groups/global/knowledge
```

Verify `groups/global/knowledge/wiki/` contains a new `.md` file and `groups/global/knowledge/wiki/INDEX.md` has an entry.

### 6d. Optional: session-end hook (auto-compile after each session)

To compile automatically after every NanoClaw session, add a `SessionEnd` hook in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash groups/global/knowledge/scripts/compile.sh --knowledge-dir groups/global/knowledge",
            "async": true
          }
        ]
      }
    ]
  }
}
```

### 6e. Optional: daily 3am schedule

Ask the wiki agent to set up a daily compilation schedule. Send it a message like:

> "Schedule the wiki compilation to run every day at 3am. Use: bash /workspace/global/knowledge/scripts/compile.sh --knowledge-dir /workspace/global/knowledge"

The agent will use its `schedule` MCP tool to create the recurring task.

On-demand: any agent can run `bash /workspace/global/knowledge/scripts/compile.sh` directly.

## Step 7: Build and restart

```bash
pnpm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

Tell the user to test by sending a source to the wiki group.
