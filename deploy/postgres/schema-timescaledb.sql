-- metagraphed-core chain sink — OPTIONAL TimescaleDB upgrade (ADR 0013)
--
-- Apply this AFTER deploy/postgres/schema.sql, and only on a Postgres that
-- actually has the TimescaleDB extension available (e.g. the
-- timescale/timescaledb Docker image, or a self-hosted box with the
-- extension installed). Plain Railway Postgres does NOT have this extension
-- — do not apply this file there; schema.sql alone is a complete, working
-- schema without it.
--
-- Compressed hypertables for the time-series tiers. Integer-time hypertables
-- on observed_at (epoch ms). Daily tables partition on their DATE column.
-- Compression on chunks older than 7 days (~10-20x on chain data); cold
-- partitions are exported to R2 Parquet (see deploy/README.md).
--
-- The four CHAIN tables use 30-day chunks (2_592_000_000 ms), not the 1-day
-- interval the observability tables use. They hold the full backfilled chain
-- history -- ~3.2 years and growing -- so at 1 day they accumulate ~1,180
-- chunks each. That is a write-path problem, not a storage one: the indexer's
-- flush() does INSERT ... SELECT FROM a temp table, whose runtime values the
-- planner cannot chunk-prune, so every flush takes locks proportional to the
-- chunk count. Measured live 2026-07-31 at 1-day chunks: concurrent backfill
-- flushes stuck 7-13 minutes on LockManager/relation locks with throughput at
-- ~0; at 30 days the same workload runs with zero lock waits.
--
-- chunk_time_interval only applies to chunks created AFTER it is set, so an
-- existing deployment also needs set_chunk_time_interval() -- see
-- migrations/0045_widen_chain_hypertable_chunk_interval.sql.
--
-- Decided in JSO-2054/#2518 (option (a): Postgres/TimescaleDB, no co-located
-- columnar engine). Requires the composite PKs in schema.sql (block_number,
-- ..., observed_at) — a bare (block_number) PK fails create_hypertable() with
-- "cannot create a unique index without the column ... used in partitioning"
-- (verified live 2026-07-03, was a real, silent blocker before the PK fix
-- landed).

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('blocks',         'observed_at', chunk_time_interval => 2592000000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('extrinsics',     'observed_at', chunk_time_interval => 2592000000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('account_events', 'observed_at', chunk_time_interval => 2592000000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('chain_events',   'observed_at', chunk_time_interval => 2592000000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('neuron_daily',   'snapshot_date', chunk_time_interval => INTERVAL '30 days', migrate_data => true, if_not_exists => true);
-- Written every 15 minutes (~150-200 surfaces/run, wrangler.jsonc
-- "*/15 * * * *") with the shortest retention of anything here -- D1 keeps
-- only a 30-day hot window before pruning, so a 1-day chunk interval keeps
-- individual chunks small without accumulating chunks indefinitely.
SELECT create_hypertable('surface_checks', 'checked_at', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);
-- metagraphed#8317: written every ~60s for 3 components (~4.3k rows/day), the
-- highest-frequency/lowest-volume table here. 1-day chunks, and unlike every
-- other hypertable it gets an explicit retention policy -- the 90-day serving
-- data lives in self_health_daily, so raw ticks are only ever needed for
-- recent debugging.
SELECT create_hypertable('self_health_checks', 'checked_at_ms', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);

-- INTEGER-time hypertables (observed_at is BIGINT epoch-ms, not a native
-- timestamp) need an explicit "what counts as now" function, or compression/
-- retention policies fail at runtime with "integer_now function not set"
-- (verified live 2026-07-03 — the hypertables/compression policies below
-- applied without error, but every scheduled compression job then silently
-- failed at its first run). DATE-partitioned neuron_daily doesn't need this.
-- Guarded, not 5 bare SELECT set_integer_now_func(...) calls: unlike every
-- other statement in this file, set_integer_now_func has no if_not_exists
-- option and hard-ERRORs ("custom time function already set for hypertable
-- X") if called on a hypertable that already has one -- confirmed live
-- 2026-07-18 running this file a second time against the already-configured
-- indexer box (metagraphed-infra#95, which relies on this whole file being
-- safe to re-run unconditionally on every Ansible apply).
CREATE OR REPLACE FUNCTION current_epoch_ms() RETURNS BIGINT
LANGUAGE SQL STABLE AS $$
  SELECT (extract(epoch from now()) * 1000)::BIGINT
$$;
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['blocks', 'extrinsics', 'account_events', 'chain_events', 'surface_checks', 'self_health_checks'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM timescaledb_information.dimensions
      WHERE hypertable_name = tbl AND integer_now_func IS NOT NULL
    ) THEN
      PERFORM set_integer_now_func(tbl, 'current_epoch_ms');
    END IF;
  END LOOP;
END $$;

ALTER TABLE blocks         SET (timescaledb.compress, timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE extrinsics     SET (timescaledb.compress, timescaledb.compress_segmentby = 'signer', timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE account_events SET (timescaledb.compress, timescaledb.compress_segmentby = 'hotkey', timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE chain_events   SET (timescaledb.compress, timescaledb.compress_segmentby = 'pallet', timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE surface_checks SET (timescaledb.compress, timescaledb.compress_segmentby = 'surface_id', timescaledb.compress_orderby = 'checked_at DESC');

-- if_not_exists => true on all 5: unlike ALTER TABLE...SET (timescaledb.compress...)
-- above (idempotent by default), add_compression_policy hard-ERRORs ("compression
-- policy already exists") if called twice on the same hypertable -- confirmed live
-- 2026-07-18 running this file a second time against the already-configured indexer
-- box (metagraphed-infra#95). Postgres's own error even hints at this exact fix.
SELECT add_compression_policy('blocks',         BIGINT '604800000', if_not_exists => true);  -- 7d in ms
SELECT add_compression_policy('extrinsics',     BIGINT '604800000', if_not_exists => true);
SELECT add_compression_policy('account_events', BIGINT '604800000', if_not_exists => true);
SELECT add_compression_policy('chain_events',   BIGINT '604800000', if_not_exists => true);
SELECT add_compression_policy('surface_checks', BIGINT '604800000', if_not_exists => true);

-- No compression policy for self_health_checks, unlike every other hypertable
-- above: add_compression_policy requires ALTER TABLE ... SET
-- (timescaledb.compress ...) first, and compressing chunks that a 14-day
-- retention policy is about to drop anyway buys nothing -- at ~4.3k rows/day
-- the whole 7-14 day compressible window is about 30k rows.
--
-- The only retention policy in this file. self_health_daily carries the
-- 90-day serving numbers, so the raw per-tick rows can go after 14 days --
-- and they should: at ~4.3k rows/day they're the fastest-growing table here
-- by row count. if_not_exists for the same re-runnability reason as the
-- compression policies above (metagraphed-infra#95 applies this file on
-- every Ansible run).
SELECT add_retention_policy('self_health_checks', BIGINT '1209600000', if_not_exists => true);  -- 14d in ms
