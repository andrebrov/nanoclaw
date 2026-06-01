---
name: Host Stuck-Claim Heartbeat-Masking Fix
description: The host kills and recovers an orphaned 'processing' claim once it ages past the absolute ceiling, even when a fresh per-session heartbeat from unrelated work would otherwise mask it.
targets:
  - ../src/host-sweep.ts
---

# Host Stuck-Claim Heartbeat-Masking Fix

## Background

This is the host-side complement deferred by
`stale-processing-claim-self-heal.spec.md` ("Out of scope: Host-side
`decideStuckAction` fix"). Both close the same failure from two sides; this
one is the backstop that works even when the container's self-heal is absent
(old image) or itself wedged.

A container claims a message by writing a `processing_ack` row with status
`'processing'` to `outbound.db`; `messages_in.status` stays `'pending'`. The
claim is cleared only when the turn finishes (`'completed'`). If the turn dies
mid-flight — OOM `SIGKILL` (exit 137), idle-eviction, or a host restart killing
the in-flight container — the ack is orphaned in `'processing'`. The container's
`getPendingMessages` excludes every id present in `processing_ack`, so the
still-`pending` task is invisible to the live container forever.

The host's per-claim stuck detection (`decideStuckAction`, `src/host-sweep.ts`)
is meant to recover this by killing the container and resetting the message
(`kill-claim` → `resetStuckProcessingRows` → `deleteOrphanProcessingClaims`).
But it skipped any claim when `heartbeatMtimeMs > claimedAt` ("we saw a
heartbeat since the claim"). A session running a frequent cheap recurring task
(e.g. `*/4` meeting-prep) touches the per-session heartbeat constantly, so the
heartbeat is always newer than a stale claim from an unrelated heavy task — the
orphan was masked indefinitely and the host never recovered it.

**Restart trigger.** A host restart is the canonical event that creates these
orphans: `cleanupOrphans()` kills the in-flight container, the replacement
re-claims work, and any claim left behind by a turn that dies again (or never
completes) is stranded. Observed 2026-06-01: session `4k0m1g` held three
`chat-sdk` claims for 88 minutes after a 16:01 host restart with a fresh
heartbeat the whole time.

## Goal

Once a `'processing'` claim ages past the host's absolute ceiling, the host
recovers it regardless of heartbeat freshness, so an interrupted task is not
stranded by unrelated activity on the same session.

## Key invariant

The absolute ceiling is `max(ABSOLUTE_CEILING_MS, declaredBashMs, declaredMaxMs)`
— the same value used for the heartbeat-age `kill-ceiling` check. A genuinely
long turn extends this ceiling by declaring its Bash/max timeout. Therefore a
claim older than `ceiling` on a still-living container cannot be a legitimate
in-flight turn — it is an orphan. A claim younger than `ceiling` is still
excused by a fresh heartbeat, preserving normal in-progress-turn protection.

## In scope

- In `decideStuckAction`'s per-claim loop, the fresh-heartbeat exemption
  (`heartbeatMtimeMs > claimedAt`) applies only while `claimAge <= ceiling`.
  Past the ceiling, `kill-claim` fires regardless of heartbeat.
  `[@test] ../src/host-sweep.test.ts`

## Acceptance criteria

- A `'processing'` claim older than the absolute ceiling, with a heartbeat
  newer than the claim, yields `kill-claim` (previously `ok`).
  `[@test] ../src/host-sweep.test.ts`
- A claim younger than the ceiling with a fresh heartbeat still yields `ok`
  (no regression to in-progress-turn protection).
  `[@test] ../src/host-sweep.test.ts`
- A long claim under a widened (declared Bash/max) ceiling with a fresh
  heartbeat still yields `ok` — the override only fires past the ceiling.
  `[@test] ../src/host-sweep.test.ts`

## Out of scope (explicitly deferred)

- **Poison-batch / retry cap.** Same deferral as the container-side spec: a
  task that legitimately cannot complete will be re-killed and re-run each time
  it ages past the ceiling. A `tries`-cap / dead-letter is a separate change.
- No change to `markProcessing` / `markCompleted` / `getPendingMessages`
  semantics, nor to the heartbeat-age `kill-ceiling` path.
