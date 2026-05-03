# Issue #199 Investigation Notes

**Issue**: Track: RULES.md diet (12K removal)

## Summary

Issue #199 is a **tracking issue**, not a directly implementable change. It
aggregates 4 child PRs (see `jbaruch/nanoclaw-admin#181`–`#183`) that together
reduce `.tessl/RULES.md` by ~12K bytes. This document records why no
source-level edit is applicable in this repository.

## Why no code change is possible here

### 1. `.tessl/RULES.md` is gitignored and auto-generated

The file that needs to shrink — `.tessl/RULES.md` — is listed in `.gitignore`:

```
.tessl/
```

It is assembled at `tessl install` time from the tiles pinned in `tessl.json`
and is never committed. Editing it directly would have no effect (it would
be overwritten on the next `tessl install`).

### 2. The per-item breakdown lives in a private admin repo

The child issues (`jbaruch/nanoclaw-admin#180`–`#183`) that describe _which_
content to remove (postmortems, schema specs, inline reference material) are
in an inaccessible private repository. Without reading those issues the exact
removals cannot be determined.

### 3. The fix requires upstream tile changes, not repo changes

Content that ends up in `.tessl/RULES.md` comes from the vendored tile
sources (e.g. `tessl-labs/spec-driven-development`, `uinaf/verify`, etc.).
Reducing RULES.md requires either:

- Removing a tile from `tessl.json` entirely, or
- Publishing a slimmer version of an upstream tile (external change).

Neither of these is an actionable single diff in this repository without
knowing the specific tile(s) to trim.

## What the acceptance criteria require

> 4 PRs merged, RULES.md reduced by ~12K bytes.

Each of the 4 PRs would likely:
1. Identify one category of content to remove (postmortem, schema spec, etc.)
2. Modify or remove the relevant tile in `tessl.json`, or update to a tile
   version that no longer includes that content
3. Verify `.tessl/RULES.md` is smaller after `tessl install`

## Recommendation

A human with access to `jbaruch/nanoclaw-admin#181`–`#183` should:
1. Read the per-item breakdown in those issues
2. Create the 4 individual PRs that modify `tessl.json` or the relevant tile sources
3. Close #199 once all 4 PRs are merged and RULES.md is ~12K lighter
