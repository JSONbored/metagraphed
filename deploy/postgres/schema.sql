-- metagraphed-core chain sink — target Postgres schema (ADR 0013)
--
-- The durable replacement for the D1 chain tiers (blocks / extrinsics /
-- account_events / neurons / neuron_daily / economics) once they outgrow D1's
-- ~10GB cap and 90-day prune. Portable VANILLA Postgres — runs as-is on Railway
-- Postgres OR a self-hosted Hetzner box (the ADR 0013 escape hatch) with no
-- extensions required. The companion `schema-timescaledb.sql` in this same
-- directory is OPTIONAL: apply it separately, only on a Postgres that actually
-- has the TimescaleDB extension available, to upgrade the time-series tables
-- to compressed hypertables. This file alone is a complete, working schema.
--
-- Key invariants preserved from the D1 era so the Worker serving code
-- (src/blocks.mjs / extrinsics.mjs / account-events.mjs) changes only its
-- binding, not its queries:
--   * idempotent keys: (block_number, observed_at) / (block_number,
--     extrinsic_index, observed_at) / (block_number, event_index,
--     observed_at) — overlapping ingest windows re-insert harmlessly via
--     ON CONFLICT DO NOTHING. observed_at rides along in each key only to
--     satisfy TimescaleDB's requirement that the partition column appear in
--     every unique constraint on a hypertable — it's functionally determined
--     by block_number (one timestamp per block), so real-world uniqueness is
--     unchanged.
--   * observed_at = block timestamp in epoch milliseconds (BIGINT), matching D1.
--   * tao/alpha amounts as NUMERIC (exact; no float drift on balances/yield).

