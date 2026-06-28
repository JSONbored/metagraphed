#!/bin/bash
# BOOSTER: 7M→8.498M (recent history) backfill against the metered OnFinality
# archive key. Fast while the daily quota lasts, then stalls until reset — that is
# fine, because the opentensor spine (run-archive.sh) covers the deep range
# continuously, so its daily stall is never a global "dead period". Writes the
# same tables, a DISJOINT block range, its own progress file → no conflict with
# the spine (per-session TEMP staging + idempotent ON CONFLICT).
cd "$(dirname "$0")"
source ./onf.env
export DATABASE_URL="$(cat .pgurl)"
export EVENTS_RPC_URL="$ONF_WSS"
export BACKFILL_FROM=7000000
export BACKFILL_TO=8498000
export BACKFILL_CHUNK=1000
export BACKFILL_CONCURRENCY=6
export BACKFILL_PROGRESS=progress.onf.json
exec caffeinate -i bash -c '
while true; do
  ./backfill-rs >> backfill.onf.log 2>&1
  echo "$(date +%H:%M:%S) [supervisor] backfill-rs exited $? — resuming in 10s" >> backfill.onf.log
  sleep 10
done'
