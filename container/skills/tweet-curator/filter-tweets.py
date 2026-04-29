#!/usr/bin/env python3
"""Filter tweets against seen-IDs tracker. Reads JSON tweets from stdin, outputs unseen ones.

Also prunes the seen list: IDs older than 48 hours (based on insertion order) are dropped
so that Twitter search returning stale results doesn't permanently block the pipeline.
"""
import json
import sys
from datetime import datetime, timedelta

TRACKER = "/workspace/group/tweet-curator-seen.json"
# Max age for seen IDs — after this, a tweet can resurface (prevents permanent blocking)
MAX_SEEN_AGE_HOURS = 48
# Max seen entries to keep
MAX_SEEN_IDS = 500

def load_tracker():
    try:
        with open(TRACKER) as f:
            data = json.load(f)
            # Migrate old format (flat list) to timestamped format
            if isinstance(data.get("seen_ids"), list) and data["seen_ids"] and not isinstance(data["seen_ids"][0], dict):
                data["seen_ids"] = [{"id": sid, "ts": data.get("last_updated", datetime.now().isoformat())} for sid in data["seen_ids"]]
            return data
    except:
        return {"seen_ids": [], "last_updated": ""}

def save_tracker(tracker):
    cutoff = (datetime.now() - timedelta(hours=MAX_SEEN_AGE_HOURS)).isoformat()
    # Prune entries older than cutoff
    tracker["seen_ids"] = [e for e in tracker["seen_ids"] if e.get("ts", "") >= cutoff]
    # Cap size
    tracker["seen_ids"] = tracker["seen_ids"][-MAX_SEEN_IDS:]
    tracker["last_updated"] = datetime.now().isoformat()
    with open(TRACKER, "w") as f:
        json.dump(tracker, f, indent=2)

def main():
    tracker = load_tracker()
    seen = {e["id"] for e in tracker["seen_ids"]}

    raw = sys.stdin.read().strip()
    if not raw:
        print("[]")
        return

    try:
        tweets = json.loads(raw)
    except:
        print("[]", file=sys.stderr)
        print("Error: invalid JSON input", file=sys.stderr)
        return

    if not isinstance(tweets, list):
        tweets = [tweets]

    now = datetime.now().isoformat()
    unseen = []
    new_entries = []
    for tweet in tweets:
        tid = str(tweet.get("id", tweet.get("tweet_id", "")))
        if tid and tid not in seen:
            unseen.append(tweet)
            new_entries.append({"id": tid, "ts": now})
            seen.add(tid)

    tracker["seen_ids"].extend(new_entries)
    save_tracker(tracker)

    print(json.dumps(unseen, indent=2))
    print(f"Filtered: {len(tweets)} total → {len(unseen)} new, {len(tweets) - len(unseen)} skipped (seen list: {len(tracker['seen_ids'])} after prune)", file=sys.stderr)

if __name__ == "__main__":
    main()