-- ---------------------------------------------------------------------------
-- Block-explorer hot/deep tiers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blocks (
  block_number     BIGINT NOT NULL,
  -- NOT `TEXT UNIQUE` — TimescaleDB rejects ANY unique constraint (not just
  -- the PK) that omits the partition column. block_hash is already unique in
  -- practice (cryptographically derived from block content); idx_blocks_hash
  -- below still makes lookups fast, just without a DB-enforced guarantee.
  block_hash       TEXT,
  parent_hash      TEXT,
  author           TEXT,
  extrinsic_count  INTEGER,
  event_count      INTEGER,
  spec_version     INTEGER,
  observed_at      BIGINT NOT NULL,         -- epoch ms
  -- observed_at is part of the PK (not just block_number) because a
  -- TimescaleDB hypertable partitioned on observed_at requires the partition
  -- column in every unique constraint. block_number already functionally
  -- determines observed_at (one timestamp per block), so this doesn't loosen
  -- real-world uniqueness — verified 2026-07-03 against a live TimescaleDB
  -- (create_hypertable() fails otherwise: "cannot create a unique index
  -- without the column ... used in partitioning").
  PRIMARY KEY (block_number, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_blocks_hash     ON blocks (block_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_observed ON blocks (observed_at DESC);

CREATE TABLE IF NOT EXISTS extrinsics (
  block_number     BIGINT NOT NULL,
  extrinsic_index  INTEGER NOT NULL,
  extrinsic_hash   TEXT,
  signer           TEXT,
  call_module      TEXT,
  call_function    TEXT,
  success          BOOLEAN,
  fee_tao          NUMERIC,
  tip_tao          NUMERIC,
  call_args        JSONB,
  observed_at      BIGINT NOT NULL,
  -- observed_at in the PK for the same TimescaleDB reason as `blocks` above.
  PRIMARY KEY (block_number, extrinsic_index, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_extrinsics_hash     ON extrinsics (extrinsic_hash);
CREATE INDEX IF NOT EXISTS idx_extrinsics_observed ON extrinsics (observed_at DESC);
-- #2082: composite covers the /accounts/{ss58}/extrinsics filesort + summary aggregates.
CREATE INDEX IF NOT EXISTS idx_extrinsics_signer_block
  ON extrinsics (signer, block_number DESC, extrinsic_index DESC);
-- #2082 sibling: extrinsics-feed call_module/call_function/success filters.
CREATE INDEX IF NOT EXISTS idx_extrinsics_call
  ON extrinsics (call_module, call_function, success, block_number DESC);

CREATE TABLE IF NOT EXISTS account_events (
  block_number     BIGINT NOT NULL,
  event_index      INTEGER NOT NULL,
  extrinsic_index  INTEGER,
  event_kind       TEXT,
  hotkey           TEXT,
  coldkey          TEXT,
  netuid           INTEGER,
  uid              INTEGER,                 -- neuron uid when the event carries one
  amount_tao       NUMERIC,                 -- tao field / 1e9 where applicable
  alpha_amount     NUMERIC,                 -- subnet alpha leg for stake swaps
  observed_at      BIGINT NOT NULL,
  -- observed_at in the PK for the same TimescaleDB reason as `blocks` above.
  PRIMARY KEY (block_number, event_index, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_ae_hotkey   ON account_events (hotkey, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_ae_coldkey  ON account_events (coldkey, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_ae_netuid   ON account_events (netuid, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_ae_observed ON account_events (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_extrinsic ON account_events (block_number, extrinsic_index);
-- #2079: covers the /subnets/{netuid}/events ?kind filter (unindexed post-filter today).
CREATE INDEX IF NOT EXISTS idx_ae_netuid_kind ON account_events (netuid, event_kind, block_number DESC);

-- Generic all-events tier (audit gap: only ~8 kinds of 2 pallets decoded today).
-- Stores EVERY decoded event; the curated account_events stays the fast path.
CREATE TABLE IF NOT EXISTS chain_events (
  block_number     BIGINT NOT NULL,
  event_index      INTEGER NOT NULL,
  pallet           TEXT,
  method           TEXT,
  args             JSONB,
  phase            TEXT,
  extrinsic_index  INTEGER,
  observed_at      BIGINT NOT NULL,
  -- observed_at in the PK for the same TimescaleDB reason as `blocks` above.
  PRIMARY KEY (block_number, event_index, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_ce_pallet_method ON chain_events (pallet, method, block_number DESC);
-- Pallet-only feed (pallet= without method=): serves the ORDER BY without a full PK scan.
CREATE INDEX IF NOT EXISTS idx_ce_pallet_block  ON chain_events (pallet, block_number DESC, event_index DESC);
CREATE INDEX IF NOT EXISTS idx_ce_observed      ON chain_events (observed_at DESC);

-- ---------------------------------------------------------------------------
-- Metagraph tiers
-- ---------------------------------------------------------------------------

-- Current per-UID snapshot (mirror of D1 `neurons`).
CREATE TABLE IF NOT EXISTS neurons (
  netuid           INTEGER NOT NULL,
  uid              INTEGER NOT NULL,
  hotkey           TEXT,
  coldkey          TEXT,
  active           BOOLEAN,
  validator_permit BOOLEAN,
  rank             NUMERIC,
  trust            NUMERIC,
  validator_trust  NUMERIC,
  consensus        NUMERIC,
  incentive        NUMERIC,
  dividends        NUMERIC,
  emission_tao     NUMERIC,
  stake_tao        NUMERIC,
  registered_at_block BIGINT,
  is_immunity_period  BOOLEAN,
  axon             TEXT,
  block_number     BIGINT,
  captured_at      BIGINT NOT NULL,
  PRIMARY KEY (netuid, uid)
);
CREATE INDEX IF NOT EXISTS idx_neurons_netuid_permit ON neurons (netuid, validator_permit, stake_tao DESC);
CREATE INDEX IF NOT EXISTS idx_neurons_hotkey        ON neurons (hotkey);

-- Daily per-UID history (mirror of D1 `neuron_daily`, ~10.8M rows / 370d).
CREATE TABLE IF NOT EXISTS neuron_daily (
  netuid           INTEGER NOT NULL,
  uid              INTEGER NOT NULL,
  snapshot_date    DATE NOT NULL,
  hotkey           TEXT,
  coldkey          TEXT,
  active           BOOLEAN,
  validator_permit BOOLEAN,
  rank             NUMERIC,
  trust            NUMERIC,
  validator_trust  NUMERIC,
  consensus        NUMERIC,
  incentive        NUMERIC,
  dividends        NUMERIC,
  emission_tao     NUMERIC,
  stake_tao        NUMERIC,
  registered_at_block BIGINT,
  is_immunity_period  BOOLEAN,
  axon             TEXT,
  block_number     BIGINT,
  captured_at      BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (netuid, uid, snapshot_date)
);
-- #2083: covering index for per-subnet history aggregation (avoid per-row heap fetch).
CREATE INDEX IF NOT EXISTS idx_nd_netuid_date ON neuron_daily (netuid, snapshot_date, uid)
  INCLUDE (stake_tao, incentive, dividends, emission_tao);
CREATE INDEX IF NOT EXISTS idx_nd_uid_date    ON neuron_daily (netuid, uid, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_nd_hotkey_date ON neuron_daily (hotkey, snapshot_date);

-- ---------------------------------------------------------------------------
-- Economics tiers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS economics_history (
  netuid             INTEGER NOT NULL,
  snapshot_date      DATE NOT NULL,
  alpha_price_tao    NUMERIC,
  emission_share     NUMERIC,
  total_stake_tao    NUMERIC,
  registration_cost  NUMERIC,
  PRIMARY KEY (netuid, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_econ_netuid_date ON economics_history (netuid, snapshot_date);

-- Account daily rollup (#2079 / audit: removes the temp-sort on default account history).
CREATE TABLE IF NOT EXISTS account_events_daily (
  hotkey           TEXT NOT NULL,
  netuid           INTEGER NOT NULL,
  day              DATE NOT NULL,
  event_count      INTEGER NOT NULL,
  event_kinds      TEXT,
  first_block      BIGINT,
  last_block       BIGINT,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (hotkey, netuid, day)
);
CREATE INDEX IF NOT EXISTS idx_account_events_daily_netuid_day
  ON account_events_daily (netuid, day);
CREATE INDEX IF NOT EXISTS idx_account_events_daily_hotkey_day
  ON account_events_daily (hotkey, day);

-- ---------------------------------------------------------------------------
-- Indexer coordination
-- ---------------------------------------------------------------------------

-- Durable cursor (also mirrored in Redis for hot access). Single row id=1.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id               SMALLINT PRIMARY KEY DEFAULT 1,
  last_block       BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_cursor_singleton CHECK (id = 1)
);

-- TimescaleDB hypertables/compression are OPTIONAL and live in the companion
-- schema-timescaledb.sql in this same directory — apply it separately, only
-- on a Postgres that actually has the TimescaleDB extension. This file is a
-- complete, working schema on its own (plain tables, no extensions needed).
