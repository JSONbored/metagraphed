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
# Blocks to stay behind the node's own imported head when BACKFILL_TO=auto.
# The archive node is still syncing; asking for a block it has not imported
# yet is a hard failure for the whole chunk, so leave a margin.
AUTO_TO_MARGIN="${BACKFILL_AUTO_TO_MARGIN:-2000}"
BIN=/app/backfill-rs
DATA=/data

# LIVE indexer mode: a single follow-head process (the binary's INDEX_MODE=live);
# no sharding — live is one block at a time, so the concurrency deadlock can't occur.
if [ "${INDEX_MODE:-}" = "live" ]; then
  echo "entrypoint: live indexer mode (single process, follow head)"
  exec "$BIN"
fi

# BACKFILL_TO=auto: track the source node's CURRENT height instead of a fixed
# cap. This exists for the "tail" backfill that closes the gap between the
# bulk backfill's cap and where live-follow's coverage begins -- the archive
# node is still syncing into that range, so the reachable end moves. With a
# fixed cap the container simply exits when it gets there and the rest of the
# gap is never filled; re-deriving it here (plus run_shard's restart loop
# below, and main.rs's resume_point accepting a range whose END GREW) makes
# the tail advance on its own as the node syncs.
AUTO_MODE=0
if [ "$TO" = "auto" ]; then
  AUTO_MODE=1
  RPC="${EVENTS_RPC_URL:-}"
  head_hex=$(curl -s -m 20 -H 'content-type: application/json' \
    -d '{"id":1,"jsonrpc":"2.0","method":"chain_getHeader","params":[]}' "$RPC" \
    | sed -n 's/.*"number":"\(0x[0-9a-fA-F]*\)".*/\1/p')
  if [ -z "$head_hex" ]; then
    echo "launcher: BACKFILL_TO=auto but chain_getHeader failed against $RPC — retrying in 30s"
    sleep 30
    exec "$0" "$@"
  fi
  head_dec=$((head_hex))
  TO=$((head_dec - AUTO_TO_MARGIN))
  echo "launcher: BACKFILL_TO=auto -> node head $head_dec, using $TO (margin $AUTO_TO_MARGIN)"
  if [ "$TO" -le "$FROM" ]; then
    echo "launcher: node head has not reached BACKFILL_FROM yet — sleeping 300s"
    sleep 300
    exec "$0" "$@"
  fi
fi

total=$((TO - FROM))
per=$(((total + SHARDS - 1) / SHARDS))
echo "launcher: [$FROM,$TO) -> $SHARDS shards (~$per blocks/shard), conc=$SHARD_CONCURRENCY/shard, chunk=$CHUNK"

# Discover the whole range's runtime-version segments ONCE, before any shard
# starts, and hand every shard the same file. Without this each shard re-probed
# its own slice sequentially (multi-minute, near-silent, and N-way concurrent
# with its siblings) on EVERY container start -- see main.rs's discover-only
# mode. Retried because a fresh archive-node restart can transiently fail
# probes; shards must not start without the file (they'd fall back to slow
# per-shard discovery and recreate exactly the thundering herd this avoids).
# In auto mode the end moves every iteration, so key the file on FROM alone --
# otherwise each re-derive writes a new file and re-runs discovery. The map is
# only ever appended to at the end (later blocks = later runtime versions), and
# a shard whose range now extends past the file's last segment simply falls
# back to subxt's own per-block lookup for that tail, which is correct.
if [ "$AUTO_MODE" = "1" ]; then
  SPEC_FILE="$DATA/spec-ranges.$FROM.auto.json"
else
  SPEC_FILE="$DATA/spec-ranges.$FROM.$TO.json"
fi
until [ -s "$SPEC_FILE" ]; do
  echo "launcher: discovering spec ranges -> $SPEC_FILE"
  BACKFILL_DISCOVER_TO_FILE="$SPEC_FILE" BACKFILL_FROM="$FROM" BACKFILL_TO="$TO" "$BIN" \
    || { echo "launcher: spec discovery failed, retrying in 15s"; sleep 15; }
done
export BACKFILL_SPEC_FILE="$SPEC_FILE"

run_shard() {
  local i="$1" sfrom="$2" sto="$3"
  while true; do
    echo "[launcher] shard $i starting: [$sfrom,$sto)"
    BACKFILL_FROM="$sfrom" BACKFILL_TO="$sto" BACKFILL_CHUNK="$CHUNK" \
      BACKFILL_CONCURRENCY="$SHARD_CONCURRENCY" BACKFILL_PROGRESS="$DATA/progress.shard-$i.json" \
      "$BIN"
    rc=$?
    # In auto mode a clean exit means "caught up to the head we derived at
    # startup", not "done" -- return so the launcher can re-derive a newer
    # head. A FAILURE still retries in place, exactly as in fixed mode.
    if [ "$AUTO_MODE" = "1" ] && [ "$rc" -eq 0 ]; then
      echo "[launcher] shard $i reached the derived head — will re-derive"
      return 0
    fi
    echo "[launcher] shard $i exited ($rc) — resume in 10s"
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

# Fixed mode never gets here (run_shard loops forever). Auto mode does, once
# every shard has caught up to the head derived at startup: wait for the node
# to import more, then re-exec to derive a fresh head and continue. The
# progress files carry over -- main.rs's resume_point accepts a range whose
# end has GROWN, so this resumes where it left off instead of re-walking.
if [ "$AUTO_MODE" = "1" ]; then
  # Drop the spec map so the next pass re-discovers over the NEW, longer
  # range. Keeping it would leave every block past its last segment without a
  # mapping, silently falling back to subxt's per-block Core_version call --
  # correct, but the slow path this whole mechanism exists to avoid. The tail
  # range spans one or two runtime eras, so re-discovery costs seconds.
  rm -f "$SPEC_FILE"
  echo "launcher: caught up to $TO; re-deriving the node head in ${BACKFILL_AUTO_POLL_SECS:-600}s"
  sleep "${BACKFILL_AUTO_POLL_SECS:-600}"
  exec "$0" "$@"
fi
