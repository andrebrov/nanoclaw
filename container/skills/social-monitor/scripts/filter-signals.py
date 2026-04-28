#!/usr/bin/env python3
"""
filter-signals — deduplicate a social-signal list against a persistent seen-URLs tracker.

Usage:
  echo '[{"url":"https://x.com/user/status/1","text":"hello"},...]' | python3 filter-signals.py

Outputs a JSON array of signals whose URLs have not been seen before,
then appends those URLs to the tracker so they are skipped next run.
"""
import json
import os
import sys

TRACKER = "/workspace/agent/social-monitor-seen.json"


def load_tracker() -> set:
    if os.path.exists(TRACKER):
        with open(TRACKER) as f:
            return set(json.load(f))
    return set()


def save_tracker(seen: set) -> None:
    with open(TRACKER, "w") as f:
        json.dump(sorted(seen), f)


def main() -> None:
    signals = json.load(sys.stdin)
    seen = load_tracker()
    new_signals = [s for s in signals if str(s.get("url", "")) not in seen]
    seen.update(str(s.get("url", "")) for s in new_signals)
    save_tracker(seen)
    json.dump(new_signals, sys.stdout)


if __name__ == "__main__":
    main()
