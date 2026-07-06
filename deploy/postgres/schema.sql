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

-- ---------------------------------------------------------------------------
-- Registry tiers (subnets / providers / surfaces)
-- ---------------------------------------------------------------------------
--
-- The single serving source of truth for EVERY subnet/provider/surface fact
-- this system knows about, regardless of where the fact came from -- both
-- the human-authored, PR-reviewed content in registry/subnets/*.json +
-- registry/providers/*.json (the Gittensory Gate's review surface -- nothing
-- about how a contributor submits or how the gate judges a PR changes) AND
-- the machine-discovered/promoted content that scripts/generated-overlays.mjs
-- computes from the native chain snapshot + candidate verification (subnets
-- with no manual file yet, and auto-promoted candidate surfaces layered onto
-- existing manual subnets). Both write paths upsert into the SAME tables --
-- deliberately not split into a separate "generated" store, so nothing ever
-- has to join two systems back together to answer "what surfaces does this
-- subnet have right now." `subnets.source` and `surfaces.authority` record
-- provenance (community vs machine) as a queryable fact ON the row, not as a
-- reason to route the row somewhere else.
--
--   - registry/subnets/*.json changes: scripts/sync-registry-to-postgres.mjs,
--     merge-triggered (event-driven, matches contributor-PR cadence).
--   - Machine-generated/promoted content: scripts/backfill-registry-postgres.mjs
--     run on a schedule (matches native-snapshot/candidate-verification
--     cadence, not a git commit).
--
-- These tables are what the Worker actually reads/serves, so no derived
-- registry artifact needs to be committed back to git and rebuilt on a
-- cadence again -- it's computed live from these rows instead.
--
-- Not TimescaleDB hypertables (this data isn't a time series and there's no
-- partition-column requirement to work around) -- ordinary tables with real
-- foreign keys and uniqueness constraints, which is the entire point: a
-- subnet's filename and its internal slug can no longer diverge (there is no
-- filename to diverge from), and a surface can't be duplicated or farmed
-- under a different `kind` against the same URL -- the UNIQUE constraint on
-- `surfaces` rejects that insert outright, not just flags it after the fact.
-- `gen_random_uuid()` has been in Postgres core (no extension) since PG13.

CREATE TABLE IF NOT EXISTS subnets (
  netuid           INTEGER PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  -- 'community' (has a registry/subnets/<slug>.json file) or
  -- 'machine-generated' (native-chain-registered, no manual file yet --
  -- scripts/generated-overlays.mjs's baseline overlay is the only source).
  source           TEXT NOT NULL DEFAULT 'community',
  overlay          JSONB NOT NULL,       -- full overlay content, verbatim (manual file, or the generated baseline)
  source_commit    TEXT NOT NULL,        -- merge commit SHA (community) or the sync run's own commit SHA (generated)
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subnets_source ON subnets (source);

CREATE TABLE IF NOT EXISTS providers (
  id               TEXT PRIMARY KEY,     -- the provider slug (registry/providers/<slug>.json)
  overlay          JSONB NOT NULL,
  source_commit    TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surfaces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subnet_netuid    INTEGER NOT NULL REFERENCES subnets (netuid) ON DELETE RESTRICT,
  provider_id      TEXT REFERENCES providers (id) ON DELETE RESTRICT,
  surface_key      TEXT NOT NULL,        -- matches scripts/lib.mjs's subnetSurfaceKey()
  kind             TEXT NOT NULL,
  url              TEXT NOT NULL,
  -- source_urls lives only in `overlay` (JSONB array) -- real registry files
  -- use both a legacy singular `source_url` and the current plural
  -- `source_urls` shape, so normalizing it to one dedicated column here would
  -- misrepresent one of the two. Query it from `overlay` when needed.
  authority        TEXT NOT NULL DEFAULT 'community',
  review_state     TEXT NOT NULL DEFAULT 'community-submitted',
  probe_eligible   BOOLEAN NOT NULL DEFAULT false,
  public_safe      BOOLEAN NOT NULL DEFAULT true,
  overlay          JSONB NOT NULL,       -- the surface object, verbatim, for round-trip fidelity
  source_commit    TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subnet_netuid, kind, url)
);
CREATE INDEX IF NOT EXISTS idx_surfaces_subnet   ON surfaces (subnet_netuid);
CREATE INDEX IF NOT EXISTS idx_surfaces_provider ON surfaces (provider_id);
CREATE INDEX IF NOT EXISTS idx_surfaces_probe    ON surfaces (probe_eligible, review_state)
  WHERE probe_eligible;

-- Append-only audit ledger: every write traces back to the PR that produced
-- it. A bad row is traced to its source_commit and reverted by reverting
-- that PR and re-running the sync -- never a mystery change with no author.
CREATE TABLE IF NOT EXISTS surface_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  surface_id       UUID,                 -- NULL if the surface was later deleted
  subnet_netuid    INTEGER NOT NULL,
  action           TEXT NOT NULL,        -- 'insert' | 'update' | 'delete'
  overlay          JSONB NOT NULL,       -- the surface's overlay content at this point in history
  source_commit    TEXT NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_surface_history_surface ON surface_history (surface_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_history_subnet  ON surface_history (subnet_netuid, recorded_at DESC);

-- TimescaleDB hypertables/compression are OPTIONAL and live in the companion
-- schema-timescaledb.sql in this same directory — apply it separately, only
-- on a Postgres that actually has the TimescaleDB extension. This file is a
-- complete, working schema on its own (plain tables, no extensions needed).
