-- Emission-gate history tables on D1: the box-Postgres tenants of
-- scripts/sample-emission-gate.ts (#8748's gate-parameter change log, #8750's
-- dormant TAO-flow path watch). Append-only change/alert capture with no
-- reader anywhere in workers/ or src/ -- pure history, written only when a
-- value actually moved, so the tables ARE the change log. Low-volume,
-- bounded, non-chain-derived: exactly D1's lane, and the last emission-lane
-- data stranded on the decommissioned box's Postgres. The sampler keeps its
-- chain reads (now from a GitHub Actions schedule) and POSTs readings to
-- /api/v1/internal/emission-gate-sync on the main Worker, which owns the
-- diff + these writes.
--
-- Column sets are faithful translations of the LIVE Postgres shapes
-- (pg_dump --schema-only, captured 2026-08-02; 47 + 73 + 4 = 124 rows total
-- to be migrated by the operator):
--   bigint sequence ids  -> INTEGER PRIMARY KEY AUTOINCREMENT (migrated rows
--                           keep their original ids; AUTOINCREMENT continues
--                           above them)
--   numeric              -> REAL
--   boolean              -> INTEGER 0/1 with CHECK
--   bigint epoch-ms      -> INTEGER (observed_at was already epoch-ms in
--                           Postgres; no representation change)
--   text                 -> TEXT
-- CHECK constraints (including the two-arm shape check on
-- emission_flow_watch) and the (key, observed_at DESC) indexes translate
-- verbatim -- SQLite supports both.

CREATE TABLE IF NOT EXISTS emission_gate_param_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  param            TEXT    NOT NULL,
  value            REAL,
  previous_value   REAL,
  source           TEXT    NOT NULL
    CHECK (source IN ('governance', 'runtime_recomputed')),
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1))
);
CREATE INDEX IF NOT EXISTS emission_gate_param_history_param_observed_idx
  ON emission_gate_param_history (param, observed_at DESC);

CREATE TABLE IF NOT EXISTS subnet_emission_enabled_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  netuid           INTEGER NOT NULL,
  enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  previous_enabled INTEGER CHECK (previous_enabled IN (0, 1)),
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1))
);
CREATE INDEX IF NOT EXISTS subnet_emission_enabled_history_netuid_observed_idx
  ON subnet_emission_enabled_history (netuid, observed_at DESC);

CREATE TABLE IF NOT EXISTS emission_flow_watch (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item             TEXT    NOT NULL
    CHECK (item IN ('net_tao_flow_enabled', 'flow_norm_exponent',
                    'tao_flow_cutoff', 'flow_ema_smoothing_factor',
                    'subnet_ema_tao_flow')),
  netuid           INTEGER,
  is_set           INTEGER NOT NULL CHECK (is_set IN (0, 1)),
  ema_block        INTEGER,
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1)),
  CHECK (
    (item = 'subnet_ema_tao_flow' AND netuid IS NOT NULL AND ema_block IS NOT NULL)
    OR (item <> 'subnet_ema_tao_flow' AND netuid IS NULL AND ema_block IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS emission_flow_watch_item_observed_idx
  ON emission_flow_watch (item, observed_at DESC);
