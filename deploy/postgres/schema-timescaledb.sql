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
-- on observed_at (epoch ms): chunk interval = 1 day = 86_400_000 ms. Daily
-- tables partition on their DATE column. Compression on chunks older than
-- 7 days (~10-20x on chain data); cold partitions are exported to R2 Parquet
-- (see deploy/README.md).
--
-- Decided in JSO-2054/#2518 (option (a): Postgres/TimescaleDB, no co-located
-- columnar engine). Requires the composite PKs in schema.sql (block_number,
-- ..., observed_at) — a bare (block_number) PK fails create_hypertable() with
-- "cannot create a unique index without the column ... used in partitioning"
-- (verified live 2026-07-03, was a real, silent blocker before the PK fix
-- landed).

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('blocks',         'observed_at', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('extrinsics',     'observed_at', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('account_events', 'observed_at', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('chain_events',   'observed_at', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);
SELECT create_hypertable('neuron_daily',   'snapshot_date', chunk_time_interval => INTERVAL '30 days', migrate_data => true, if_not_exists => true);
-- Written every 15 minutes (~150-200 surfaces/run, wrangler.jsonc
-- "*/15 * * * *") with the shortest retention of anything here -- D1 keeps
-- only a 30-day hot window before pruning, so a 1-day chunk interval keeps
-- individual chunks small without accumulating chunks indefinitely.
SELECT create_hypertable('surface_checks', 'checked_at', chunk_time_interval => 86400000, migrate_data => true, if_not_exists => true);

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
  FOREACH tbl IN ARRAY ARRAY['blocks', 'extrinsics', 'account_events', 'chain_events', 'surface_checks'] LOOP
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
