---
name: Stale Processing-Claim Self-Heal
description: A live agent container periodically reclaims its own orphaned 'processing' claims so scheduled tasks interrupted mid-turn re-run without requiring a container restart.
targets:
  - ../container/agent-runner/src/poll-loop.ts
  - ../container/agent-runner/src/db/connection.ts
---

# Stale Processing-Claim Self-Heal

## Background

Scheduled tasks are `messages_in` rows (`kind='task'`) in a session's
`inbound.db`. The container poll loop processes a batch by:

1. `markProcessing(ids)` — writes `processing_ack` rows with status
   `'processing'` to `outbound.db`.
2. Running the agent turn.
3. `markCompleted(processingIds)` at `poll-loop.ts:438` — the **only** place
   claims are cleared, at the END of the iteration (it runs even on query
   error, so errors do not orphan).

`getPendingMessages` (`db/messages-in.ts:88-96`) filters out **every** id
present in `processing_ack`, regardless of status. So any claim left in
`'processing'` makes its task permanently invisible to the live container —
`messages_in.status` stays `'pending'` but it is never re-fetched.

**The orphan window:** if the container process dies between step 1 and step 3
— OOM `SIGKILL` (exit 137 at the 1500m `memory_limit`), idle-eviction, or a
host stuck-kill — the claims are left `'processing'`.

**Why existing recovery is insufficient (the 2026-06-01 incident):**

- `clearStaleProcessingAcks` (`db/connection.ts:216`,
  `DELETE FROM processing_ack WHERE status='processing'`) is the intended
  cleanup, but it runs **only once at container startup** (`poll-loop.ts:114`).
  A long-lived container that never restarts never re-runs it.
- The host's per-claim stuck detection (`decideStuckAction`,
  `src/host-sweep.ts:250`) skips any claim when
  `heartbeatMtimeMs > claimedAt` ("we saw a heartbeat since the claim").
  When a frequent cheap recurring task (e.g. `*/4 * * * *` meeting-prep) shares
  the session, it calls `touchHeartbeat()` constantly, so the heartbeat is
  always newer than a stale heavy-task claim — the orphan is masked
  indefinitely and the host never kills/recovers.

Net result on 2026-06-01: the daily agenda, lead-discovery, newsletter,
deep-research, Snitcher scan, and the meeting/call-prep task all sat
`'processing'` for hours and silently never ran. Full incident analysis:
`incident-orphaned-processing-claim-masking` (agent memory).

## Goal

A live container heals its own orphaned claims without needing a restart, so an
interrupted scheduled task re-runs on its own within a bounded delay.

## Key invariant

The poll loop is single-threaded and sequential: each iteration calls
`markCompleted(processingIds)` (line 438) before the next iteration begins. A
normally-completed batch leaves its rows in status `'completed'`, not
`'processing'`. Therefore, **at the top of a fresh iteration when the container
is idle, any row still in `'processing'` is necessarily an orphan from a prior,
interrupted turn** — never the in-flight turn (there is none yet) and never the
concurrent-follow-up case (those rows belong to a turn that is still running,
which only exists mid-iteration, not at the top).

## In scope

- A new reclaim function in `db/connection.ts`, e.g.
  `reclaimStaleProcessingAcks(staleMs: number): string[]`, that deletes
  `processing_ack` rows with status `'processing'` whose `status_changed` is
  older than `staleMs`, and returns the deleted message ids. Deleting the ack
  row (rather than flipping a status) is what makes `getPendingMessages`
  re-include the task, since its `messages_in.status` is still `'pending'`.
  `[@test] ../container/agent-runner/src/db/connection.test.ts`

- A reclaim pass in the poll loop, run at the **top of each iteration before
  fetching new work** (i.e. when no turn is in flight). It calls
  `reclaimStaleProcessingAcks(STALE_PROCESSING_MS)` and, for any ids returned,
  logs a single `reclaimed N stale processing claim(s)` line so the recovery is
  visible in container logs.
  `[@test] ../container/agent-runner/src/poll-loop.test.ts`

- `STALE_PROCESSING_MS` constant set to **30 minutes**, matching the host's
  absolute idle ceiling (`CEILING` / 30 min in `host-sweep.ts`). Rationale: a
  legitimately long turn is expected to call `extend_ceiling`; beyond the
  30-min ceiling the host would kill the container anyway, so a claim older than
  that on a still-living container is unambiguously orphaned. A claim younger
  than this is left alone so a normal in-progress turn is never disturbed.

- Behavior must be a no-op when there are no stale claims (returns empty list,
  logs nothing, no write).
  `[@test] ../container/agent-runner/src/db/connection.test.ts`

## Out of scope (explicitly deferred)

- **Poison-batch protection.** If a task legitimately cannot complete (too
  heavy, repeatedly OOMs), self-heal will re-run it every 30 min indefinitely.
  A `tries`-cap / dead-letter and capping the per-turn task-batch size are a
  separate change (incident fix direction 3). This spec does NOT add a retry
  cap; it documents the risk.
- **Host-side `decideStuckAction` fix** (firing despite a fresh sibling
  heartbeat) — a separate, complementary change. Self-heal makes the container
  recover on its own so the host masking is no longer load-bearing, but the
  host bug is not corrected here.
- No change to `markProcessing` / `markCompleted` / `getPendingMessages` query
  semantics.

## Acceptance criteria

- A `processing_ack` row in status `'processing'` with `status_changed` older
  than 30 min on a running container is deleted on the next idle poll iteration,
  and its still-`pending` task is re-fetched and re-run.
  `[@test] ../container/agent-runner/src/poll-loop.test.ts`
- A `'processing'` row younger than 30 min is NOT reclaimed (in-flight turn
  protection).
  `[@test] ../container/agent-runner/src/db/connection.test.ts`
- `'completed'` rows are never touched.
  `[@test] ../container/agent-runner/src/db/connection.test.ts`
- No regression to the startup `clearStaleProcessingAcks` path.
