#!/usr/bin/env bash
# Shard launcher. subxt deadlocks when >1 concurrent at_block() races the same
# uncached historical metadata over ONE client (verified: conc=1 commits, conc>=4
# hangs). So instead of in-client concurrency, run BACKFILL_SHARDS SEPARATE
# processes — each its own subxt client + WS connection + metadata cache, each at
# conc=1 (deadlock-free) over a disjoint slice of [FROM,TO). K shards => K x ~3.3
# blk/s. Each shard has its own durable progress file on /data and a supervisor
# loop that resumes it on crash. Progress survives restarts/redeploys (volume).
set -u
FROM="${BACKFILL_FROM:-1}"
TO="${BACKFILL_TO:-8498000}"
SHARDS="${BACKFILL_SHARDS:-8}"
CHUNK="${BACKFILL_CHUNK:-1000}"
BIN=/app/backfill-rs
DATA=/data

# LIVE indexer mode: a single follow-head process (the binary's INDEX_MODE=live);
# no sharding — live is one block at a time, so the concurrency deadlock can't occur.
if [ "${INDEX_MODE:-}" = "live" ]; then
  echo "entrypoint: live indexer mode (single process, follow head)"
  exec "$BIN"
fi

total=$((TO - FROM))
per=$(((total + SHARDS - 1) / SHARDS))
echo "launcher: [$FROM,$TO) -> $SHARDS shards (~$per blocks/shard), conc=1/shard, chunk=$CHUNK"

run_shard() {
  local i="$1" sfrom="$2" sto="$3"
  while true; do
    echo "[launcher] shard $i starting: [$sfrom,$sto)"
    BACKFILL_FROM="$sfrom" BACKFILL_TO="$sto" BACKFILL_CHUNK="$CHUNK" \
      BACKFILL_CONCURRENCY=1 BACKFILL_PROGRESS="$DATA/progress.shard-$i.json" \
      "$BIN"
    echo "[launcher] shard $i exited ($?) — resume in 10s"
    sleep 10
  done
}

for i in $(seq 0 $((SHARDS - 1))); do
  sfrom=$((FROM + i * per))
  sto=$((sfrom + per))
  [ "$sto" -gt "$TO" ] && sto="$TO"
  [ "$sfrom" -ge "$TO" ] && break
  run_shard "$i" "$sfrom" "$sto" &
done
wait
