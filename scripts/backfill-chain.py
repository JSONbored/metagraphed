#!/usr/bin/env python3
"""One-time historical backfill (ADR 0013) — walks a bounded block range from an
ARCHIVE RPC into Postgres INDEPENDENTLY of the live indexer, so deep history fills
WITHOUT stalling live ingestion.

It reuses the indexer's verified decode + idempotent upserts (rows_from_decoded,
_upsert) so there is zero decode/schema drift. Progress is a SEPARATE cursor row
(indexer_cursor id=2) — it never touches the live cursor (id=1), and the
`INSERT ... ON CONFLICT DO NOTHING` keys make concurrent backfill + live-follow
safe (overlapping ranges re-insert harmlessly).

Run as a one-time Railway service (deploy/backfill.railway.json) or manually:
  DATABASE_URL          postgresql://…        (the SAME Postgres as the indexer)
  EVENTS_RPC_URL        wss://archive.chain…  (an ARCHIVE endpoint — a pruned node
                        can't serve old state and the backfill will fail)
  BACKFILL_DEPTH_DAYS   how far back from head to fill (default 365 ≈ 12 months)
  BACKFILL_FROM / BACKFILL_TO   explicit block-range override
  BACKFILL_BATCH        blocks per commit (default 100)
  BACKFILL_SLEEP_MS     pause between blocks, rate-limit-friendly (default 0)
It resumes from the id=2 cursor on restart and exits 0 when the range is complete.
"""
import importlib.util
import logging
import os
import signal
import sys
import time

BLOCKS_PER_DAY = 7200  # ~1 block / 12s
BACKFILL_ID = 2  # progress row; the live indexer is id=1

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(modname, filename):
    spec = importlib.util.spec_from_file_location(
        modname, os.path.join(_HERE, filename)
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Reuse the indexer's verified decode + idempotent upserts (no duplication).
ic = _load("index_chain", "index-chain.py")

RPC = os.environ.get("EVENTS_RPC_URL", "wss://archive.chain.opentensor.ai:443")
DEPTH_DAYS = int(os.environ.get("BACKFILL_DEPTH_DAYS", "365"))
BATCH = max(1, int(os.environ.get("BACKFILL_BATCH", "100")))
SLEEP_MS = max(0, int(os.environ.get("BACKFILL_SLEEP_MS", "0")))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
log = logging.getLogger("backfill")

_stop = False


def _handle_signal(_signum, _frame):
    global _stop
    _stop = True


def backfill_range(head, depth_days, env_from, env_to):
    """PURE: the [from, to] block range to fill. Explicit env overrides win;
    otherwise [head - depth_days*BLOCKS_PER_DAY, head]. Clamped to >= 0."""
    to = int(env_to) if env_to else int(head)
    frm = int(env_from) if env_from else to - depth_days * BLOCKS_PER_DAY
    return max(0, frm), to


def _read_progress(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT last_block FROM indexer_cursor WHERE id = %s", (BACKFILL_ID,)
        )
        row = cur.fetchone()
        return row[0] if row else None


def _write_progress(conn, last_block):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO indexer_cursor (id, last_block, updated_at) "
            "VALUES (%s, %s, now()) ON CONFLICT (id) DO UPDATE SET "
            "last_block = GREATEST(indexer_cursor.last_block, EXCLUDED.last_block), "
            "updated_at = now()",
            (BACKFILL_ID, last_block),
        )


def _flush(conn, decoded_batch):
    for rows in decoded_batch:
        ic._upsert(conn, "blocks", ic.BLOCK_COLS, rows["blocks"], "block_number")
        ic._upsert(
            conn,
            "extrinsics",
            ic.EXTRINSIC_COLS,
            rows["extrinsics"],
            "block_number, extrinsic_index",
        )
        ic._upsert(
            conn,
            "account_events",
            ic.EVENT_COLS,
            rows["account_events"],
            "block_number, event_index",
        )
        # The generic all-events tier (ADR 0013): rows_from_decoded produces it and
        # the live indexer upserts it too, so a backfilled range must fill it or the
        # deep-history /api/v1/chain-events reads are silently empty (schema drift the
        # module docstring promises against). Same conflict key as account_events.
        ic._upsert(
            conn,
            "chain_events",
            ic.CHAIN_EVENT_COLS,
            rows["chain_events"],
            "block_number, event_index",
        )


def run():
    import psycopg2
    from substrateinterface import SubstrateInterface

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is required")
        sys.exit(1)

    decode_head = ic._decode_head()  # loads stream-events (installs its handlers)
    signal.signal(signal.SIGTERM, _handle_signal)  # ours wins after that load
    signal.signal(signal.SIGINT, _handle_signal)

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    s = SubstrateInterface(url=RPC)
    s.init_runtime()  # warm metadata before the cold-range decode

    head = s.get_block_number(s.get_chain_finalised_head())
    frm, to = backfill_range(
        head, DEPTH_DAYS, os.environ.get("BACKFILL_FROM"), os.environ.get("BACKFILL_TO")
    )
    progress = _read_progress(conn)
    bn = max(frm, (progress + 1) if progress is not None else frm)
    log.info(
        "backfill #%d..#%d (resume @ #%d, depth=%dd, rpc=%s)",
        frm, to, bn, DEPTH_DAYS, RPC,
    )

    committed = bn - 1
    batch = []
    batch_last = committed
    while bn <= to and not _stop:
        try:
            batch.append(ic.rows_from_decoded(decode_head(s, bn)))
            batch_last = bn
            if len(batch) >= BATCH or bn == to:
                _flush(conn, batch)
                _write_progress(conn, batch_last)
                conn.commit()
                committed = batch_last
                batch = []
                pct = 100 * (committed - frm + 1) / max(1, to - frm + 1)
                log.info("backfilled through #%d (%.1f%%)", committed, pct)
            bn += 1
            if SLEEP_MS:
                time.sleep(SLEEP_MS / 1000)
        except Exception as e:  # noqa: BLE001 — RPC/DB blip: rollback, reconnect, retry
            try:
                conn.rollback()
            except Exception:
                pass
            batch = []
            bn = committed + 1  # retry from after the last COMMITTED block (idempotent)
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
            log.error("backfill error near #%d (%s) — retry in 5s", bn, repr(e)[:160])
            time.sleep(5)
            try:
                s.get_chain_finalised_head()  # liveness probe
            except Exception:
                try:
                    s = SubstrateInterface(url=RPC)
                    s.init_runtime()
                except Exception:
                    pass

    if _stop:
        log.info("stopped at #%d (resumable from the id=2 cursor)", committed)
    else:
        log.info("backfill complete: #%d..#%d", frm, to)


if __name__ == "__main__":
    run()
