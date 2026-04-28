---
name: social-monitor
description: Deduplicate a list of social media signals (tweets, posts) against a persistent seen-URLs tracker so the same signals are never re-delivered across runs. Use when monitoring social feeds, curating mentions, or scheduling periodic lead-discovery batches.
---

# social-monitor — deduplicate signals across delivery cycles

Filters a JSON array of signal objects against a persistent tracker stored at
`/workspace/agent/social-monitor-seen.json` (writable per-session path).

## Usage

```bash
echo '[{"url":"https://x.com/user/status/1","text":"hello"},{"url":"https://x.com/user/status/2","text":"world"}]' \
  | python3 /app/skills/social-monitor/scripts/filter-signals.py
```

Outputs only signals whose `url` field has not been seen in a previous run,
then appends those URLs to the tracker.

## Input

A JSON array of objects. Each object must have a `"url"` field (string).
Any extra fields are passed through unchanged.

## Output

A JSON array of the same shape — only signals with unseen URLs.

## Tracker path

Seen URLs are persisted in `/workspace/agent/social-monitor-seen.json` (writable).

Do **not** point this at `/workspace/group/` — that path is read-only inside
the container and writes will silently fail.

## Reset

To start fresh, delete or empty the tracker:

```bash
rm /workspace/agent/social-monitor-seen.json
```
