#!/usr/bin/env python3
"""Continuous chain indexer (ADR 0013 / #2110) — the gap-free, prune-proof
replacement for the GitHub poller + the streamer + the */3 R2-staging drain.

It follows the FINALIZED finney head from a durable cursor and, for each block,
decodes it with the EXACT verified extractors from fetch-events.py (reused via
stream-events.decode_head — imported, never duplicated, so there is no decode
drift) and writes the `blocks` / `extrinsics` / `account_events` rows STRAIGHT
into Postgres with idempotent `INSERT ... ON CONFLICT DO NOTHING` (the same keys
as the D1 era, so overlapping ranges re-insert harmlessly). On startup it
backfills the gap cursor->head; against an archive node, raise
EVENTS_MAX_LOOKBACK so an arbitrarily long gap is recovered in full. Then it
subscribes to finalized heads for steady state.

The DRASTIC win is continuity: a single long-running process with a durable
cursor captures ~100% of blocks, vs the ~58% the coalesced GitHub cron loses
(ADR 0012). Co-located with the node + Postgres on the bare-metal box (ADR 0013),
every hop is localhost.

INTEGRATION-PENDING: the pure row-builders + cursor logic are unit-tested
(scripts/test_index_chain.py, no chain/DB needed). The live RPC/Postgres path is
verified against the bare-metal node + Postgres once provisioned — the ADR 0013
gate is "~100% capture vs D1" before any serving cutover.

Heavy deps (psycopg2, substrate-interface) are imported lazily so the pure
transforms test without them. Run (the compose stack wires these):
  DATABASE_URL          postgresql://… (the Timescale sink)
  EVENTS_RPC_URL        ws://subtensor:9944 (the local node)  [default: public finney]
  REDIS_URL             redis://redis:6379  (optional — cursor/heartbeat mirror)
  START_BLOCK           cold-cursor anchor (else the overlap floor)
  EVENTS_WINDOW         overlap re-scan floor (default 256)
  EVENTS_MAX_LOOKBACK   max blocks one backfill reaches back (raise for archive)
"""
import importlib.util
import json
import logging
import os
import random
import signal
import sys
import time

RPC = os.environ.get("EVENTS_RPC_URL", "wss://entrypoint-finney.opentensor.ai:443")
WINDOW = int(os.environ.get("EVENTS_WINDOW", "256"))
MAX_LOOKBACK = int(os.environ.get("EVENTS_MAX_LOOKBACK", "512"))
START_BLOCK = os.environ.get("START_BLOCK")
MAX_BACKOFF = 60
SUMMARY_EVERY = max(1, int(os.environ.get("INDEXER_SUMMARY_EVERY_BLOCKS", "50")))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
log = logging.getLogger("indexer")

# Target table column orders — MUST match deploy/postgres/schema.sql.
BLOCK_COLS = (
    "block_number", "block_hash", "parent_hash", "author",
    "extrinsic_count", "event_count", "spec_version", "observed_at",
)
EXTRINSIC_COLS = (
    "block_number", "extrinsic_index", "extrinsic_hash", "signer",
    "call_module", "call_function", "success", "fee_tao", "tip_tao",
    "call_args", "observed_at",
)
EVENT_COLS = (
    "block_number", "event_index", "extrinsic_index", "event_kind",
    "hotkey", "coldkey", "netuid", "uid", "amount", "alpha", "observed_at",
)


