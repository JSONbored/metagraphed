#!/bin/bash
# Resumable 12-month backfill (free OnFinality tier). Re-run after a reboot; it
# resumes from progress.json. caffeinate keeps the Mac awake while it runs.
cd "$(dirname "$0")"
source ./onf.env
export DATABASE_URL="$(cat .pgurl)"
export EVENTS_RPC_URL="$ONF_WSS"
export BACKFILL_FROM=5868000
export BACKFILL_TO=8498001
export BACKFILL_CHUNK=500
export BACKFILL_CONCURRENCY=6
export BACKFILL_PROGRESS=progress.json
exec caffeinate -i ./backfill-rs
