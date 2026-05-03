#!/bin/bash
# rule-of-three/track.sh — update the repetition counter for a fingerprint.
#
# Usage:
#   track.sh <fingerprint> "<summary>"  — increment counter, print new count
#   track.sh --suppress <fingerprint>   — mark fingerprint as suppressed
#
# Counter file: /workspace/memory/rule-of-three.json

set -euo pipefail

COUNTER_FILE="/workspace/memory/rule-of-three.json"
MAX_EXAMPLES=5

if [ ! -f "$COUNTER_FILE" ]; then
  echo '{"version":1,"counters":{}}' > "$COUNTER_FILE"
fi

if [ "${1:-}" = "--suppress" ]; then
  FINGERPRINT="${2:-}"
  if [ -z "$FINGERPRINT" ]; then
    echo "Usage: track.sh --suppress <fingerprint>" >&2
    exit 1
  fi
  UPDATED=$(jq --arg fp "$FINGERPRINT" \
    '.counters[$fp] //= {count:0,suppressed:false,examples:[],lastSeen:null} |
     .counters[$fp].suppressed = true' \
    "$COUNTER_FILE")
  echo "$UPDATED" > "${COUNTER_FILE}.tmp" && mv "${COUNTER_FILE}.tmp" "$COUNTER_FILE"
  echo "Suppressed: $FINGERPRINT"
  exit 0
fi

FINGERPRINT="${1:-}"
SUMMARY="${2:-}"

if [ -z "$FINGERPRINT" ]; then
  echo "Usage: track.sh <fingerprint> [summary]" >&2
  exit 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

UPDATED=$(jq \
  --arg fp "$FINGERPRINT" \
  --arg summary "$SUMMARY" \
  --arg now "$NOW" \
  --argjson max "$MAX_EXAMPLES" \
  '
    .counters[$fp] //= {count: 0, suppressed: false, examples: [], lastSeen: null} |
    .counters[$fp].count += 1 |
    .counters[$fp].lastSeen = $now |
    if ($summary != "" and (.counters[$fp].examples | length) < $max)
    then .counters[$fp].examples += [$summary]
    else . end
  ' "$COUNTER_FILE")

echo "$UPDATED" > "${COUNTER_FILE}.tmp" && mv "${COUNTER_FILE}.tmp" "$COUNTER_FILE"

COUNT=$(echo "$UPDATED" | jq -r --arg fp "$FINGERPRINT" '.counters[$fp].count')
SUPPRESSED=$(echo "$UPDATED" | jq -r --arg fp "$FINGERPRINT" '.counters[$fp].suppressed')

echo "rule-of-three: $FINGERPRINT count=$COUNT suppressed=$SUPPRESSED"