def _json_obj(value):
    """call_args arrives from the verified decode (_safe_json) as a COMPACT JSON
    STRING, not an object. Parse it back so the single psycopg2 Json() wrap at
    insert time stores a proper JSONB object — not a double-encoded scalar string
    (which would break every `call_args->>'…'` serving query)."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return None
    return value  # already an object or None


def _as_bool(value):
    """`success` arrives as 1/0 (int) from _extrinsic_success_map, but the Postgres
    `extrinsics.success` column is BOOLEAN (strict — unlike the loose D1/SQLite era).
    Coerce; None stays NULL (index missing its ExtrinsicSuccess/Failed event)."""
    return None if value is None else bool(value)


def _has_ts(row):
    """observed_at is BIGINT NOT NULL. decode_head emits None when a block's
    Timestamp query fails; drop such rows (mirrors the D1-era Worker validators
    the direct Postgres sink bypasses) so the INSERT never hits a NOT NULL
    violation. Recent misses self-heal via the overlap re-scan (idempotent
    re-insert once the timestamp resolves)."""
    return isinstance(row.get("observed_at"), int)


def rows_from_decoded(decoded):
    """PURE: a decoded block (the stream-events.decode_head shape) -> column dicts
    keyed exactly by the Postgres schema. No DB/chain access — unit-tested.

    The block + extrinsic dicts already use the schema's column names; account
    events are remapped (amount_tao -> amount, alpha_amount -> alpha) and keep
    uid. call_args is decoded from its JSON-string form; rows missing a valid
    observed_at are dropped (NOT NULL).
    """
    blocks = []
    block = decoded.get("block")
    if block:
        b = {c: block.get(c) for c in BLOCK_COLS}
        if _has_ts(b):
            blocks.append(b)
    extrinsics = []
    for x in decoded.get("extrinsics") or []:
        row = {c: x.get(c) for c in EXTRINSIC_COLS}
        row["call_args"] = _json_obj(row["call_args"])
        row["success"] = _as_bool(row.get("success"))
        if _has_ts(row):
            extrinsics.append(row)
    events = []
    for e in decoded.get("events") or []:
        row = {
            "block_number": e.get("block_number"),
            "event_index": e.get("event_index"),
            "extrinsic_index": e.get("extrinsic_index"),
            "event_kind": e.get("event_kind"),
            "hotkey": e.get("hotkey"),
            "coldkey": e.get("coldkey"),
            "netuid": e.get("netuid"),
            "uid": e.get("uid"),
            "amount": e.get("amount_tao"),
            "alpha": e.get("alpha_amount"),
            "observed_at": e.get("observed_at"),
        }
        if _has_ts(row):
            events.append(row)
    return {"blocks": blocks, "extrinsics": extrinsics, "account_events": events}


def backfill_start(cursor, head, start_block_env):
    """PURE: the first block to index this run. A cold cursor with START_BLOCK set
    anchors there (initial historical anchor); otherwise the cursor-aware floor
    from fetch-events.compute_from_block (overlap re-scan + gap recovery)."""
    if cursor is None and start_block_env is not None:
        return max(0, int(start_block_env))
    return _compute_from_block(cursor, head, WINDOW, max_lookback=MAX_LOOKBACK)


# --- lazy reuse of the verified decode + cursor math (hyphenated module paths) --
_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(modname, filename):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _compute_from_block(cursor, head, window, max_lookback):
    fe = _load("fetch_events", "fetch-events.py")
    return fe.compute_from_block(cursor, head, window, max_lookback=max_lookback)


def _decode_head():
    # stream-events imports the verified decode; reuse it so the mapping never
    # drifts from the streamer/poller.
    se = _load("stream_events", "stream-events.py")
    return se.decode_head


# --- Postgres I/O (lazy psycopg2) -------------------------------------------
def _upsert(conn, table, cols, dict_rows, conflict):
    from psycopg2.extras import Json, execute_values

    if not dict_rows:
        return 0
    tuples = []
    for r in dict_rows:
        row = []
        for c in cols:
            v = r.get(c)
            if c == "call_args" and v is not None:
                v = Json(v)
            row.append(v)
        tuples.append(tuple(row))
    sql = (
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES %s "
        f"ON CONFLICT ({conflict}) DO NOTHING"
    )
    with conn.cursor() as cur:
        execute_values(cur, sql, tuples)
        return cur.rowcount


def read_cursor(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT last_block FROM indexer_cursor WHERE id = 1")
        row = cur.fetchone()
        return row[0] if row else None


def write_cursor(conn, redis_client, last_block):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO indexer_cursor (id, last_block, updated_at) "
            "VALUES (1, %s, now()) ON CONFLICT (id) DO UPDATE SET "
            "last_block = GREATEST(indexer_cursor.last_block, EXCLUDED.last_block), "
            "updated_at = now()",
            (last_block,),
        )
    if redis_client is not None:
        try:  # heartbeat is best-effort — never fail ingest on a Redis blip
            redis_client.set("indexer:last_block", last_block)
            redis_client.set("indexer:heartbeat", int(time.time()))
        except Exception:
            pass


def process_block(decode_head, s, conn, redis_client, bn):
    """Decode + idempotently upsert one block, advance the cursor, commit."""
    rows = rows_from_decoded(decode_head(s, bn))
    _upsert(conn, "blocks", BLOCK_COLS, rows["blocks"], "block_number")
    _upsert(conn, "extrinsics", EXTRINSIC_COLS, rows["extrinsics"], "block_number, extrinsic_index")
    _upsert(conn, "account_events", EVENT_COLS, rows["account_events"], "block_number, event_index")
    write_cursor(conn, redis_client, bn)
    conn.commit()
    return len(rows["account_events"]), len(rows["extrinsics"])


_stop = False


def _handle_signal(signum, _frame):
    global _stop
    _stop = True
    log.info("received signal %s — shutting down after the current block", signum)


def run():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is required")
        sys.exit(1)
    import psycopg2

    from substrateinterface import SubstrateInterface

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    decode_head = _decode_head()
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    redis_client = None
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        try:
            import redis

            redis_client = redis.from_url(redis_url)
        except Exception as e:  # noqa: BLE001 — Redis is an optional heartbeat mirror
            log.warning("redis unavailable (%s) — heartbeat disabled", repr(e)[:120])

    log.info("starting · rpc=%s · window=%d · max_lookback=%d", RPC, WINDOW, MAX_LOOKBACK)
    done = 0
    backoff = 5
    while not _stop:
        try:
            s = SubstrateInterface(url=RPC)
            # Warm the runtime metadata BEFORE the cold backfill. decode_head's
            # per-block `s.query(...)` needs `s.metadata`, which is lazy-loaded;
            # the streamer gets it implicitly because it only decodes from inside
            # subscribe_block_headers (which inits the runtime first). The indexer
            # decodes in the backfill loop first, so without this the very first
            # query raises AttributeError: 'NoneType' has no attribute
            # 'get_metadata_pallet'. init_runtime() loads metadata at the head;
            # recent blocks share that runtime version, so it is reused.
            s.init_runtime()
            backoff = 5  # reset after a clean connect
            cursor = read_cursor(conn)
            head = s.get_block_number(s.get_chain_finalised_head())
            start = backfill_start(cursor, head, START_BLOCK)
            if start <= head:
                log.info("backfill #%d..#%d (cursor=%s)", start, head, cursor)
                for bn in range(start, head + 1):
                    if _stop:
                        break
                    process_block(decode_head, s, conn, redis_client, bn)
                    done += 1
                    if done % SUMMARY_EVERY == 0:
                        log.info("indexed %d blocks · latest=#%d", done, bn)
            if _stop:
                break
            log.info("caught up at #%d — following finalized heads", head)

            def handler(obj, _update_nr, _subscription_id):
                if _stop:
                    return True  # non-None cancels the subscription
                bn = obj["header"]["number"]
                ev, xt = process_block(decode_head, s, conn, redis_client, bn)
                nonlocal done
                done += 1
                log.debug("block #%d: %d events, %d extrinsics", bn, ev, xt)
                if done % SUMMARY_EVERY == 0:
                    log.info("healthy · %d blocks · latest=#%d", done, bn)
                return None

            s.subscribe_block_headers(handler, finalized_only=True)
        except Exception as e:  # noqa: BLE001 — RPC or DB error; recover + retry
            if _stop:
                break
            # Clear any aborted transaction (autocommit is off): a failed INSERT
            # leaves the connection in InFailedSqlTransaction, so without this the
            # next read_cursor re-raises "current transaction is aborted" forever —
            # a tight ~5s crash loop that never advances the cursor. If the
            # connection itself died, reconnect rather than reuse a dead handle.
            try:
                conn.rollback()
            except Exception:
                pass
            if getattr(conn, "closed", 0):
                try:
                    conn.close()
                except Exception:
                    pass
                try:
                    conn = psycopg2.connect(db_url)
                    conn.autocommit = False
                except Exception:
                    pass
            sleep_for = backoff + random.uniform(0, backoff / 2)
            log.error("indexer error (%s) — recovering in %.1fs", repr(e)[:160], sleep_for)
            time.sleep(sleep_for)
            backoff = min(backoff * 2, MAX_BACKOFF)
    try:
        conn.close()
    except Exception:
        pass
    log.info("stopped · indexed %d blocks this run", done)


if __name__ == "__main__":
    run()
