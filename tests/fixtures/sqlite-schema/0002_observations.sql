-- Observation tables on D1: the probe-derived history series coming HOME.
--
-- These four tables were BORN on D1 (migrations/0001_health.sql,
-- 0003_uptime_history.sql, 0008_economics_history.sql in this repo's history)
-- and were mirrored to the self-hosted Postgres in #4832, with D1's copies
-- retired on 2026-07-16 once the mirrors had a full window. That box is now
-- being decommissioned, so the tables come back -- same keys, same epoch-ms
-- timestamp convention they always had (which is why, unlike the registry's
-- 0001_registry.sql, almost nothing here needed translating: Postgres kept
-- D1's ms-integer columns verbatim).
--
-- WHY THESE FOUR AND NOT EVERY POSTGRES TABLE. These hold OBSERVATIONS --
-- probes taken, statuses seen, daily rollups of both. An observation not
-- stored is gone forever; there is no chain to replay it from. Everything
-- chain-derived (blocks/extrinsics/events) is deliberately NOT here: the chain
-- itself is the durable copy, and that history lives in R2 (Parquet/Iceberg),
-- not in a relational serving store.
--
-- Column set matches the LIVE Postgres shapes (information_schema, captured
-- 2026-08-02), which include columns added after D1 retirement: the v440
-- pipeline inputs and #8744 provenance pair on subnet_snapshots. Types follow
-- the same rules 0001_registry.sql documents: numeric -> REAL, boolean -> 0/1
-- INTEGER with CHECK, date -> TEXT ISO day (these were TEXT days on D1
-- originally, and every reader treats them as opaque 'YYYY-MM-DD' strings).

-- Raw 15-minute probe results, rolling ~30 days (pruned by the hourly cron).
CREATE TABLE IF NOT EXISTS surface_checks (
  surface_id     TEXT,
  surface_key    TEXT,
  netuid         INTEGER,
  kind           TEXT,
  status         TEXT,
  classification TEXT,
  latency_ms     INTEGER,
  status_code    INTEGER,
  ok             INTEGER CHECK (ok IN (0, 1)),
  checked_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surface_checks_surface_time
  ON surface_checks (surface_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_checks_key_time
  ON surface_checks (surface_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_checks_netuid_time
  ON surface_checks (netuid, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_checks_time
  ON surface_checks (checked_at DESC);

-- Latest status per surface (one row each), with the circuit-breaker counter.
-- surface_id stays PRIMARY KEY with the #1005 partial-unique alias on
-- surface_key -- the resurrected upsert targets BOTH conflict paths, so both
-- constraints must exist exactly as they did.
CREATE TABLE IF NOT EXISTS surface_status (
  surface_id           TEXT PRIMARY KEY,
  surface_key          TEXT,
  netuid               INTEGER,
  kind                 TEXT,
  url                  TEXT,
  provider             TEXT,
  status               TEXT,
  classification       TEXT,
  latency_ms           INTEGER,
  status_code          INTEGER,
  last_checked         INTEGER,
  last_ok              INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_status_key
  ON surface_status (surface_key) WHERE surface_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surface_status_netuid
  ON surface_status (netuid);

-- One row per (surface, UTC day), retained indefinitely -- the durable series
-- the 30-day raw prune must never orphan. Both conflict targets again, per
-- the resurrected rollup's double ON CONFLICT.
CREATE TABLE IF NOT EXISTS surface_uptime_daily (
  surface_id      TEXT,
  surface_key     TEXT,
  netuid          INTEGER,
  day             TEXT NOT NULL,
  samples         INTEGER NOT NULL,
  ok_count        INTEGER NOT NULL,
  uptime_ratio    REAL,
  avg_latency_ms  INTEGER,
  status          TEXT,
  latency_samples INTEGER,
  p50_latency_ms  INTEGER,
  p95_latency_ms  INTEGER,
  p99_latency_ms  INTEGER,
  updated_at      INTEGER,
  PRIMARY KEY (surface_id, day)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_uptime_daily_key_day
  ON surface_uptime_daily (surface_key, day) WHERE surface_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_netuid_day
  ON surface_uptime_daily (netuid, day DESC);

-- One row per (netuid, UTC day): completeness + economics trajectory, plus the
-- v440 pipeline inputs and the #8744 provenance pair added after D1
-- retirement. Booleans are 0/1 with CHECKs (emission_enabled/subtoken_enabled
-- were Postgres booleans; a stray 2 must not read as truthy).
CREATE TABLE IF NOT EXISTS subnet_snapshots (
  netuid                INTEGER NOT NULL,
  snapshot_date         TEXT    NOT NULL,
  completeness_score    INTEGER,
  surface_count         INTEGER,
  endpoint_count        INTEGER,
  monitored_count       INTEGER,
  candidate_count       INTEGER,
  captured_at           INTEGER,
  validator_count       INTEGER,
  miner_count           INTEGER,
  total_stake_tao       REAL,
  alpha_price_tao       REAL,
  emission_share        REAL,
  tao_in_pool_tao       REAL,
  alpha_in_pool         REAL,
  alpha_out_pool        REAL,
  subnet_volume_tao     REAL,
  tao_in_emission_tao   REAL,
  excess_tao            REAL,
  alpha_in_emission     REAL,
  alpha_out_emission    REAL,
  miner_burned_fraction REAL,
  emission_enabled      INTEGER CHECK (emission_enabled IN (0, 1)),
  subtoken_enabled      INTEGER CHECK (subtoken_enabled IN (0, 1)),
  first_emission_block  INTEGER,
  pipeline_block        INTEGER,
  pipeline_block_hash   TEXT,
  PRIMARY KEY (netuid, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_date
  ON subnet_snapshots (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_netuid_date
  ON subnet_snapshots (netuid, snapshot_date DESC);
