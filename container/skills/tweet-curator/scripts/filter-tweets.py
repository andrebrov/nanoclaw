#!/usr/bin/env python3
"""
filter-tweets — deduplicate a tweet list against a persistent seen-IDs tracker.

Usage:
  echo '[{"id":"1","text":"hello"},...]' | python3 filter-tweets.py

Outputs a JSON array of tweets whose IDs have not been seen before,
then appends those IDs to the tracker so they are skipped next run.
"""
import json
import os
import sys

TRACKER = "/workspace/agent/tweet-curator-seen.json"


def load_tracker() -> set:
    if os.path.exists(TRACKER):
        with open(TRACKER) as f:
            return set(json.load(f))
    return set()


def save_tracker(seen: set) -> None:
    with open(TRACKER, "w") as f:
        json.dump(sorted(seen), f)


def main() -> None:
    tweets = json.load(sys.stdin)
    seen = load_tracker()
    new_tweets = [t for t in tweets if str(t.get("id", "")) not in seen]
    seen.update(str(t.get("id", "")) for t in new_tweets)
    save_tracker(seen)
    json.dump(new_tweets, sys.stdout)


if __name__ == "__main__":
    main()
