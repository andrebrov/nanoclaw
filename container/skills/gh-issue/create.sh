#!/bin/bash
# gh-issue/create.sh — file a GitHub issue against andrebrov/nano-claw with
# the `ai-fix` label so the AI-fix workflow picks it up.
#
# Auth: OneCLI auto-injects Authorization on api.github.com requests; the
# placeholder Bearer header here gets overwritten by the proxy. No GitHub
# token in env or files inside the container.

set -euo pipefail

REPO="${GH_ISSUE_REPO:-andrebrov/nano-claw}"
LABEL="${GH_ISSUE_LABEL:-ai-fix}"

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <title> <body>" >&2
  echo "  Title:  one-line summary" >&2
  echo "  Body:   markdown" >&2
  exit 1
fi

TITLE="$1"
BODY="$2"

# JSON-encode title and body via jq so quotes/newlines are safe.
PAYLOAD=$(jq -n \
  --arg title "$TITLE" \
  --arg body "$BODY" \
  --arg label "$LABEL" \
  '{title: $title, body: $body, labels: [$label]}')

RESPONSE=$(curl -sS -w "\n%{http_code}" \
  -X POST "https://api.github.com/repos/$REPO/issues" \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer placeholder-overwritten-by-onecli-proxy" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(printf '%s\n' "$RESPONSE" | tail -n1)
BODY_OUT=$(printf '%s\n' "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "201" ]; then
  echo "GitHub API error (HTTP $HTTP_CODE):" >&2
  echo "$BODY_OUT" >&2
  exit 1
fi

URL=$(printf '%s\n' "$BODY_OUT" | jq -r '.html_url')
NUMBER=$(printf '%s\n' "$BODY_OUT" | jq -r '.number')

echo "Issue #$NUMBER created: $URL"
