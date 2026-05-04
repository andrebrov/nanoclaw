#!/bin/bash
# Auto-sync nanoclaw to origin/main.
#
# Skips if there's any local diff (don't clobber in-progress work) or if
# we're not on main. Otherwise: pull, install, build, restart the host
# service. Called by nanoclaw-sync.service / nanoclaw-sync.timer.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[sync] local changes present — skipping"
  exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "[sync] not on main (on $branch) — skipping"
  exit 0
fi

git fetch origin main --quiet
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)
if [ "$local_sha" = "$remote_sha" ]; then
  echo "[sync] up to date ($local_sha)"
  exit 0
fi

echo "[sync] pulling $local_sha → $remote_sha"
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run build
systemctl --user restart nanoclaw
echo "[sync] restarted nanoclaw"
