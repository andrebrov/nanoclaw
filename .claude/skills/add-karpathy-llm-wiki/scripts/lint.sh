#!/usr/bin/env bash
# lint.sh — LLM wiki linting engine
#
# Scans compiled wiki articles for contradictions, stale entries, and missing
# cross-links. Requires: claude CLI (installed globally in NanoClaw agent containers).
#
# Usage: lint.sh [--knowledge-dir <path>]
#   Default knowledge-dir: ./knowledge (relative to CWD)
#
# Output files written to <knowledge-dir>/lint/:
#   contradictions.md  — factual conflicts between articles
#   stale.md           — articles older than 30 days with external-fact references
#   missing-links.md   — named entities missing [[slug]] cross-links
#   summary.md         — brief totals, updated after each run
#
# Triggers:
#   - On-demand:       bash /workspace/global/knowledge/scripts/lint.sh
#   - Weekly schedule: NanoClaw scheduled task (Sundays 2am)

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

WIKI_DIR="$KNOWLEDGE_DIR/wiki"
LINT_DIR="$KNOWLEDGE_DIR/lint"

mkdir -p "$LINT_DIR"

if [[ ! -d "$WIKI_DIR" ]]; then
  echo "No wiki directory found at $WIKI_DIR — nothing to lint"
  exit 0
fi

mapfile -t wiki_files < <(find "$WIKI_DIR" -maxdepth 1 -name "*.md" ! -name "INDEX.md" | sort)

