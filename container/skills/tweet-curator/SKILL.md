---
name: tweet-curator
description: Deduplicate a list of tweets against a persistent seen-IDs tracker so the same tweets are never re-delivered across runs. Use when curating, filtering, or scheduling tweet batches.
---

# tweet-curator — deduplicate tweets across runs

Filters a JSON array of tweet objects against a persistent tracker stored at
`/workspace/agent/tweet-curator-seen.json` (writable per-session path).

## Usage

```bash
echo '[{"id":"1","text":"hello"},{"id":"2","text":"world"}]' \
  | python3 /app/skills/tweet-curator/scripts/filter-tweets.py
```

Outputs only tweets whose `id` field has not been seen in a previous run,
then appends those IDs to the tracker.

## Input

A JSON array of objects. Each object must have an `"id"` field (string or number).
Any extra fields are passed through unchanged.

## Output

A JSON array of the same shape — only tweets with unseen IDs.

## Tracker path

Seen IDs are persisted in `/workspace/agent/tweet-curator-seen.json` (writable).

Do **not** point this at `/workspace/group/` — that path is read-only inside
the container and writes will silently fail.

## Reset

To start fresh, delete or empty the tracker:

```bash
rm /workspace/agent/tweet-curator-seen.json
```
