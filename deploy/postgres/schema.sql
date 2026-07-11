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
-- #4832 Tier 2: covers the network-wide (no netuid filter) `event_kind = ? AND
-- observed_at >= ?` scans the 12 /chain/* analytics routes in data-api.mjs run
-- -- idx_ae_netuid_kind above only helps once a netuid filter is also present.
-- Applied live via a plain (non-concurrent) CREATE INDEX -- TimescaleDB
-- hypertables reject CREATE INDEX CONCURRENTLY.
CREATE INDEX IF NOT EXISTS idx_ae_kind_observed ON account_events (event_kind, observed_at DESC);
-- #4869: fast-follow on #4832 Tier 2 -- /chain/transfers is the one route among
-- the 12 that hits the highest-volume event_kind ('Transfer', ~10M rows/7d);
-- these cover its per-hotkey/per-coldkey GROUP BY + COUNT(DISTINCT ...) scans
-- (idx_ae_kind_observed above only covers the network-wide totals scan).
-- INCLUDE (amount_tao) makes the GROUP BY ... SUM(amount_tao) queries index-only.
CREATE INDEX IF NOT EXISTS idx_ae_kind_hotkey_observed ON account_events (event_kind, hotkey, observed_at DESC) INCLUDE (amount_tao);
CREATE INDEX IF NOT EXISTS idx_ae_kind_coldkey_observed ON account_events (event_kind, coldkey, observed_at DESC) INCLUDE (amount_tao);

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

-- Per-account daily position HISTORY (#4832 gap-closure; mirrors D1
-- migrations/0038_account_position_daily.sql). Rolled from the SAME `neurons`
-- snapshot as neuron_daily, in the SAME handleNeuronsSync write (#4771) --
-- account = hotkey ss58, matching loadAccountPortfolio's "WHERE hotkey = ?"
-- framing (src/account-portfolio.mjs).
CREATE TABLE IF NOT EXISTS account_position_daily (
  account          TEXT NOT NULL,
  netuid           INTEGER NOT NULL,
  snapshot_date    DATE NOT NULL,
  uid              INTEGER,
  coldkey          TEXT,
  active           BOOLEAN,
  validator_permit BOOLEAN,
  rank             NUMERIC,
  trust            NUMERIC,
  incentive        NUMERIC,
  dividends        NUMERIC,
  stake_tao        NUMERIC,
  emission_tao     NUMERIC,
  captured_at      BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (account, netuid, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_account_position_daily_netuid_date
  ON account_position_daily (netuid, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_account_position_daily_date
  ON account_position_daily (snapshot_date);

-- Daily structural + economics snapshot per subnet (#4832 gap-closure;
-- mirrors D1 migrations/0002_analytics.sql + 0008_economics_history.sql).
-- Low-volume (~129 rows/day, one per active subnet) -- plain table, not a
-- hypertable, matching account_position_daily/subnet_hyperparams above.
-- Written from src/health-prober.mjs's writeSubnetSnapshot, the SAME
-- function that already calls syncSubnetIdentityToPostgres -- an in-Worker-
-- cron direct env.DATA_API.fetch() service-binding call, not an external
-- GitHub Actions workflow (see that function's own header comment for why).
-- total_stake_tao/alpha_price_tao/emission_share are NUMERIC (not REAL),
-- matching subnet_hyperparams' TAO-precision rationale above.
CREATE TABLE IF NOT EXISTS subnet_snapshots (
  netuid             INTEGER NOT NULL,
  snapshot_date      DATE NOT NULL,
  completeness_score INTEGER,
  surface_count      INTEGER,
  endpoint_count     INTEGER,
  monitored_count    INTEGER,
  candidate_count    INTEGER,
  captured_at        BIGINT NOT NULL,
  validator_count    INTEGER,
  miner_count        INTEGER,
  total_stake_tao    NUMERIC,
  alpha_price_tao    NUMERIC,
  emission_share     NUMERIC,
  PRIMARY KEY (netuid, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_date
  ON subnet_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_netuid_date
  ON subnet_snapshots (netuid, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_date_netuid
  ON subnet_snapshots (snapshot_date, netuid);

-- Subnet hyperparameters, latest-only (#4832 gap-closure; mirrors D1
-- migrations/0036_subnet_hyperparams.sql). One row per netuid, upserted by
-- the refresh-subnet-hyperparams workflow's direct POST to data-api.mjs.
-- *_ratio columns and TAO-exact fields stay NUMERIC (not REAL) to match the
-- D1 pure builders' round(value, 9) precision; the nine D1 0/1 flag columns
-- become BOOLEAN here (see the SUM(boolean) landmine noted elsewhere in this
-- file); bonds_moving_avg_raw is a raw on-chain integer, not a ratio.
-- weights_rate_limit is NUMERIC, not INTEGER/BIGINT: confirmed live
-- 2026-07-11 that netuid 0 (root) carries the chain's u64::MAX "unlimited"
-- sentinel (18446744073709551615) for this field -- larger than even
-- Postgres BIGINT's signed 64-bit range, which SQLite's flexible INTEGER
-- storage class silently tolerates (falls back to a REAL) but Postgres'
-- strict typing rejects outright. formatSubnetHyperparams' nonNegativeInt
-- already nulls any non-safe-integer value on read, so NUMERIC here only
-- needs to hold the value long enough to round-trip without erroring the
-- whole upsert -- it never needs its own precision/display logic.
CREATE TABLE IF NOT EXISTS subnet_hyperparams (
  netuid                       INTEGER NOT NULL,
  kappa_ratio                  NUMERIC,
  immunity_period               INTEGER,
  min_allowed_weights           INTEGER,
  max_weight_limit_ratio        NUMERIC,
  tempo                        INTEGER,
  weights_version               INTEGER,
  weights_rate_limit            NUMERIC,
  activity_cutoff               INTEGER,
  activity_cutoff_factor        INTEGER,
  registration_allowed          BOOLEAN,
  target_regs_per_interval      INTEGER,
  min_burn_tao                 NUMERIC,
  max_burn_tao                 NUMERIC,
  burn_half_life                INTEGER,
  burn_increase_mult            NUMERIC,
  bonds_moving_avg_raw           BIGINT,
  max_regs_per_block            INTEGER,
  serving_rate_limit            INTEGER,
  max_validators                INTEGER,
  commit_reveal_period          INTEGER,
  commit_reveal_enabled         BOOLEAN,
  alpha_high_ratio              NUMERIC,
  alpha_low_ratio               NUMERIC,
  liquid_alpha_enabled          BOOLEAN,
  alpha_sigmoid_steepness       NUMERIC,
  yuma_version                  INTEGER,
  subnet_is_active              BOOLEAN,
  transfers_enabled             BOOLEAN,
  bonds_reset_enabled           BOOLEAN,
  user_liquidity_enabled        BOOLEAN,
  owner_cut_enabled             BOOLEAN,
  owner_cut_auto_lock_enabled   BOOLEAN,
  min_childkey_take_ratio       NUMERIC,
  block_number                 BIGINT,
  captured_at                  BIGINT NOT NULL,
  PRIMARY KEY (netuid)
);

-- Historical hyperparameter change tracking (#4832 gap-closure; mirrors D1
-- migrations/0037_subnet_hyperparams_history.sql). Append-only, diffed by
-- hyperparams_hash on each sync; live-forward only, same as the D1 table.
CREATE TABLE IF NOT EXISTS subnet_hyperparams_history (
  id                            BIGSERIAL PRIMARY KEY,
  netuid                        INTEGER NOT NULL,
  block_number                  BIGINT,
  observed_at                   BIGINT NOT NULL,
  kappa_ratio                   NUMERIC,
  immunity_period                INTEGER,
  min_allowed_weights            INTEGER,
  max_weight_limit_ratio         NUMERIC,
  tempo                         INTEGER,
  weights_version                INTEGER,
  weights_rate_limit             NUMERIC,
  activity_cutoff                INTEGER,
  activity_cutoff_factor         INTEGER,
  registration_allowed           BOOLEAN,
  target_regs_per_interval       INTEGER,
  min_burn_tao                  NUMERIC,
  max_burn_tao                  NUMERIC,
  burn_half_life                 INTEGER,
  burn_increase_mult             NUMERIC,
  bonds_moving_avg_raw            BIGINT,
  max_regs_per_block             INTEGER,
  serving_rate_limit             INTEGER,
  max_validators                 INTEGER,
  commit_reveal_period           INTEGER,
  commit_reveal_enabled          BOOLEAN,
  alpha_high_ratio                NUMERIC,
  alpha_low_ratio                NUMERIC,
  liquid_alpha_enabled           BOOLEAN,
  alpha_sigmoid_steepness        NUMERIC,
  yuma_version                   INTEGER,
  subnet_is_active               BOOLEAN,
  transfers_enabled              BOOLEAN,
  bonds_reset_enabled            BOOLEAN,
  user_liquidity_enabled         BOOLEAN,
  owner_cut_enabled              BOOLEAN,
  owner_cut_auto_lock_enabled    BOOLEAN,
  min_childkey_take_ratio        NUMERIC,
  hyperparams_hash               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_observed
  ON subnet_hyperparams_history (netuid, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_id
  ON subnet_hyperparams_history (netuid, id DESC);

-- Personal (coldkey) chain identity, latest-only (#4832 gap-closure Phase B;
-- mirrors D1 migrations/0039_account_identity.sql). One row per account,
-- upserted by the refresh-account-identity workflow's direct POST to
-- data-api.mjs. Deliberately NO purge step (unlike subnet_hyperparams above):
-- an identity is a property of the owning account, not of currently having
-- an active neuron -- see loadStagedAccountIdentity's own header comment.
CREATE TABLE IF NOT EXISTS account_identity (
  account       TEXT NOT NULL,
  name          TEXT,
  url           TEXT,
  github        TEXT,
  image         TEXT,
  discord       TEXT,
  description   TEXT,
  additional    TEXT,
  captured_at   BIGINT NOT NULL,
  PRIMARY KEY (account)
);

-- Personal chain identity history (#4832 gap-closure Phase B; mirrors D1
-- migrations/0041_account_identity_history.sql). Append-only, diffed by
-- identity_hash on each sync; no block_number column, matching D1 (an
-- account carries no chain block height, only captured_at).
CREATE TABLE IF NOT EXISTS account_identity_history (
  id            BIGSERIAL PRIMARY KEY,
  account       TEXT NOT NULL,
  observed_at   BIGINT NOT NULL,
  name          TEXT,
  url           TEXT,
  github        TEXT,
  image         TEXT,
  discord       TEXT,
  description   TEXT,
  additional    TEXT,
  identity_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_observed
  ON account_identity_history (account, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_id
  ON account_identity_history (account, id DESC);

-- On-chain subnet identity history (#4832 gap-closure Phase B; mirrors D1
-- migrations/0031_subnet_identity_history.sql). Append-only, diffed by
-- identity_hash on each sync; no latest-only sibling table -- the current
-- identity lives in the profiles.json artifact itself, not a dedicated
-- table. Written from the main Worker's own hourly cron (writeSubnetSnapshot,
-- src/health-prober.mjs), not an external GitHub Actions workflow.
CREATE TABLE IF NOT EXISTS subnet_identity_history (
  id            BIGSERIAL PRIMARY KEY,
  netuid        INTEGER NOT NULL,
  block_number  BIGINT,
  observed_at   BIGINT NOT NULL,
  subnet_name   TEXT,
  symbol        TEXT,
  description   TEXT,
  github_repo   TEXT,
  subnet_url    TEXT,
  discord       TEXT,
  logo_url      TEXT,
  identity_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subnet_identity_history_netuid_observed
  ON subnet_identity_history (netuid, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subnet_identity_history_netuid_id
  ON subnet_identity_history (netuid, id DESC);

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
-- Health tracking (#4832 gap-closure; mirrors D1 migrations/0001_health.sql +
-- 0003_uptime_history.sql + 0005_surface_key.sql + 0006_surface_key_rekey.sql
-- + 0012_latency_percentiles.sql, in their final post-migration column shape
-- rather than replayed incrementally). Written every 15 minutes by the
-- Cloudflare cron prober (src/health-prober.mjs, runHealthProber; wrangler.jsonc
-- "*/15 * * * *" -- 0001_health.sql's own "every 2 minutes" comment is stale,
-- left over from before the cron interval was widened).
-- ---------------------------------------------------------------------------

-- Append-only raw probe time-series (powers /health/trends; a 30-day hot
-- window in D1, pruned by the hourly cron). One row per (surface, run) --
-- every surface probed in a single prober run shares that run's exact
-- checked_at, so (surface_id, checked_at) is a natural idempotency key for a
-- retried write, same role observed_at plays in blocks/extrinsics above.
CREATE TABLE IF NOT EXISTS surface_checks (
  surface_id     TEXT NOT NULL,
  surface_key    TEXT,
  netuid         INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  classification TEXT,
  latency_ms     INTEGER,
  status_code    INTEGER,
  ok             BOOLEAN NOT NULL DEFAULT false,
  checked_at     BIGINT NOT NULL,
  PRIMARY KEY (surface_id, checked_at)
);
CREATE INDEX IF NOT EXISTS idx_surface_checks_key_time
  ON surface_checks (surface_key, checked_at);
CREATE INDEX IF NOT EXISTS idx_surface_checks_netuid_time
  ON surface_checks (netuid, checked_at);
CREATE INDEX IF NOT EXISTS idx_surface_checks_time
  ON surface_checks (checked_at);

-- Upserted latest-row-per-surface (powers live serving + the cross-isolate
-- circuit-breaker counter). One row per surface -- small, not a time-series,
-- no hypertable needed. surface_key is the rename-stable upsert target
-- (#1005); surface_id is the display/back-compat alias.
CREATE TABLE IF NOT EXISTS surface_status (
  surface_id           TEXT PRIMARY KEY,
  surface_key          TEXT,
  netuid               INTEGER NOT NULL,
  kind                 TEXT NOT NULL,
  url                  TEXT,
  provider             TEXT,
  status               TEXT NOT NULL,
  classification       TEXT,
  latency_ms           INTEGER,
  status_code          INTEGER,
  last_checked         BIGINT,
  last_ok              BIGINT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_status_key_unique
  ON surface_status (surface_key) WHERE surface_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surface_status_netuid
  ON surface_status (netuid);

-- Durable daily uptime rollup, retained indefinitely (the raw surface_checks
-- window above is pruned after 30 days). One row per (surface, day) -- small
-- (~150-200 surfaces/day), no hypertable needed, unlike neuron_daily's much
-- higher per-day cardinality. latency_samples/p50/p95/p99 hold that day's
-- exact tail latency, computed once at rollup time since it can't be
-- reconstructed from a stored mean after the raw window prunes.
CREATE TABLE IF NOT EXISTS surface_uptime_daily (
  surface_id      TEXT NOT NULL,
  surface_key     TEXT,
  netuid          INTEGER NOT NULL,
  day             DATE NOT NULL,
  samples         INTEGER NOT NULL,
  ok_count        INTEGER NOT NULL,
  uptime_ratio    NUMERIC,
  avg_latency_ms  INTEGER,
  status          TEXT,
  latency_samples INTEGER,
  p50_latency_ms  INTEGER,
  p95_latency_ms  INTEGER,
  p99_latency_ms  INTEGER,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (surface_id, day)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_uptime_daily_key_day_unique
  ON surface_uptime_daily (surface_key, day) WHERE surface_key IS NOT NULL;
-- handleBulkHealthTrends: `... WHERE day >= ? GROUP BY netuid, day` --
-- (day, netuid) matches a `day >=` range scan across all subnets (mirrors
-- the same reasoning as idx_surface_uptime_daily_day_netuid in D1's
-- migrations/0010_perf_indexes.sql).
CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_day_netuid
  ON surface_uptime_daily (day, netuid);

-- RPC reverse-proxy usage telemetry (#4832 gap-closure; mirrors D1
-- migrations/0004_rpc_proxy_usage.sql + 0010_perf_indexes.sql). Written
-- best-effort per proxied request (workers/request-handlers/rpc-proxy.mjs's
-- recordRpcUsage), not a cron/workflow batch like every other #4832 table --
-- confirmed live 2026-07-11 the real volume is trivial (69 rows over ~25
-- days), so this stays a plain table like subnet_hyperparams/
-- subnet_snapshots above rather than a hypertable; revisit if traffic grows.
-- Same 30-day pruning window as surface_checks (src/health-prober.mjs's
-- pruneHealthHistory).
CREATE TABLE IF NOT EXISTS rpc_proxy_events (
  id          BIGSERIAL PRIMARY KEY,
  observed_at BIGINT NOT NULL,
  network     TEXT NOT NULL,
  endpoint_id TEXT,
  provider    TEXT,
  ok          BOOLEAN NOT NULL,
  status      INTEGER,
  attempts    INTEGER,
  latency_ms  INTEGER,
  cache       TEXT
);
CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_observed
  ON rpc_proxy_events (observed_at);
CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_network_observed
  ON rpc_proxy_events (network, observed_at);
CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_observed_endpoint
  ON rpc_proxy_events (observed_at, endpoint_id);

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
--
-- The registry (subnets/providers/surfaces) tables live in the SEPARATE
-- registry-schema.sql in this same directory, applied to a dedicated
-- registry Postgres instance -- not this one. Two logically and physically
-- independent databases (different container, different port, different
-- credentials, different host resources), so either can be restarted,
-- backed up, or migrated without touching the other. See registry-schema.sql
-- for why.
