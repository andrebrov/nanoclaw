#!/usr/bin/env bash
# compile.sh — LLM wiki compilation engine
#
# Transforms knowledge/raw/ docs into structured knowledge/wiki/ articles.
# Requires: claude CLI (installed globally in NanoClaw agent containers).
#
# Usage: compile.sh [--knowledge-dir <path>]
#   Default knowledge-dir: ./knowledge (relative to CWD)
#
# Triggers:
#   - On-demand:        bash /workspace/global/knowledge/scripts/compile.sh
#   - Session-end hook: configured via settings.json (see SKILL.md)
#   - Daily schedule:   NanoClaw scheduled task at 3am

set -euo pipefail

KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-./knowledge}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --knowledge-dir | -d)
      KNOWLEDGE_DIR="$2"
      shift 2
      ;;
    --help | -h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

RAW_DIR="$KNOWLEDGE_DIR/raw"
WIKI_DIR="$KNOWLEDGE_DIR/wiki"
PROCESSED_DIR="$RAW_DIR/processed"
INDEX_FILE="$WIKI_DIR/INDEX.md"

mkdir -p "$WIKI_DIR" "$PROCESSED_DIR"

if [[ ! -f "$INDEX_FILE" ]]; then
  {
    echo "# Wiki Index"
    echo ""
    echo "| Article | Summary | Tags | Updated |"
    echo "|---------|---------|------|---------|"
  } >"$INDEX_FILE"
fi

mapfile -t raw_files < <(find "$RAW_DIR" -maxdepth 1 -type f | sort)

if [[ ${#raw_files[@]} -eq 0 ]]; then
  echo "No unprocessed files in $RAW_DIR"
  exit 0
fi

echo "Found ${#raw_files[@]} file(s) to process"
TODAY=$(date +%Y-%m-%d)

for raw_file in "${raw_files[@]}"; do
  filename=$(basename "$raw_file")
  echo ""
  echo "==> Processing: $filename"

  index_content=$(cat "$INDEX_FILE")
  raw_content=$(cat "$raw_file")

  # Gather existing articles as context for cross-linking
  existing_wiki=""
  while IFS= read -r -d '' wiki_file; do
    [[ "$(basename "$wiki_file")" == "INDEX.md" ]] && continue
    existing_wiki+="### $(basename "$wiki_file" .md)"$'\n'"$(cat "$wiki_file")"$'\n\n'
  done < <(find "$WIKI_DIR" -maxdepth 1 -name "*.md" -not -name "INDEX.md" -print0 2>/dev/null || true)

  prompt="You are a wiki compiler. Transform the raw source into a structured wiki article.

## Current Wiki Index

$index_content

## Existing Articles (for cross-linking)

$existing_wiki

## Raw Source

Filename: $filename

$raw_content

## Instructions

1. Decide: update an existing article (see index) or create a new one?
2. Write the complete article in this exact format:

---
title: Article Title
updated: $TODAY
tags: [tag1, tag2]
related: [slug-of-related]
---

## Summary
One paragraph.

## Detail
Full content. Use [[article-slug]] for cross-references.

## Cross-references
- [[related-slug]] — brief note

3. After the article, output exactly:

SLUG: your-article-slug

Slug rules: lowercase, hyphens only, max 50 chars, descriptive of the content."

  if ! output=$(claude --print "$prompt" 2>&1); then
    echo "  ERROR: claude failed for $filename" >&2
    echo "  $output" >&2
    continue
  fi

  # Extract slug from last SLUG: line
  slug=$(echo "$output" | grep "^SLUG:" | tail -1 | sed 's/^SLUG:[[:space:]]*//' | tr -d '[:space:]')
  if [[ -z "$slug" ]]; then
    slug=$(basename "$filename" | sed 's/\.[^.]*$//' |
      tr '[:upper:]' '[:lower:]' |
      tr -cs 'a-z0-9' '-' |
      sed 's/-\{2,\}/-/g; s/^-//; s/-$//')
    echo "  WARNING: No SLUG line found — using derived slug: $slug"
  fi

  # Strip SLUG: line from article content
  article_content=$(echo "$output" | grep -v "^SLUG:" | sed 's/[[:space:]]*$//')

  article_file="$WIKI_DIR/$slug.md"
  if [[ -f "$article_file" ]]; then
    echo "  Updating: $slug.md"
  else
    echo "  Creating: $slug.md"
  fi
  printf '%s\n' "$article_content" >"$article_file"

  # Extract fields for index row
  title=$(grep "^title:" "$article_file" | head -1 | sed 's/^title:[[:space:]]*//')
  tags=$(grep "^tags:" "$article_file" | head -1 | sed 's/^tags:[[:space:]]*//' | tr -d '[]')
  summary=$(awk '/^## Summary$/{found=1; next} found && /^[[:space:]]*$/{exit} found{print; exit}' "$article_file")

  # Remove stale index entry for this slug, then append fresh one
  tmp_index=$(mktemp)
  grep -v "\[$slug\]" "$INDEX_FILE" >"$tmp_index" || true
  mv "$tmp_index" "$INDEX_FILE"
  echo "| [$slug]($slug.md) | $summary | $tags | $TODAY |" >>"$INDEX_FILE"

  mv "$raw_file" "$PROCESSED_DIR/$filename"
  echo "  Moved to processed/"
done

wiki_count=$(find "$WIKI_DIR" -maxdepth 1 -name "*.md" -not -name "INDEX.md" | wc -l | tr -d ' ')
echo ""
echo "Compilation complete. $wiki_count article(s) in $WIKI_DIR"
