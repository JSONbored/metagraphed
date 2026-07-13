#!/usr/bin/env bash
# Shard launcher. Historically hardcoded every shard's in-client concurrency to 1:
# subxt's default (chainHead-based) backend deadlocked when >1 concurrent at_block()
# raced the same chainHead_v1_follow subscription's uncached historical metadata
# over ONE client (verified: conc=1 commits, conc>=4 hangs). connect_chain() now
# builds the client via LegacyBackend instead (stateless one-shot RPC calls, no
# subscription to race) -- see the KNOWN ISSUE comment in main.rs -- which removes
# that specific deadlock mechanism. Live-verified (2026-07-12) against our own
# archive node while it was mid-sync: in-client concurrency scales ~linearly up to
# at least 32 (2.4 -> 7.4 -> 15.0 -> 28.2 -> 55+ blk/s at conc 1/4/8/16/32) with no
# measurable impact on the archive node's own sync rate or CPU. BACKFILL_SHARD_CONCURRENCY
# controls this now instead of a hardcoded 1; still shard across SEPARATE processes
# (not one giant in-client concurrency number) so a stuck/reconnecting shard's WS
# drop only affects its own slice, and each shard keeps its own durable progress file.
set -u
FROM="${BACKFILL_FROM:-1}"
TO="${BACKFILL_TO:-8498000}"
SHARDS="${BACKFILL_SHARDS:-8}"
CHUNK="${BACKFILL_CHUNK:-1000}"
SHARD_CONCURRENCY="${BACKFILL_SHARD_CONCURRENCY:-1}"
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
echo "launcher: [$FROM,$TO) -> $SHARDS shards (~$per blocks/shard), conc=$SHARD_CONCURRENCY/shard, chunk=$CHUNK"

run_shard() {
  local i="$1" sfrom="$2" sto="$3"
  while true; do
    echo "[launcher] shard $i starting: [$sfrom,$sto)"
    BACKFILL_FROM="$sfrom" BACKFILL_TO="$sto" BACKFILL_CHUNK="$CHUNK" \
      BACKFILL_CONCURRENCY="$SHARD_CONCURRENCY" BACKFILL_PROGRESS="$DATA/progress.shard-$i.json" \
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
