#!/bin/bash
# SPINE: genesis→7M backfill against the FREE opentensor public archive.
# No daily quota → this source NEVER stalls, so there is always forward progress
# regardless of what the OnFinality booster (run-onf.sh) is doing. Resumes from
# progress.archive.json. The supervisor loop relaunches on any crash/exit; the
# client's request_timeout prevents silent hangs. caffeinate blocks idle sleep
# (NOT lid-close — keep the lid open / on AC for a long run).
cd "$(dirname "$0")"
export DATABASE_URL="$(cat .pgurl)"
export EVENTS_RPC_URL="wss://archive.chain.opentensor.ai:443"
export BACKFILL_FROM=0
export BACKFILL_TO=7000000
export BACKFILL_CHUNK=1000
export BACKFILL_CONCURRENCY=12
export BACKFILL_PROGRESS=progress.archive.json
exec caffeinate -i bash -c '
while true; do
  ./backfill-rs >> backfill.archive.log 2>&1
  echo "$(date +%H:%M:%S) [supervisor] backfill-rs exited $? — resuming in 10s" >> backfill.archive.log
  sleep 10
done'
