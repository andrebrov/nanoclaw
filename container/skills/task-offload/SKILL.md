---
name: task-offload
description: Offload intermediate results from long multi-step tasks to files in /workspace/agent/offload/ and replace the in-context payload with a summary and file reference. Use during any task that accumulates large intermediate outputs (50+ items, multi-stage research, batch processing) to prevent context overflow and avoid auto-compact.
---

# Task Offload — Filesystem Relief for Long Tasks

Use this pattern during any task where intermediate results grow large enough to crowd out reasoning. The goal is to keep context lean: summaries and file references stay in context; full payloads live on disk.

## When to use

Apply the offload pattern when a sub-task produces output that is:
- **Large** — more than ~200 lines, or a list/table with 20+ items
- **Reference-only** — you won't need the full payload in the next step, only specific fields
- **Cumulative** — several similar outputs will stack up before the task ends

Typical triggers: batch lead processing, multi-stage research with many sources, code review passes over many files, bulk data transformations.

## Offload directory

All offload files live under `/workspace/agent/offload/`. This directory persists across container restarts (it's under `/workspace/agent/`, which is host-mounted).

```
/workspace/agent/offload/
  leads_batch_1.json
  leads_batch_2.json
  research_sources.md
  analysis_pass_1.json
  ...
```

## Step-by-step pattern

### 1. Complete the sub-task normally

Produce the output as you would without offloading.

### 2. Write the output to a file

```bash
mkdir -p /workspace/agent/offload
```

Then write the file using the Write tool (for structured data) or Bash redirect (for large text). Use a descriptive, sequenced filename:

- `leads_batch_1.json` — first batch of leads
- `research_sources_2.md` — second pass of research sources
- `analysis_pass_1.json` — first analysis pass

### 3. Replace in-context payload with a summary block

After writing, replace the full output in your response with a compact summary:

```
[OFFLOADED] leads_batch_1.json — 12 leads processed, 3 qualified (Acme Corp, BetaTech, GammaSoft). Full records in /workspace/agent/offload/leads_batch_1.json
```

Format: `[OFFLOADED] <filename> — <count> items, <key highlights>. Full data in <path>`

Do **not** repeat the full payload after writing this summary. The summary is sufficient for the next reasoning step.

### 4. Proceed with the next sub-task

Continue working. Reference the file by name if a later step needs specific data from it.

## Retrieving offloaded data

When a later step needs data from an offloaded file, read only what you need:

```bash
# Read the whole file (small files)
cat /workspace/agent/offload/leads_batch_1.json

# Read specific fields (large JSON)
cat /workspace/agent/offload/leads_batch_1.json | grep '"company"'

# jq for structured extraction
cat /workspace/agent/offload/leads_batch_1.json | jq '[.[] | {company, status}]'
```

Read the file inline, use the data for your reasoning, then drop it from context — do not echo the full file content back into the response.

## Cleanup

After the full task completes and you've delivered final results, optionally clean up:

```bash
rm -rf /workspace/agent/offload/
```

Only clean up when you're confident the task is fully done and the user won't need to revisit intermediate results. If in doubt, leave the files — they don't affect performance.

## Example: batch lead processing

**Without offload (bad — context fills up):**
> Step 1: [12 leads × 15 fields each = 180 lines in context]
> Step 2: [14 more leads × 15 fields = 210 more lines]
> ... by step 5, context has 1000+ lines of lead data

**With offload (good):**
> Step 1 complete. [OFFLOADED] leads_batch_1.json — 12 leads, 3 qualified. Full records in /workspace/agent/offload/leads_batch_1.json
> Step 2 complete. [OFFLOADED] leads_batch_2.json — 14 leads, 4 qualified. Full records in /workspace/agent/offload/leads_batch_2.json
> ...
> Final summary: 50 leads processed across 4 batches. 14 qualified total. See /workspace/agent/offload/ for full records.

## Relationship to auto-compact and session checkpoints

- **Auto-compact** reacts to overflow — offload prevents overflow proactively.
- **Session checkpoints** (`/workspace/agent/.checkpoints/`) persist reasoning state across restarts — offload stores intermediate data payloads, not reasoning state. Use both together for maximum durability on very long tasks.
