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

-- INTEGER-time hypertables (observed_at is BIGINT epoch-ms, not a native
-- timestamp) need an explicit "what counts as now" function, or compression/
-- retention policies fail at runtime with "integer_now function not set"
-- (verified live 2026-07-03 — the hypertables/compression policies below
-- applied without error, but every scheduled compression job then silently
-- failed at its first run). DATE-partitioned neuron_daily doesn't need this.
CREATE OR REPLACE FUNCTION current_epoch_ms() RETURNS BIGINT
LANGUAGE SQL STABLE AS $$
  SELECT (extract(epoch from now()) * 1000)::BIGINT
$$;
SELECT set_integer_now_func('blocks',         'current_epoch_ms');
SELECT set_integer_now_func('extrinsics',     'current_epoch_ms');
SELECT set_integer_now_func('account_events', 'current_epoch_ms');
SELECT set_integer_now_func('chain_events',   'current_epoch_ms');

ALTER TABLE blocks         SET (timescaledb.compress, timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE extrinsics     SET (timescaledb.compress, timescaledb.compress_segmentby = 'signer', timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE account_events SET (timescaledb.compress, timescaledb.compress_segmentby = 'hotkey', timescaledb.compress_orderby = 'observed_at DESC');
ALTER TABLE chain_events   SET (timescaledb.compress, timescaledb.compress_segmentby = 'pallet', timescaledb.compress_orderby = 'observed_at DESC');

SELECT add_compression_policy('blocks',         BIGINT '604800000');  -- 7d in ms
SELECT add_compression_policy('extrinsics',     BIGINT '604800000');
SELECT add_compression_policy('account_events', BIGINT '604800000');
SELECT add_compression_policy('chain_events',   BIGINT '604800000');