if [[ ${#wiki_files[@]} -eq 0 ]]; then
  echo "No wiki articles found in $WIKI_DIR — nothing to lint"
  exit 0
fi

echo "Linting ${#wiki_files[@]} wiki article(s) in $WIKI_DIR"
TODAY=$(date +%Y-%m-%d)
TODAY_EPOCH=$(date +%s)

# ---------------------------------------------------------------------------
# 1. Contradiction detection
# ---------------------------------------------------------------------------
echo ""
echo "==> Check 1: Contradiction detection"

all_articles=""
for wiki_file in "${wiki_files[@]}"; do
  slug=$(basename "$wiki_file" .md)
  all_articles+="### Article: $slug"$'\n'"$(cat "$wiki_file")"$'\n\n'
done

contradiction_prompt="You are a wiki linter performing a contradiction check.

Review the following wiki articles for factual contradictions — cases where two articles make conflicting claims about the same fact (e.g. conflicting role assignments, conflicting metrics, conflicting dates, conflicting descriptions of the same entity).

For each contradiction found:
1. Name both articles involved
2. Quote the conflicting claims verbatim
3. Suggest which is likely correct, or mark \"unresolvable without more info\"

Format each finding as:

### Contradiction N
**Articles:** <slug-a> vs <slug-b>
**Claim in <slug-a>:** \"...\"
**Claim in <slug-b>:** \"...\"
**Assessment:** ...

If no contradictions exist, output exactly: NO CONTRADICTIONS FOUND

## Articles

$all_articles"

echo "  Running contradiction check via Claude..."
if ! contradiction_output=$(claude --print "$contradiction_prompt" 2>&1); then
  echo "  WARNING: Claude failed for contradiction check" >&2
  contradiction_output="ERROR: Claude analysis failed."
fi

{
  echo "# Wiki Contradiction Report"
  echo ""
  echo "Generated: $TODAY | Articles scanned: ${#wiki_files[@]}"
  echo ""
  echo "$contradiction_output"
} >"$LINT_DIR/contradictions.md"

if echo "$contradiction_output" | grep -q "^NO CONTRADICTIONS FOUND"; then
  contradiction_count=0
else
  # Count "### Contradiction" headings; fall back to 1 if any non-trivial output
  contradiction_count=$(echo "$contradiction_output" | grep -c "^### Contradiction" || true)
  if [[ $contradiction_count -eq 0 && ! "$contradiction_output" =~ "NO CONTRADICTIONS FOUND" && ${#contradiction_output} -gt 20 ]]; then
    contradiction_count=1
  fi
fi
echo "  Found: $contradiction_count contradiction(s)"

# ---------------------------------------------------------------------------
# 2. Stale entry detection
# ---------------------------------------------------------------------------
echo ""
echo "==> Check 2: Stale entry detection"

STALE_DAYS=30
stale_entries=()

for wiki_file in "${wiki_files[@]}"; do
  slug=$(basename "$wiki_file" .md)

  updated=$(grep "^updated:" "$wiki_file" | head -1 | sed 's/^updated:[[:space:]]*//' | tr -d "\"'" | tr -d '[:space:]')
  [[ -z "$updated" ]] && continue

  # date -d is Linux (glibc); containers are Linux so this is safe
  article_epoch=$(date -d "$updated" +%s 2>/dev/null) || continue

  age_days=$(( (TODAY_EPOCH - article_epoch) / 86400 ))
  [[ $age_days -le $STALE_DAYS ]] && continue

  # Flag only articles that reference external facts
  external_refs=$(grep -cE '\b(company|companies|CEO|CTO|founded|revenue|employees|percent|%|market|version|release)\b' "$wiki_file" 2>/dev/null || true)
  [[ $external_refs -eq 0 ]] && continue

  stale_entries+=("$slug|$updated|$age_days|$external_refs")
done

{
  echo "# Wiki Stale Entry Report"
  echo ""
  echo "Generated: $TODAY | Threshold: ${STALE_DAYS} days | Articles scanned: ${#wiki_files[@]}"
  echo ""
  if [[ ${#stale_entries[@]} -eq 0 ]]; then
    echo "No stale articles with external-fact references found."
  else
    echo "Articles last updated more than ${STALE_DAYS} days ago that reference external facts (companies, people, metrics). These may contain outdated information and should be reviewed."
    echo ""
    echo "| Article | Last Updated | Age (days) | External Refs |"
    echo "|---------|-------------|-----------|--------------|"
    for entry in "${stale_entries[@]}"; do
      IFS='|' read -r name updated_val age refs <<<"$entry"
      echo "| $name | $updated_val | $age | $refs |"
    done
  fi
} >"$LINT_DIR/stale.md"

stale_count=${#stale_entries[@]}
echo "  Found: $stale_count stale article(s)"

# ---------------------------------------------------------------------------
# 3. Missing cross-link detection
# ---------------------------------------------------------------------------
echo ""
echo "==> Check 3: Missing cross-link detection"

# Build slug list for Claude reference
slugs_list=$(for f in "${wiki_files[@]}"; do basename "$f" .md; done | sort | tr '\n' ', ' | sed 's/,$//')

{
  echo "# Wiki Missing Cross-Link Report"
  echo ""
  echo "Generated: $TODAY | Articles scanned: ${#wiki_files[@]}"
  echo ""
} >"$LINT_DIR/missing-links.md"

missing_link_count=0

for wiki_file in "${wiki_files[@]}"; do
  slug=$(basename "$wiki_file" .md)
  article_content=$(cat "$wiki_file")

  cross_link_prompt="You are a wiki linter checking for missing cross-links.

## Known Article Slugs

$slugs_list

## Article Under Review: $slug

$article_content

## Task

Identify named entities in this article (people, companies, concepts, products, projects) that:
1. Have their own wiki article in the slug list above
2. Are NOT already referenced with [[slug]] syntax in the article body

For each missing link found, format as:

### Missing link N
**Entity:** ...
**Should link to:** [[slug]]
**Context:** \"quote the sentence where the link belongs\"

If no missing links exist, output exactly: NO MISSING LINKS

Only flag clear, unambiguous cases where a slug directly corresponds to the named entity."

  echo "  Checking: $slug"
  if ! link_output=$(claude --print "$cross_link_prompt" 2>&1); then
    echo "    WARNING: Claude failed for $slug" >&2
    continue
  fi

  if echo "$link_output" | grep -q "^NO MISSING LINKS"; then
    continue
  fi

  {
    echo "## $slug"
    echo ""
    echo "$link_output"
    echo ""
  } >>"$LINT_DIR/missing-links.md"

  found=$(echo "$link_output" | grep -c "^### Missing link" || true)
  missing_link_count=$((missing_link_count + found))
done

if [[ $missing_link_count -eq 0 ]]; then
  echo "No missing links found." >>"$LINT_DIR/missing-links.md"
fi

echo "  Found: $missing_link_count missing link(s)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
total_issues=$((contradiction_count + stale_count + missing_link_count))

echo ""
echo "=== Wiki Lint Complete ==="
echo "  Contradictions : $contradiction_count"
echo "  Stale articles : $stale_count"
echo "  Missing links  : $missing_link_count"
echo "  Reports        : $LINT_DIR/"

summary_line="Wiki lint ($TODAY): ${contradiction_count} contradiction(s), ${stale_count} stale article(s), ${missing_link_count} missing link(s). Reports: /workspace/global/knowledge/lint/"

{
  echo "# Wiki Lint Summary"
  echo ""
  echo "**Last run:** $TODAY"
  echo ""
  echo "| Check | Issues found |"
  echo "|-------|-------------|"
  echo "| Contradictions | $contradiction_count |"
  echo "| Stale articles | $stale_count |"
  echo "| Missing links | $missing_link_count |"
  echo ""
  echo "## Reports"
  echo "- [Contradictions](contradictions.md)"
  echo "- [Stale Entries](stale.md)"
  echo "- [Missing Links](missing-links.md)"
} >"$LINT_DIR/summary.md"

# Emit a machine-readable summary line for the NanoClaw task runner to relay
if [[ $total_issues -gt 0 ]]; then
  echo ""
  echo "LINT_SUMMARY: $summary_line"
fi
