# Issue #130 Investigation Notes

**Issue**: Untrusted containers: IPC backlog overflow + filtered DB WAL-on-RO mount

## Summary

After a thorough investigation of the codebase, the specific code described in issue #130
does not exist in this repository. This document records the findings.

## Bug 1 — IPC backlog (`drainIpcInput` / `consumedInputFiles`)

The issue describes a `drainIpcInput()` function that tries to `fs.unlinkSync` IPC files
from an `input/` directory mounted read-only for untrusted containers, with an in-memory
`consumedInputFiles` Set that resets on container restart.

**Findings:**

- `drainIpcInput` — not found anywhere in the codebase
- `consumedInputFiles` — not found anywhere in the codebase
- No `input/` directory is mounted for any container (trusted or untrusted) in
  `src/container-runner.ts`
- No `check-unanswered` scripts exist

**Why:** The v2 architecture replaced all IPC file communication with session DBs
(`inbound.db` / `outbound.db`). The only IPC filesystem code in the repository is the
x-integration skill (`container/skills/x-integration/`), which is explicitly labeled
"Compatibility: NanoClaw v1.0.0" and was never integrated into the main host-side
code paths.

Container mounts for all sessions are:
- `/workspace/` ← `data/v2-sessions/<agentGroupId>/<sessionId>/` (read-write)
- `/workspace/messages.db` ← `data/messages.db` (read-only)
- `/workspace/host-logs/v2.db` ← `data/v2.db` (read-only, admin containers only)
- `additionalMounts` (read-only for untrusted containers)

There is no `input/` directory mount anywhere.

## Bug 2 — Filtered DB WAL on RO mount (`createFilteredDb`)

The issue describes a `createFilteredDb` function that sets only `busy_timeout` but not
`journal_mode`, causing SQLite to default to WAL mode. When the resulting DB is mounted
read-only, it fails because SQLite cannot create `-wal`/`-shm` sidecar files on a
read-only mount.

**Findings:**

- `createFilteredDb` — not found anywhere in the codebase

**Closest analog — `messages.db` and `v2.db` (WAL mode, RO-mounted):**

Both databases are opened in WAL mode on the host and mounted read-only in containers:

- `src/message-store.ts` explicitly sets `journal_mode = WAL` (with a comment noting this
  is intentional for concurrent host writes + container reads)
- `data/v2.db` (central DB) is also in WAL mode

However, neither causes the described failure, because:

1. `messages.db` is mounted at `/workspace/messages.db`, and the `/workspace/` directory
   itself is the RW session mount — SQLite can create `-shm` files there.
2. `v2.db` is mounted at `/workspace/host-logs/v2.db`, and `/workspace/host-logs/` is
   similarly writable from inside the container.

The container-side connections (`container/agent-runner/src/db/connection.ts` and
`container/agent-runner/src/mcp-tools/observability.ts`) open these databases in readonly
mode without setting `journal_mode`. For WAL-mode databases, readonly SQLite opens require
a `-shm` file but will create one if the directory is writable — which it is in both cases.

## Conclusion

The functions and code paths described in issue #130 do not exist in this codebase.
The issue references `jbaruch/nanoclaw#287`, suggesting the bugs are present in a fork
or an earlier version of NanoClaw that had IPC-file-based container communication.

The v2 rewrite eliminated IPC files entirely in favor of the session DB architecture.
No fix is applicable here.
