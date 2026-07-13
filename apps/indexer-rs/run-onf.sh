#!/bin/bash
# BOOSTER: 7M→8.498M (recent history) backfill against the metered OnFinality
# archive key. Fast while the daily quota lasts, then stalls until reset — that is
# fine, because the opentensor spine (run-archive.sh) covers the deep range
# continuously, so its daily stall is never a global "dead period". Writes the
# same tables, a DISJOINT block range, its own progress file → no conflict with
# the spine (per-session TEMP staging + idempotent ON CONFLICT).
#
# BACKFILL_CONCURRENCY=1: this single process has no sharding, and subxt
# deadlocks a single client's per-block metadata fetch above conc=1 (verified
# in entrypoint.sh; independently reconfirmed in metagraphed-infra's
# indexer-rust role, which found even conc=4 against a real archive RPC stalls
# every shard). This script ran at conc=6, squarely in the deadlock range.
cd "$(dirname "$0")"
source ./onf.env
export DATABASE_URL="$(cat .pgurl)"
export EVENTS_RPC_URL="$ONF_WSS"
export BACKFILL_FROM=7000000
export BACKFILL_TO=8498000
export BACKFILL_CHUNK=1000
export BACKFILL_CONCURRENCY=1
export BACKFILL_PROGRESS=progress.onf.json
exec caffeinate -i bash -c '
while true; do
  ./backfill-rs >> backfill.onf.log 2>&1
  echo "$(date +%H:%M:%S) [supervisor] backfill-rs exited $? — resuming in 10s" >> backfill.onf.log
  sleep 10
done'
