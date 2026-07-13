#!/bin/bash
# Resumable 12-month backfill (free OnFinality tier). Re-run after a reboot; it
# resumes from progress.json. caffeinate keeps the Mac awake while it runs.
#
# BACKFILL_CONCURRENCY=1: subxt's per-block at_block() metadata fetch deadlocks
# a single client above conc=1 (verified: conc=1 commits, conc>=4 hangs -- see
# entrypoint.sh; independently reconfirmed against the public archive RPC in
# metagraphed-infra's indexer-rust role, which found even conc=4 against a
# real endpoint stalls every shard with zero rows landed). This script predates
# that finding and ran at conc=6, which is squarely in the deadlock range --
# progress.json's own stalled completed_through is consistent with having hit
# it. entrypoint.sh sidesteps this with SEPARATE conc=1 processes (sharding)
# instead of in-client concurrency; this single-process script has no sharding,
# so conc=1 is the only safe value here.
cd "$(dirname "$0")"
source ./onf.env
export DATABASE_URL="$(cat .pgurl)"
export EVENTS_RPC_URL="$ONF_WSS"
export BACKFILL_FROM=5868000
export BACKFILL_TO=8498001
export BACKFILL_CHUNK=500
export BACKFILL_CONCURRENCY=1
export BACKFILL_PROGRESS=progress.json
exec caffeinate -i ./backfill-rs
