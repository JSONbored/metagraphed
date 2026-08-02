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
-- (src/blocks.ts / extrinsics.ts / account-events.ts) changes only its
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
-- #8175: the /accounts/{ss58}/extrinsics feed and the account-summary
-- tx-count/module-mix aggregates all lead their ORDER BY with observed_at
-- (hypertable chunk exclusion), which idx_extrinsics_signer_block above
-- (block_number-led tail) can't satisfy without a per-chunk Sort of the
-- signer's ENTIRE matching set -- the same "index doesn't match this
-- ORDER BY" class fixed for account_events by idx_ae_hotkey_observed/
-- idx_ae_coldkey_observed (#8153/#8154; see that comment block for why
-- the full 4-column key is required -- observed_at is a per-flush batch
-- timestamp, so the block_number/extrinsic_index tiebreak columns must be
-- in the index too). idx_extrinsics_signer_block stays: it still backs the
-- block_start/block_end-range variants of the same routes.
CREATE INDEX IF NOT EXISTS idx_extrinsics_signer_observed
  ON extrinsics (signer, observed_at DESC, block_number DESC, extrinsic_index DESC);
-- #8176: same class one level down -- /api/v1/sudo and
-- /api/v1/governance/config-changes filter by a fixed call_module with the
-- same observed_at-leading ORDER BY, which idx_extrinsics_call above
-- (call_function/success/block_number tail) can't back either.
-- idx_extrinsics_call stays for the general extrinsics-feed
-- call_module/call_function/success filter combinations.
CREATE INDEX IF NOT EXISTS idx_extrinsics_call_observed
  ON extrinsics (call_module, observed_at DESC, block_number DESC, extrinsic_index DESC);

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
-- GET /api/v1/accounts/:ss58's two-branch hotkey=/coldkey= scans
-- (workers/data-api.ts, added by the METAGRAPHED-5/#6878 fix) lead their
-- ORDER BY with observed_at (added later, for hypertable chunk exclusion
-- elsewhere -- see the /api/v1/extrinsics list route's own comment) but
-- idx_ae_hotkey/idx_ae_coldkey above are still ordered by block_number,
-- not observed_at -- confirmed live via EXPLAIN: for a coldkey (one
-- holding tens of millions of matching rows, a treasury/burn-style
-- address), every chunk that could contain it gets a full Sort of its
-- ENTIRE matching set before ChunkAppend can apply the outer LIMIT, since
-- the per-chunk scan isn't already in the final sort order -- the exact
-- same "index doesn't match this ORDER BY" bug METAGRAPHED-5/6 already
-- found and fixed for the OTHER predicate shapes (event_kind-qualified
-- scans get idx_ae_kind_hotkey_observed/idx_ae_kind_coldkey_observed
-- below; this is the plain, no-event_kind-filter case those don't cover).
--
-- All FOUR columns of the ORDER BY's own key, not just observed_at: a
-- first attempt at just (hotkey/coldkey, observed_at DESC) still left a
-- Sort node in the plan -- observed_at is a per-FLUSH batch timestamp, not
-- per-row (confirmed live: for one busy coldkey, 1,741 rows share the
-- exact same observed_at millisecond), so a 2-column index can't
-- determine the tiebreak order the remaining two ORDER BY columns
-- require. Matching the full (block_number DESC, event_index DESC) tail
-- lets the planner drop the Sort node entirely and do a true
-- ordered-index-scan-with-early-exit at LIMIT.
--
-- Root-caused 2026-07-25 chasing a live statement-timeout incident
-- PostHog's new distributed tracing/error capture surfaced (243
-- occurrences in ~35min).
CREATE INDEX IF NOT EXISTS idx_ae_hotkey_observed  ON account_events (hotkey, observed_at DESC, block_number DESC, event_index DESC);
CREATE INDEX IF NOT EXISTS idx_ae_coldkey_observed ON account_events (coldkey, observed_at DESC, block_number DESC, event_index DESC);
-- #2079: covers the /subnets/{netuid}/events ?kind filter (unindexed post-filter today).
CREATE INDEX IF NOT EXISTS idx_ae_netuid_kind ON account_events (netuid, event_kind, block_number DESC);
-- #4832 Tier 2: covers the network-wide (no netuid filter) `event_kind = ? AND
-- observed_at >= ?` scans the 12 /chain/* analytics routes in data-api.ts run
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
-- #8970 (migration 0052): the SubnetOwnerChanged history routes query ALL
-- history by design, so they have no correct time predicate to add and cannot
-- benefit from chunk exclusion the way chain-events/stats now does. This
-- partial index covers just that stream -- a few thousand rows out of ~723M --
-- so the planner reads only matching rows instead of descending every chunk's
-- copy of idx_ce_pallet_method and filtering JSONB afterwards.
CREATE INDEX IF NOT EXISTS idx_ce_owner_changed ON chain_events (block_number ASC)
  WHERE pallet = 'SubtensorModule' AND method = 'SubnetOwnerChanged';

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
  take             REAL,
  PRIMARY KEY (netuid, uid)
);
-- Schema-drift fix (found 2026-07-19 while building the neurons poller job):
-- handleNeuronsSync (workers/data-api.ts) has upserted `take` into `neurons`
-- since the metagraph-depth epic shipped, and the live table has carried the
-- column since then -- CREATE TABLE IF NOT EXISTS above never added it,
-- since it's a no-op against an already-existing table, so this file's own
-- source of truth silently drifted from what's actually deployed. Safe on an
-- already-deployed table (CREATE TABLE above now includes the column for a
-- fresh deploy; this is a no-op there), same convention as
-- api_keys.account_id/unkey_key_id below.
ALTER TABLE neurons ADD COLUMN IF NOT EXISTS take REAL;
CREATE INDEX IF NOT EXISTS idx_neurons_netuid_permit ON neurons (netuid, validator_permit, stake_tao DESC);
CREATE INDEX IF NOT EXISTS idx_neurons_hotkey        ON neurons (hotkey);

-- Featured-validator pin (#5166): a maintainer toggle to elevate a validator to
-- the top of /api/v1/validators and a subnet's validator list, keyed by
-- hotkey rather than a column on `neurons`. `neurons`' primary key is
-- (netuid, uid) -- a UID *slot*, not a stable identity -- and handleNeuronsSync
-- (workers/data-api.ts) hard-DELETEs a row once its UID falls out of the
-- latest snapshot (deregistration), with that UID free to be reassigned to a
-- different hotkey later. A `featured` column on `neurons` would either vanish
-- silently on prune or, worse, incorrectly "follow" the slot to whatever
-- hotkey registers into it next. hotkey identity survives deregistration/
-- reassignment cycles, so this small side table sidesteps the hazard entirely.
-- Toggled by a direct SQL UPDATE/INSERT -- no code deploy needed to change
-- which validator is featured.
--
-- Disclosure requirement (added when this pin became a real, sold sponsored-
-- placement product rather than dormant infra): a hotkey in this table is a
-- PAID placement, not an editorial/quality signal. The frontend must always
-- render it as SponsoredBadge (apps/ui/src/components/metagraphed/
-- neuron-table.tsx) with a persistent, non-hover-gated "Sponsored" label --
-- and, on the subnet/validator listing surfaces, as its own separate
-- SponsoredValidatorCallout card ABOVE the objectively stake-ranked list,
-- never as an unmarked row inside it. NUMERIC_FIELDS in neuron-table.tsx
-- structurally excludes `featured` from every sort option, so a placement
-- here can never distort the neutral ranking those surfaces show. Toggling
-- this table is a maintainer-only operational action (direct SQL, like this
-- comment says above) -- treat it the same as any other paid/disclosed
-- placement decision, not a data-quality judgment.
CREATE TABLE IF NOT EXISTS featured_validators (
  hotkey      TEXT PRIMARY KEY,
  featured_at BIGINT NOT NULL
);

-- Per-hotkey nominator counts, one row per validator (#2549; mirrors D1
-- migrations/0043_validator_nominator_counts.sql). Derived from a full scan
-- of SubtensorModule::Alpha, populated by its own lower-frequency job
-- (scripts/fetch-validator-nominator-counts.py) and joined into
-- buildGlobalValidators/buildValidatorDetail at serve time -- mirrors
-- featured_validators' own side-table join pattern above. Latest-only,
-- REPLACE-on-conflict.
CREATE TABLE IF NOT EXISTS validator_nominator_counts (
  hotkey           TEXT    NOT NULL,
  nominator_count  INTEGER NOT NULL,
  captured_at      BIGINT  NOT NULL,
  PRIMARY KEY (hotkey)
);

-- Nominator (coldkey) positions across every hotkey/subnet it stakes to
-- (#5233; mirrors D1 migrations/0044_nominator_positions.sql) -- the
-- per-coldkey counterpart to validator_nominator_counts above, populated
-- by the SAME Alpha full scan. share_fraction is the normalized share of
-- that hotkey+netuid's stake pool (NOT a TAO amount), joined against
-- neurons.stake_tao at serve time (src/account-nominator-positions.ts).
-- Root (netuid 0) is not covered -- see the fetch script's own header.
CREATE TABLE IF NOT EXISTS nominator_positions (
  coldkey        TEXT NOT NULL,
  hotkey         TEXT NOT NULL,
  netuid         INTEGER NOT NULL,
  share_fraction REAL NOT NULL,
  captured_at    BIGINT NOT NULL,
  PRIMARY KEY (coldkey, hotkey, netuid)
);

-- ---------------------------------------------------------------------------
-- Chain-wide account balance snapshot (#6741/#6742) -- the balance-based
-- top-holder leaderboard epic's foundational data tier. One row per account
-- with a nonzero free or reserved balance, from a direct System::Account
-- storage-map scan (scripts/fetch-account-balances.py) -- NOT reconstructed
-- from transfer/stake/fee events, which can silently drift if any mutation
-- path is missed. Covers every account that has ever held a balance,
-- registered neuron or not -- joined with `neurons`.stake_tao at the API
-- layer for the "Delegated"/"Total" leaderboard columns, not duplicated
-- here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_balances (
  ss58          TEXT NOT NULL,
  free_tao      NUMERIC NOT NULL,
  reserved_tao  NUMERIC NOT NULL,
  captured_at   BIGINT NOT NULL,
  PRIMARY KEY (ss58)
);
CREATE INDEX IF NOT EXISTS idx_account_balances_free_tao ON account_balances (free_tao DESC);

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
  take             REAL,
  PRIMARY KEY (netuid, uid, snapshot_date)
);
-- Same schema drift as `neurons` above (fixed 2026-07-19): handleNeuronsSync
-- (workers/data-api.ts) writes `take` into neuron_daily via the same
-- NEURON_INSERT_COLUMNS list, but this table's CREATE TABLE never carried the
-- column and never got the matching ALTER. Same no-op-on-fresh-deploy
-- convention as the neurons fix.
ALTER TABLE neuron_daily ADD COLUMN IF NOT EXISTS take REAL;
-- #2083: covering index for per-subnet history aggregation (avoid per-row heap fetch).
CREATE INDEX IF NOT EXISTS idx_nd_netuid_date ON neuron_daily (netuid, snapshot_date, uid)
  INCLUDE (stake_tao, incentive, dividends, emission_tao);
CREATE INDEX IF NOT EXISTS idx_nd_uid_date    ON neuron_daily (netuid, uid, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_nd_hotkey_date ON neuron_daily (hotkey, snapshot_date);

-- Per-account daily position HISTORY (#4832 gap-closure; mirrors D1
-- migrations/0038_account_position_daily.sql). Rolled from the SAME `neurons`
-- snapshot as neuron_daily, in the SAME handleNeuronsSync write (#4771) --
-- account = hotkey ss58, matching loadAccountPortfolio's "WHERE hotkey = ?"
-- framing (src/account-portfolio.ts).
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
-- Written from src/health-prober.ts's writeSubnetSnapshot, the SAME
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
  -- Pool liquidity + volume (#2552) — point-in-time AMM reserves/cumulative
  -- volume, NUMERIC like the other TAO-precision economics columns above.
  tao_in_pool_tao    NUMERIC,
  alpha_in_pool      NUMERIC,
  alpha_out_pool     NUMERIC,
  subnet_volume_tao  NUMERIC,
  -- v440 emission-pipeline inputs (#8743, migration 0050). Nullable: NULL
  -- means "not captured" (a refresh whose node could not serve
  -- state_queryStorageAt), never zero. emission_enabled/subtoken_enabled hold
  -- the DECODED chain boolean -- SubnetEmissionEnabled defaults to TRUE on
  -- chain, so key presence is not the signal and no column DEFAULT is set.
  tao_in_emission_tao   NUMERIC,
  excess_tao            NUMERIC,
  alpha_in_emission     NUMERIC,
  alpha_out_emission    NUMERIC,
  miner_burned_fraction NUMERIC,
  emission_enabled      BOOLEAN,
  subtoken_enabled      BOOLEAN,
  first_emission_block  BIGINT,
  -- Provenance for the pipeline columns above (#8744, migration 0051). The
  -- height and hash every one of those reads was pinned to, so a published
  -- decomposition can be replayed against the exact state it was built from.
  -- Per-row although network-wide -- see 0051 for why. NULL means "no pinned
  -- read behind this row", never backfilled from captured_at or chain tip.
  --
  -- Note for readers of 0050: its header calls a single observation "noisy BY
  -- CONSTRUCTION" and names a daily rollup the reportable figure. Measured
  -- across 14 consecutive blocks (#8744), the channels move a few rao per
  -- block, smoothly, and the derived liquidity_fraction varies by ~1e-5 --
  -- well inside the reconstruction's own 2e-4 tolerance. There is no rollup;
  -- these are point samples, published as such.
  pipeline_block        BIGINT,
  pipeline_block_hash   TEXT,
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
-- the refresh-subnet-hyperparams workflow's direct POST to data-api.ts.
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

-- Emission-gate parameter and per-subnet enablement history (#8748).
--
-- The switches steering the v440 emission pipeline change rarely, silently, and
-- consequentially. EmissionBarQuantile already moved from its 0.61 default to
-- 0.75 after the v440 deploy -- a change that materially reshaped the gate --
-- and that move is now unrecoverable from anything we hold. Same for the 47
-- subnets carrying SubnetEmissionEnabled = false: we can read the current
-- state, never when or in what order it was set.
--
-- Append-on-change, not overwrite-per-refresh: a row exists only where a value
-- actually moved, so the table IS the change log rather than a sampling of one.
--
-- THETA IS NOT A GOVERNANCE PARAMETER. EmissionGateBar is recomputed by the
-- runtime whenever block % 360 == 0, from the live demand distribution -- it
-- moves constantly and on its own. `source` separates that from a human-set
-- change to q or h, so a reader asking "what did governance do" is never
-- answered with 20 runtime recomputations a day.
CREATE TABLE IF NOT EXISTS emission_gate_param_history (
  id              BIGSERIAL PRIMARY KEY,
  -- 'emission_gate_bar' | 'emission_bar_quantile' | 'emission_gate_exponent'
  -- | 'block_emission_halvings'
  param           TEXT     NOT NULL,
  -- NULL is a real reading: an unset storage item means "use the runtime
  -- default", which is NOT zero (h unset means 3, and h = 0 would make the
  -- Hill gate 0.5 for every subnet).
  value           NUMERIC,
  previous_value  NUMERIC,
  -- 'governance' (q, h -- set by a root-origin extrinsic) or
  -- 'runtime_recomputed' (theta -- recomputed on the 360-block cadence).
  source          TEXT     NOT NULL,
  block_number    BIGINT,
  observed_at     BIGINT   NOT NULL,
  -- TRUE only on a param's FIRST row: the value was already in place when
  -- capture began, so its own change date is unrecoverable. This is how the
  -- historical 0.61 -> 0.75 quantile move is representable without inventing
  -- a date for it (#8748 acceptance).
  predates_capture BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT emission_gate_param_history_source_check
    CHECK (source IN ('governance', 'runtime_recomputed'))
);

CREATE INDEX IF NOT EXISTS emission_gate_param_history_param_observed_idx
  ON emission_gate_param_history (param, observed_at DESC);

-- Per-subnet emission enablement. SubnetEmissionEnabled DEFAULTS TO TRUE:
-- absent storage is ENABLED and 0x00 is disabled, so a naive "is the key set"
-- check inverts the meaning. `enabled` is therefore the decoded boolean, never
-- key presence.
CREATE TABLE IF NOT EXISTS subnet_emission_enabled_history (
  id               BIGSERIAL PRIMARY KEY,
  netuid           INTEGER  NOT NULL,
  enabled          BOOLEAN  NOT NULL,
  previous_enabled BOOLEAN,
  block_number     BIGINT,
  observed_at      BIGINT   NOT NULL,
  predates_capture BOOLEAN  NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS subnet_emission_enabled_history_netuid_observed_idx
  ON subnet_emission_enabled_history (netuid, observed_at DESC);

-- Dormant TAO-flow emission path watch (#8750, migration 0048).
--
-- v440 ships a SECOND, fully-written emission-share implementation
-- (`get_shares_flow`, from TAO FLOW EMAs rather than price EMAs). It is
-- `#[allow(dead_code)]`; the live path is `get_shares_price_ema`. Switching it
-- on changes the gate's input from price to demand flow and moves every
-- published emission number at once -- with no governance pallet (#8697) there
-- is no proposal or vote to see it coming.
--
-- Provisioned and partially warm: the raw accumulator (`SubnetTaoFlow`) is
-- written continuously by live stake/swap code, while `SubnetEmaTaoFlow` is set
-- on 124 of 128 subnets and every one frozen at exactly block 8,466,530 -- a
-- path that ran and was switched off, staged rather than abandoned.
--
-- Append-on-change: zero rows is the CORRECT steady state and means the price
-- path is still live, not that the monitor is broken. `SubnetTaoFlow` is
-- deliberately not watched -- it moves with ordinary staking/swapping and
-- carries no signal.
CREATE TABLE IF NOT EXISTS emission_flow_watch (
  id               BIGSERIAL PRIMARY KEY,
  item             TEXT     NOT NULL,
  netuid           INTEGER,
  is_set           BOOLEAN  NOT NULL,
  ema_block        BIGINT,
  block_number     BIGINT,
  observed_at      BIGINT   NOT NULL,
  predates_capture BOOLEAN  NOT NULL DEFAULT FALSE,
  CONSTRAINT emission_flow_watch_item_check
    CHECK (item IN (
      'net_tao_flow_enabled', 'flow_norm_exponent', 'tao_flow_cutoff',
      'flow_ema_smoothing_factor', 'subnet_ema_tao_flow'
    )),
  CONSTRAINT emission_flow_watch_shape_check
    CHECK (
      (item = 'subnet_ema_tao_flow' AND netuid IS NOT NULL AND ema_block IS NOT NULL)
      OR (item <> 'subnet_ema_tao_flow' AND netuid IS NULL AND ema_block IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS emission_flow_watch_item_observed_idx
  ON emission_flow_watch (item, observed_at DESC);

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

-- Subnet-ownership-contest lock positions (#6638, conviction/ownership-contest
-- tracker epic #4302) -- latest-only snapshot of the chain's HotkeyLock/
-- DecayingHotkeyLock/OwnerLock/DecayingOwnerLock storage maps (see
-- docs/conviction-lock-mechanism.md). One row per (netuid, hotkey, is_owner,
-- is_perpetual): the pallet maintains a PERPETUAL sub-aggregate and a DECAYING
-- sub-aggregate separately per hotkey (and per subnet owner) -- both must be
-- captured and rolled forward independently at read time (each decays, or
-- doesn't, on its own), never summed raw before rolling. conviction_bits is
-- the raw U64F64 (u128) fixed-point value straight off the chain -- NUMERIC,
-- not BIGINT, since it exceeds BIGINT's 64-bit range; the read-side shaping
-- divides by 2^64 for the float value, live-rolled forward using the
-- CURRENT UnlockRate/MaturityRate (also live-queried, never hardcoded --
-- confirmed live 2026-07-18 that MaturityRate's live value, 311622, differs
-- from what an earlier research pass assumed).
CREATE TABLE IF NOT EXISTS subnet_locks (
  netuid          INTEGER NOT NULL,
  hotkey          TEXT NOT NULL,
  is_owner        BOOLEAN NOT NULL,
  is_perpetual    BOOLEAN NOT NULL,
  locked_mass     BIGINT NOT NULL,
  conviction_bits NUMERIC NOT NULL,
  last_update     BIGINT,
  captured_at     BIGINT NOT NULL,
  PRIMARY KEY (netuid, hotkey, is_owner, is_perpetual)
);
CREATE INDEX IF NOT EXISTS idx_subnet_locks_netuid ON subnet_locks (netuid);

-- Real on-chain subnet ownership (metagraphed-infra#138; closes the gap
-- JSONbored/metagraphed#6644 found -- no clean provider<->owner mapping
-- existed anywhere). Latest-only snapshot, one row per currently-registered
-- netuid, resolved via SubtensorModule::SubnetOwnerHotkey(netuid) ->
-- SubtensorModule::Owner(hotkey) and written by apps/indexer-rs's poller
-- binary (src/bin/poller.rs), NOT the JS Worker -- this is the first job in
-- the consolidated chain-state polling service, not a data-refresh-cron/
-- data-api.ts sync route like every other table in this file. A netuid
-- whose owner hotkey resolves to the zero account (unset/deregistered) is
-- never written here, matching the bittensor SDK's own "no real owner"
-- convention -- rows disappear (pruned) rather than being written as
-- zero-account placeholders.
CREATE TABLE IF NOT EXISTS subnet_ownership (
  netuid        INTEGER NOT NULL,
  owner_hotkey  TEXT NOT NULL,
  owner_coldkey TEXT NOT NULL,
  captured_at   BIGINT NOT NULL,
  PRIMARY KEY (netuid)
);

-- Ownership-change history (metagraphed#6970): append-only, diff-based --
-- one row per netuid per DISTINCT (owner_hotkey, owner_coldkey) observed,
-- not one row per poll tick (same convention as subnet_hyperparams_history/
-- neuron_daily: subnet_ownership.rs compares against the current row before
-- writing here, so a run of ticks with an unchanged owner produces exactly
-- one history row, not one every 5 minutes). The first-ever observation of
-- a netuid is also recorded (not just changes after tracking began), so
-- this table doubles as "when did we first see this subnet's owner" even
-- before any transfer has happened.
CREATE TABLE IF NOT EXISTS subnet_ownership_history (
  id            BIGSERIAL PRIMARY KEY,
  netuid        INTEGER NOT NULL,
  owner_hotkey  TEXT NOT NULL,
  owner_coldkey TEXT NOT NULL,
  captured_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subnet_ownership_history_netuid ON subnet_ownership_history (netuid, captured_at DESC);

-- Personal (coldkey) chain identity, latest-only (#4832 gap-closure Phase B;
-- mirrors D1 migrations/0039_account_identity.sql). One row per account,
-- upserted by the refresh-account-identity workflow's direct POST to
-- data-api.ts. Deliberately NO purge step (unlike subnet_hyperparams above):
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
-- src/health-prober.ts), not an external GitHub Actions workflow.
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

-- Per-coldkey daily stake-flow rollup (#6886/#6887): net/gross StakeAdded vs
-- StakeRemoved per account per day, summed cross-subnet -- the account-keyed,
-- pre-aggregated counterpart to account_events_daily above (which is
-- hotkey+netuid-keyed). Written by the same rollup tick as
-- account_events_daily (handleRollupAccountEventsDaily), re-rolling the
-- active UTC day(s) each run. Read by GET /api/v1/accounts/top-holders'
-- ?sort=net_flow_7d|net_flow_30d|net_flow_90d, which SUMs the requested
-- window's rows per account at request time -- this table stays DAILY
-- granularity (not pre-summed per window) so a new window can be added later
-- without a backfill.
CREATE TABLE IF NOT EXISTS wallet_flow_daily (
  coldkey       TEXT NOT NULL,
  day           DATE NOT NULL,
  net_flow_tao  NUMERIC NOT NULL,
  gross_in_tao  NUMERIC NOT NULL,
  gross_out_tao NUMERIC NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (coldkey, day)
);
CREATE INDEX IF NOT EXISTS idx_wallet_flow_daily_day ON wallet_flow_daily (day);

-- ---------------------------------------------------------------------------
-- Health tracking (#4832 gap-closure; mirrors D1 migrations/0001_health.sql +
-- 0003_uptime_history.sql + 0005_surface_key.sql + 0006_surface_key_rekey.sql
-- + 0012_latency_percentiles.sql, in their final post-migration column shape
-- rather than replayed incrementally). Written every 15 minutes by the
-- Cloudflare cron prober (src/health-prober.ts, runHealthProber; wrangler.jsonc
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
-- #8811: the rollup writer always INSERTs a non-null surface_key via
-- COALESCE(surface_key, surface_id) over NOT NULL surface_id, and upserts on
-- (surface_key, day) WHERE surface_key IS NOT NULL. Legacy rows with
-- surface_key IS NULL sit outside that partial unique index and would still
-- collide on PRIMARY KEY (surface_id, day) without matching the arbiter.
-- Idempotent: re-applying is a no-op once every row has a key.
UPDATE surface_uptime_daily SET surface_key = surface_id WHERE surface_key IS NULL;
-- handleBulkHealthTrends: `... WHERE day >= ? GROUP BY netuid, day` --
-- (day, netuid) matches a `day >=` range scan across all subnets (mirrors
-- the same reasoning as idx_surface_uptime_daily_day_netuid in D1's
-- migrations/0010_perf_indexes.sql).
CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_day_netuid
  ON surface_uptime_daily (day, netuid);

-- RPC reverse-proxy usage telemetry (#4832 gap-closure; mirrors D1
-- migrations/0004_rpc_proxy_usage.sql + 0010_perf_indexes.sql). Written
-- best-effort per proxied request (workers/request-handlers/rpc-proxy.ts's
-- recordRpcUsage), not a cron/workflow batch like every other #4832 table --
-- confirmed live 2026-07-11 the real volume is trivial (69 rows over ~25
-- days), so this stays a plain table like subnet_hyperparams/
-- subnet_snapshots above rather than a hypertable; revisit if traffic grows.
-- Same 30-day pruning window as surface_checks (src/health-prober.ts's
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
-- Realtime firehose outbox (ADR 0015, #4980)
-- ---------------------------------------------------------------------------

-- Best-effort relay source for blocks/extrinsics/chain_events. This is a
-- normal table, not Postgres LISTEN/NOTIFY: NOTIFY queue exhaustion is checked
-- at transaction commit and can make the writer transaction fail outside any
-- trigger-local EXCEPTION block (found by adversarial review, confirmed
-- against Postgres's own PreCommit_Notify docs -- an AFTER ROW trigger's
-- local EXCEPTION handler runs BEFORE that commit-time check and cannot catch
-- it). Keeping the tee as table state means a stuck or malicious
-- relay/listener cannot pin Postgres's global async notification queue and
-- abort indexer commits.
--
-- The trigger still runs inside the writer transaction, so ordinary local
-- database failures (for example disk exhaustion) remain database failures;
-- downstream firehose delivery state does not participate in commits. The
-- relay claims rows from this outbox, forwards them, and may delete or mark
-- delivered rows according to its retention policy. To keep relay downtime
-- from turning this best-effort stream into unbounded database growth, the
-- enqueue trigger prunes stale pending rows and keeps only the newest 5,000
-- pending rows before appending another one.
CREATE TABLE IF NOT EXISTS chain_firehose_outbox (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name  TEXT NOT NULL CHECK (table_name IN ('blocks', 'extrinsics', 'chain_events', 'account_events')),
  payload     JSONB NOT NULL,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chain_firehose_outbox_pending
  ON chain_firehose_outbox (id)
  WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chain_firehose_outbox_created
  ON chain_firehose_outbox (created_at);

-- Row-level (FOR EACH ROW), not statement-level: simpler to reason about
-- for a first cut, at the cost of one outbox row per source row rather than
-- one per batch insert. indexer-rs batch-inserts many extrinsics/chain_events
-- per block, so a busy block can enqueue dozens of outbox rows. If that volume
-- becomes a real problem, the natural fast-follow is a statement-level trigger
-- with a `REFERENCING NEW TABLE AS new_rows` transition table, batching one
-- outbox row per INSERT statement -- not attempted here to avoid over-building
-- ahead of measured need.
--
-- Which logical table fired is passed as an explicit trigger argument
-- (TG_ARGV[0]), NOT read from TG_TABLE_NAME: on a TimescaleDB hypertable,
-- inserts are physically routed to a per-time-range CHUNK table (e.g.
-- `_hyper_1_379_chunk`), and a trigger attached to the hypertable is
-- transparently propagated to (and fires on) that chunk -- so TG_TABLE_NAME
-- inside the function body is the CHUNK's internal name, never the logical
-- hypertable name 'blocks'/'extrinsics'/'chain_events'. Verified live
-- (2026-07-12): a debug trigger using TG_TABLE_NAME on a real indexer-rs
-- insert observed the value `_hyper_1_379_chunk`, not `blocks` -- confirming
-- an earlier version of this function that branched on TG_TABLE_NAME was a
-- silent no-op on every real insert (always took the ELSE branch, never
-- notified) despite creating and attaching without error.
DROP FUNCTION IF EXISTS notify_chain_firehose() CASCADE;
CREATE OR REPLACE FUNCTION enqueue_chain_firehose() RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
BEGIN
  IF TG_ARGV[0] = 'blocks' THEN
    payload := jsonb_build_object(
      'table', 'blocks',
      'block_number', NEW.block_number,
      'block_hash', NEW.block_hash,
      'extrinsic_count', NEW.extrinsic_count,
      'event_count', NEW.event_count,
      'observed_at', NEW.observed_at
    );
  ELSIF TG_ARGV[0] = 'extrinsics' THEN
    payload := jsonb_build_object(
      'table', 'extrinsics',
      'block_number', NEW.block_number,
      'extrinsic_index', NEW.extrinsic_index,
      'call_module', NEW.call_module,
      'call_function', NEW.call_function,
      'signer', NEW.signer,
      'success', NEW.success,
      'observed_at', NEW.observed_at
    );
  ELSIF TG_ARGV[0] = 'chain_events' THEN
    payload := jsonb_build_object(
      'table', 'chain_events',
      'block_number', NEW.block_number,
      'event_index', NEW.event_index,
      'pallet', NEW.pallet,
      'method', NEW.method,
      'observed_at', NEW.observed_at
    );
  ELSIF TG_ARGV[0] = 'account_events' THEN
    -- #4984 prerequisite: blocks/extrinsics/chain_events carry no netuid/
    -- hotkey/coldkey/amount_tao -- the alerter's own example trigger
    -- conditions ("netuid=X", "account=Z", "amount_tao > N") need this
    -- curated tier's columns directly, so it gets its own firehose branch
    -- rather than requiring every alert evaluation to re-fetch by PK.
    payload := jsonb_build_object(
      'table', 'account_events',
      'block_number', NEW.block_number,
      'event_index', NEW.event_index,
      'event_kind', NEW.event_kind,
      'hotkey', NEW.hotkey,
      'coldkey', NEW.coldkey,
      'netuid', NEW.netuid,
      'amount_tao', NEW.amount_tao,
      'observed_at', NEW.observed_at
    );
  ELSE
    RETURN NEW;
  END IF;

  DELETE FROM chain_firehose_outbox
  WHERE delivered_at IS NULL
    AND created_at < now() - INTERVAL '1 hour';

  WITH overflow AS (
    SELECT id
    FROM chain_firehose_outbox
    WHERE delivered_at IS NULL
    ORDER BY id DESC
    OFFSET 4999
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM chain_firehose_outbox
  WHERE id IN (SELECT id FROM overflow);

  INSERT INTO chain_firehose_outbox (table_name, payload)
  VALUES (TG_ARGV[0], payload);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every firehose trigger carries the SAME `WHEN` age gate. The firehose
-- broadcasts LIVE chain activity to subscribers; a historical backfill
-- replaying old blocks through it has no consumer and must not pay for it.
--
-- This is a throughput cliff, not a nicety. enqueue_chain_firehose() runs FOR
-- EACH ROW and, per row, does a DELETE ... WHERE created_at < now() - 1 hour
-- plus an ORDER BY id DESC OFFSET 4999 ... DELETE over chain_firehose_outbox
-- before inserting. Affordable at live rate (a few rows per 12s block);
-- ruinous for a backfill inserting millions. Measured on meta-indexer-01
-- 2026-07-31 via EXPLAIN ANALYZE of the indexer's own flush statement:
-- inserting 500 rows into `blocks` took 63,242ms, of which the insert was
-- 13ms and the trigger was 63,228ms -- 99.98% of runtime, ~126ms per row.
-- With this gate the identical statement runs in 13.5ms (~4,700x).
--
-- A WHEN clause is evaluated by the executor WITHOUT entering the function
-- body, so skipped rows cost essentially nothing.
--
-- 10 minutes of slack (600000 ms), not a tight bound: live-follow can
-- legitimately lag the head briefly (reconnects, restarts) and those rows
-- must still reach the firehose. observed_at is epoch ms (see the hypertable
-- comments in schema-timescaledb.sql), hence the extract(epoch)*1000 form.
DROP TRIGGER IF EXISTS trg_blocks_firehose ON blocks;
CREATE TRIGGER trg_blocks_firehose
  AFTER INSERT ON blocks
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('blocks');

DROP TRIGGER IF EXISTS trg_extrinsics_firehose ON extrinsics;
CREATE TRIGGER trg_extrinsics_firehose
  AFTER INSERT ON extrinsics
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('extrinsics');

DROP TRIGGER IF EXISTS trg_chain_events_firehose ON chain_events;
CREATE TRIGGER trg_chain_events_firehose
  AFTER INSERT ON chain_events
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('chain_events');

-- #4984 prerequisite (see enqueue_chain_firehose()'s account_events branch
-- above). account_events is ALSO a TimescaleDB hypertable
-- (schema-timescaledb.sql), so this trigger fires on its per-time-range
-- chunk exactly like the three above -- TG_ARGV[0] carries the logical name
-- for the same reason.
-- Same age gate as the three above -- see their comment for the measurement.
DROP TRIGGER IF EXISTS trg_account_events_firehose ON account_events;
CREATE TRIGGER trg_account_events_firehose
  AFTER INSERT ON account_events
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('account_events');

-- ---------------------------------------------------------------------------
-- Chain alert triggers (#4984, ADR 0015) -- user-defined "notify me when X
-- happens on-chain" conditions, evaluated against the SAME firehose above by
-- a Durable Object consumer (AlerterHub, #4984 Part 2) rather than a second
-- Postgres poll loop. No user-account system exists in this codebase, so
-- ownership is a bearer token (owner_token, returned once at creation) --
-- the SAME model src/webhooks.ts's per-subscription secret already
-- establishes for webhook subscriptions. A small, low-cardinality table (one
-- row per user-created alert, not one per chain event), so it is deliberately
-- NOT a hypertable -- no entry in schema-timescaledb.sql.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chain_alert_triggers (
  id                BIGSERIAL PRIMARY KEY,
  -- Bearer credential for GET/PATCH/DELETE on this one trigger. Unlike
  -- webhook subscriptions' public GET, every single-trigger route here
  -- requires it: `destination` can itself be a capability credential (a
  -- Discord incoming-webhook URL grants POST-message rights to anyone
  -- holding it), so there is no safe "public" view of a trigger.
  owner_token       TEXT NOT NULL,
  name              TEXT,
  -- NULL = any of CHAIN_FIREHOSE_TABLES (workers/chain-firehose-hub.ts);
  -- otherwise a subset, validated against that same Set before insert.
  table_filter      TEXT[],
  netuid            INTEGER,
  -- account_events.event_kind vocabulary (e.g. Transfer, StakeAdded) --
  -- chain_events' raw pallet/method is NOT matchable here; see the
  -- account_events firehose-tee prerequisite's own comment above.
  event_kind        TEXT,
  -- Matches account_events.hotkey OR .coldkey (an alert on "this account"
  -- shouldn't require the owner to know which leg a given event used).
  account           TEXT,
  min_amount_tao    NUMERIC,
  -- #6746: a computed/derived-metric predicate ({metric, operator,
  -- threshold}, validated by src/alert-triggers.ts's validateAlertCondition)
  -- rather than a raw event-field match -- narrows whichever event already
  -- passed the fixed-field checks above, so it carries no separate scope of
  -- its own. NULL for every pre-#6746 trigger (a fixed-field-only match,
  -- unaffected by this column's presence).
  condition         JSONB,
  channel           TEXT NOT NULL CHECK (channel IN ('webhook', 'email', 'telegram', 'discord', 'webpush')),
  -- Shape depends on channel: a public https:// URL (webhook), an email
  -- address (email), a chat id or @channelusername (telegram), or the exact
  -- Discord incoming-webhook URL shape (discord) -- validated at write time
  -- by src/alert-triggers.ts's isValidAlertDestination, not re-validated on
  -- every delivery.
  destination       TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  last_matched_at   BIGINT,
  match_count       BIGINT NOT NULL DEFAULT 0
);
-- #6746: safe on an already-deployed table (a fresh CREATE TABLE above
-- already includes the column; this is a no-op there) -- adds it to an
-- existing production table, where CREATE TABLE IF NOT EXISTS alone would
-- not, since the table already exists.
ALTER TABLE chain_alert_triggers ADD COLUMN IF NOT EXISTS condition JSONB;
-- #8374: NULL for an operator-token-created trigger (no wallet involved);
-- the verified ss58 for one created via a wallet-verified watch token
-- (src/wallet-auth.ts's createTriggerToken). Read to enforce
-- WATCH_TRIGGERS_MAX_PER_ADDRESS at create time and, later, to list "my
-- triggers" in the alert center (#8375, same epic).
ALTER TABLE chain_alert_triggers ADD COLUMN IF NOT EXISTS owner_ss58 TEXT;
-- #8385: widen the channel CHECK to admit 'webpush'.
--
-- This ALTER is load-bearing, not decorative. The CREATE TABLE above is
-- `IF NOT EXISTS`, so on an already-deployed database its inline CHECK is
-- never re-evaluated -- editing the constraint text up there alone is a
-- silent no-op against production, and every INSERT of a webpush trigger
-- would fail with a check-constraint violation. Same reason `condition` and
-- `owner_ss58` above ship as explicit ALTERs rather than column edits.
--
-- DROP ... IF EXISTS immediately followed by ADD keeps the pair idempotent
-- (ADD CONSTRAINT alone would fail on a second run). The constraint name is
-- the one Postgres auto-generates for an unnamed inline column CHECK,
-- `<table>_<column>_check` -- verified against postgres:16-alpine rather
-- than assumed.
ALTER TABLE chain_alert_triggers
  DROP CONSTRAINT IF EXISTS chain_alert_triggers_channel_check;
ALTER TABLE chain_alert_triggers
  ADD CONSTRAINT chain_alert_triggers_channel_check
  CHECK (channel IN ('webhook', 'email', 'telegram', 'discord', 'webpush'));
-- Covers AlerterHub's own "give me every active trigger" cache-refresh scan
-- (#4984 Part 2) -- the only query pattern against this table that isn't
-- already a fast primary-key lookup by id.
CREATE INDEX IF NOT EXISTS idx_cat_active ON chain_alert_triggers (active) WHERE active;
-- #8374: the WATCH_TRIGGERS_MAX_PER_ADDRESS count check's own query pattern
-- ("how many active triggers does this ss58 already own") -- partial index
-- since the large majority of rows (operator-created) have owner_ss58 NULL
-- and are never matched by this predicate.
CREATE INDEX IF NOT EXISTS idx_cat_owner_ss58_active ON chain_alert_triggers (owner_ss58) WHERE owner_ss58 IS NOT NULL AND active;

-- ---------------------------------------------------------------------------
-- Per-delivery attempt log (#8375, same epic as chain_alert_triggers above) --
-- the Alert Center's "last 20 deliveries" history. AlerterHub.deliverAlertMatch
-- (workers/alerter-hub.ts) writes one row per attempted delivery, best-effort
-- (a failed write-back here never blocks or fails the delivery itself, same
-- posture as that file's existing match_count write-back). `retry_count` is
-- carried for forward-compat with src/alert-delivery.ts's documented
-- "retry/dead-letter is a deliberate v1 scope cut" fast-follow -- always 0
-- today, since delivery is single-attempt only. Pruned to the most recent 20
-- rows per trigger on every insert (see handleAlertTriggerDeliveryLogWrite in
-- workers/data-api.ts) rather than a separate TTL sweep -- a small,
-- self-bounding table, so no entry in schema-timescaledb.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_alert_deliveries (
  id                BIGSERIAL PRIMARY KEY,
  trigger_id        BIGINT NOT NULL REFERENCES chain_alert_triggers(id) ON DELETE CASCADE,
  delivered_at      BIGINT NOT NULL,
  success           BOOLEAN NOT NULL,
  status_code       INTEGER,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  -- Truncated at write time (see ALERT_DELIVERY_RESPONSE_SNIPPET_MAX_BYTES) --
  -- never the full response body, only enough to show why a delivery failed.
  response_snippet  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cad_trigger_delivered_at ON chain_alert_deliveries (trigger_id, delivered_at DESC);

-- ---------------------------------------------------------------------------
-- Web-push device subscriptions (#8385, epic T9) -- the `webpush` alert
-- channel's delivery targets. Deliberately its OWN table rather than more
-- chain_alert_triggers.destination text: a subscription is three correlated
-- values (endpoint + two key materials), it is per-DEVICE while a trigger is
-- per-alert, and one device is reused by every trigger the same address owns.
-- A trigger with channel='webpush' therefore stores the subscription's
-- `endpoint` in `destination`, and this table holds the crypto material.
--
-- Bound to the T6 wallet-verified address (#8374), same identity the trigger
-- tokens use -- so "my devices" is answerable without an accounts system.
--
-- p256dh/auth are the subscriber's OWN public key + auth secret handed to us
-- by the browser's Push API. They are not our secrets, and are useless
-- without the secret half that never leaves the device -- but they ARE
-- per-user data: never log them, and never expose them on a read route (the
-- GET returns only the metadata a human needs to recognise a device).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watch_push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  -- The T6 verified ss58 that owns this device.
  address      TEXT NOT NULL,
  -- Push-service URL. UNIQUE so re-subscribing the same browser updates in
  -- place instead of silently accruing duplicate devices (browsers reissue
  -- the same endpoint for an unchanged subscription).
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  -- Coarse label so a human can tell "iPhone" from "work laptop" when
  -- revoking. Truncated at write time; never the raw full UA string.
  user_agent   TEXT,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_wps_address ON watch_push_subscriptions (address, created_at DESC);

-- ---------------------------------------------------------------------------
-- Self-serve API keys (ADR 0020, epic #6733/#6735) -- the optional identity
-- tier a caller can opt into for a higher rate-limit bucket + self-checkable
-- usage. Keyless-by-default is unchanged; this table is additive.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id             BIGSERIAL PRIMARY KEY,
  -- Public, non-secret identifier (16 hex chars) -- safe to log, safe as a KV
  -- cache key, safe in a support ticket. Never the full credential.
  prefix         TEXT NOT NULL UNIQUE,
  -- SHA-256 hex digest of the secret portion ONLY -- a deliberate departure
  -- from chain_alert_triggers.owner_token's plaintext-at-rest precedent (see
  -- ADR 0020 section 2): this credential is broader-scope and longer-lived,
  -- so a full-table compromise must not hand out live credentials in
  -- plaintext. The raw secret is never stored anywhere, only ever compared
  -- by re-hashing the caller-provided value.
  secret_hash    TEXT NOT NULL,
  -- Not a login/auth flow (none exists) -- purely somewhere an abuse report
  -- or deprecation notice can go, matching taostats' own signup requirement.
  -- Unverified in v1.
  owner_contact  TEXT NOT NULL,
  tier           TEXT NOT NULL DEFAULT 'keyed',
  created_at     BIGINT NOT NULL,
  revoked_at     BIGINT,
  last_used_at   BIGINT
);
-- The hot-path lookup: KV-cache-miss validation resolves a caller's prefix to
-- its stored hash/tier/revoked state. Already covered by the UNIQUE
-- constraint's implicit index; explicit only for readability/documentation.
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);

-- ---------------------------------------------------------------------------
-- Wallet-gated accounts for the fullnode RPC cluster (ADR 0021, #6835) -- the
-- first user-account system in this codebase. One row per verified ss58
-- address (wallet-signature login only, no email/password). A single
-- account can hold multiple api_keys rows; account_id below links a minted
-- key back to the account that minted it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rpc_accounts (
  id             BIGSERIAL PRIMARY KEY,
  ss58           TEXT NOT NULL UNIQUE,
  tier           TEXT NOT NULL DEFAULT 'free',
  created_at     BIGINT NOT NULL,
  last_login_at  BIGINT
);
-- Already covered by the UNIQUE constraint's implicit index; explicit only
-- for readability/documentation (matches idx_api_keys_prefix's convention).
CREATE INDEX IF NOT EXISTS idx_rpc_accounts_ss58 ON rpc_accounts (ss58);

-- Nullable: ADR 0020's anonymous, contact-only keys (the public API tier
-- this ADR doesn't touch) keep working unchanged with no account_id. Safe on
-- an already-deployed api_keys table -- CREATE TABLE IF NOT EXISTS above
-- already includes the column for a fresh deploy; this is a no-op there.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES rpc_accounts (id);
CREATE INDEX IF NOT EXISTS idx_api_keys_account_id ON api_keys (account_id) WHERE account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- GitHub OAuth accounts for the MCP/API (metagraphed#7151) -- second
-- user-account system in this codebase, parallel to rpc_accounts above
-- (wallet-signature login) rather than merged into it: the identity proof is
-- structurally different (GitHub's own OAuth authorization-code exchange vs.
-- an sr25519 wallet signature), and a single human could plausibly want
-- both, so this stays its own row/table rather than overloading ss58.
-- github_user_id is GitHub's own stable numeric account id (immutable even
-- across a username/login rename) -- the identity key. github_login is
-- denormalized/cached purely for display and support tickets; it is NOT
-- authoritative and must be refreshed from GitHub on login, never used to
-- look up the account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_accounts (
  id             BIGSERIAL PRIMARY KEY,
  github_user_id BIGINT NOT NULL UNIQUE,
  github_login   TEXT NOT NULL,
  tier           TEXT NOT NULL DEFAULT 'free',
  created_at     BIGINT NOT NULL,
  last_login_at  BIGINT
);
-- Already covered by the UNIQUE constraint's implicit index; explicit only
-- for readability/documentation (matches idx_rpc_accounts_ss58's convention).
CREATE INDEX IF NOT EXISTS idx_github_accounts_github_user_id ON github_accounts (github_user_id);

-- Freemium API on Unkey (2026-07-19): Unkey is now the actual key store --
-- it mints/hashes/verifies/revokes every key; this table keeps only a thin
-- (account_id, unkey_key_id) mapping for listing/ownership checks.
-- unkey_key_id (Unkey's own opaque key_xxx id, public/non-secret -- safe to
-- log, safe in a support ticket, exactly like the old `prefix` column) is
-- nullable, and prefix/secret_hash are relaxed to nullable rather than
-- dropped: any row minted under the pre-Unkey custom system keeps its
-- historical prefix/secret_hash for audit purposes, it just stops being
-- validated against (src/api-key-validation.ts no longer reads either
-- column). New rows populate unkey_key_id only.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS unkey_key_id TEXT;
ALTER TABLE api_keys ALTER COLUMN prefix DROP NOT NULL;
ALTER TABLE api_keys ALTER COLUMN secret_hash DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_unkey_key_id
  ON api_keys (unkey_key_id) WHERE unkey_key_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Self-serve API key usage dashboard (#8386) -- a minimal daily counter, not
-- an analytics system: src/usage-telemetry.ts is write-only to PostHog with
-- no query path back, so "last 7d by day + top endpoints" for one account's
-- key needs somewhere this codebase can actually read from. One row per
-- (account, day, route); incremented via UPSERT on every tiered-rate-limited
-- request an authenticated key made (workers/tiered-rate-limit.ts's
-- accountId, recorded fire-and-forget via workers/api.ts's
-- recordApiKeyUsage -- never on the request's hot path).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_key_usage_daily (
  account_id     BIGINT NOT NULL REFERENCES rpc_accounts (id),
  day            DATE NOT NULL,
  route          TEXT NOT NULL,
  request_count  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, route)
);
-- The dashboard's own query: one account's last 7 days, newest first.
-- Already covered by the primary key's implicit index; explicit only for
-- readability/documentation (matches this file's own convention).
CREATE INDEX IF NOT EXISTS idx_api_key_usage_daily_account_day
  ON api_key_usage_daily (account_id, day DESC);

-- #8609: rejections, counted alongside successes on the SAME row rather than in
-- a second table. A tenant asking "am I hitting my limit" needs both numbers
-- side by side, and a 429 is bounded by definition (it IS the rate limit), so
-- this cannot outgrow the successes column it sits next to.
--
-- Deliberately NOT folded into request_count: a rejected request was never
-- served, so counting it as usage would overstate what the tenant consumed and
-- make the dashboard disagree with the enforcement layer's own counters --
-- which is precisely what this issue's acceptance bar forbids.
ALTER TABLE api_key_usage_daily
  ADD COLUMN IF NOT EXISTS rejected_count BIGINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Key-level blocklist (#8611). Distinct from api_keys.revoked_at, which is the
-- OWNER's own "I am done with this key" action and is permanent per key.
--
-- A block is ours, it is account-level (blocking one key of an abusive account
-- just invites minting another), it carries a reason code, and it is
-- REVERSIBLE -- because the false-positive path is a first-class requirement,
-- not an afterthought. That is why this is an append-only ledger rather than a
-- boolean column: unblocking sets unblocked_at and keeps the row, so "this
-- account was blocked in error on the 3rd and unblocked on the 4th with this
-- note" stays answerable. A column would erase exactly the history you need
-- when a customer asks what happened.
--
-- Nothing writes here automatically. Anomaly signals (src/api-key-abuse.ts)
-- rank an internal review queue; a human decides. An automated block on a
-- heuristic like "used many route families" would eventually cut off a
-- legitimate integration doing precisely what the API is for.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_key_blocks (
  id              BIGSERIAL PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  -- Closed set, mirrored in src/api-key-abuse.ts's BLOCK_REASON_CODES. Not a
  -- CHECK constraint: adding a code should not need a schema migration, and
  -- the writing route validates against the same closed set.
  reason_code     TEXT NOT NULL,
  -- Internal, maintainer-facing. May name a person or a ticket, so it is
  -- NEVER surfaced to the blocked caller -- see evaluateBlock.
  note            TEXT,
  blocked_at      BIGINT NOT NULL,
  blocked_by      TEXT,
  unblocked_at    BIGINT,
  unblocked_note  TEXT
);
-- The snapshot query: currently-active blocks only. Partial, because the
-- ledger grows forever while the active set stays small.
CREATE INDEX IF NOT EXISTS idx_api_key_blocks_active
  ON api_key_blocks (account_id) WHERE unblocked_at IS NULL;
-- One account cannot hold two simultaneous active blocks: a second block would
-- make "unblock this account" ambiguous and leave it still blocked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_blocks_one_active_per_account
  ON api_key_blocks (account_id) WHERE unblocked_at IS NULL;

-- ---------------------------------------------------------------------------
-- All-traffic usage + cost rollup (#8597) -- the measurement ADR 0022's
-- pricing decision is waiting on.
--
-- Distinct from api_key_usage_daily above, which it does NOT replace. That
-- table is per-ACCOUNT and only ever sees requests that presented an API key;
-- it powers the tenant dashboard. Keyless traffic is the overwhelming
-- majority of this API's volume by design ("keyless stays the generous
-- default") and is precisely the subject of "does the free tier cost too
-- much" -- so a keyed-only counter cannot answer the question at all. This
-- table counts EVERYTHING, with no account dimension.
--
-- ROUTE FAMILY IS THE ROUTE TEMPLATE, e.g. '/api/v1/subnets/{netuid}/events'.
-- Bucketing by raw pathname would be a cardinality bomb (~130 live netuids,
-- unbounded ss58 addresses); the template set is bounded by the size of
-- API_ROUTES (~178) by construction. See src/usage-rollup.ts for why that
-- beats a hand-maintained family map.
--
-- COST SHAPE is which bill the request lands on (ADR 0022's central claim):
-- 'edge' (Cloudflare-metered, near-zero marginal), 'postgres' (the indexer
-- box's FIXED capacity -- marginal cost is pool contention, not a per-request
-- charge), 'r2-bulk' (storage + egress), 'ai' (real per-call cost). This is
-- deliberately a different axis from the quota's cost WEIGHT: the weight says
-- what to charge a caller, the shape says which of our costs it consumes. A
-- rollup with counts but no shape cannot confirm or falsify the memo.
--
-- `day` is in the PK because a TimescaleDB hypertable partitioned on it
-- requires the partition column in every unique constraint (same rule the
-- blocks table documents above). No retention policy is set here on purpose:
-- this is a small, bounded aggregate (~178 families x 4 shapes x 1 row/day)
-- whose entire value is the long baseline a pricing decision needs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_usage_rollup (
  day            DATE NOT NULL,
  route_family   TEXT NOT NULL,
  cost_shape     TEXT NOT NULL,
  request_count  BIGINT NOT NULL DEFAULT 0,
  -- Of request_count, how many presented a valid API key. Keyed vs keyless is
  -- the split the pricing question turns on, so it is a column rather than a
  -- separate table or a second row per bucket.
  keyed_count    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route_family, cost_shape)
);
-- The readout query: one day's or one window's families ordered by volume.
CREATE INDEX IF NOT EXISTS idx_api_usage_rollup_day
  ON api_usage_rollup (day DESC, request_count DESC);
-- The "which cost shape dominates" query -- the one ADR 0022 actually needs.
CREATE INDEX IF NOT EXISTS idx_api_usage_rollup_shape
  ON api_usage_rollup (cost_shape, day DESC);

-- ---------------------------------------------------------------------------
-- Per-account daily quota counter (#8608), in COST units rather than requests
-- (src/route-cost-weights.ts, following ADR 0022's four cost shapes -- a
-- cached artifact read spends 1, an LLM-backed call 25).
--
-- Separate from api_key_usage_daily above even though both are per-account-
-- per-day, because they answer different questions and have different
-- correctness requirements. That table is per-ROUTE, incremented
-- fire-and-forget for a dashboard: a lost increment costs a slightly wrong
-- chart. This one is the authoritative ledger the quota gate reads and writes
-- SYNCHRONOUSLY, so it must be exactly one row per account-day and every
-- increment must be atomic. Summing the per-route table instead would make
-- the hot path scan an unbounded number of rows and inherit that table's
-- deliberate lossiness.
--
-- Why Postgres on our own indexer box rather than a Durable Object or Redis:
-- the tiered-rate-limit gate already calls this database on every keyed
-- request (workers/api.ts's recordApiKeyUsage, over the DATA_API service
-- binding through Hyperdrive), so the connection, the auth and the network
-- path all exist and are exercised in production today. A DO would put the
-- counter on Cloudflare-owned state; Redis would need a new HTTP shim and the
-- first-ever public HTTP ingress on the indexer box, whose cloudflared
-- config is deliberately not Ansible-managed. Neither buys anything a
-- primary-key upsert does not already give at this volume.
--
-- No FK to rpc_accounts: this is written on the request hot path, and a
-- referential check on every spend is latency spent to protect against an
-- account id that only ever arrives from our own validated key lookup. Rows
-- are pruned by day (see the retention sweep), not by cascade.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_quota_daily (
  account_id   BIGINT NOT NULL,
  day          DATE NOT NULL,
  units_spent  BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);

-- metagraphed's OWN uptime (metagraphed#8317). Every other health table here
-- is about someone else -- surface_checks probes subnet APIs -- so /status
-- could only ever answer "are the things we watch up", never "are WE up".
--
-- Probed from this box rather than from a Worker on purpose: a Worker
-- checking Cloudflare-hosted routes shares a failure domain with what it's
-- checking and would report green through exactly the outage a reader cares
-- about. Written by the poller's self-health job, one row per component per
-- tick (~60s).
--
-- Components: api (the Worker + its KV read path), site (the UI Worker), and
-- publish -- derived from the api response's own meta.generated_at, because
-- the data pipeline can go stale while every HTTP surface still answers 200.
--
-- (component, checked_at_ms) rather than a bare timestamp PK: TimescaleDB
-- requires the partitioning column in every unique constraint, and three
-- components share a tick's millisecond.
CREATE TABLE IF NOT EXISTS self_health_checks (
  checked_at_ms BIGINT  NOT NULL,
  component     TEXT    NOT NULL,
  ok            BOOLEAN NOT NULL,
  http_status   INTEGER,
  latency_ms    INTEGER,
  PRIMARY KEY (component, checked_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_self_health_checks_time
  ON self_health_checks (checked_at_ms);

-- The 90-day serving rollup. Accumulated incrementally as each tick lands
-- (same convention as account_events_daily) rather than recomputed from raw
-- rows, because self_health_checks is pruned by a ~14-day retention policy --
-- the raw ticks only matter for recent debugging, but the daily uptime ratio
-- has to survive far longer than they do. NEVER expire this table.
CREATE TABLE IF NOT EXISTS self_health_daily (
  day       DATE    NOT NULL,
  component TEXT    NOT NULL,
  checks    INTEGER NOT NULL,
  ok_count  INTEGER NOT NULL,
  PRIMARY KEY (day, component)
);

-- ---------------------------------------------------------------------------
-- First-party TAO/USD index (#8600, ADR 0025)
-- ---------------------------------------------------------------------------

-- First-party TAO/USD index, with the pool readings that produced it (#8600).
--
-- ADR 0025's basis: a liquidity-weighted median across qualifying wTAO/WETH
-- Uniswap v3 pools, multiplied by the WETH/USDC anchor leg, read from chain
-- state at a published Ethereum block height.
--
-- WHY THE PER-POOL INPUTS ARE STORED AND NOT JUST THE ANSWER. #8503 requires
-- provenance, and an index nobody can audit after the fact is not defensible.
-- `pools` holds every pool the tick looked at -- the ones that contributed with
-- their price and TVL, and the ones that did not with the reason -- so any
-- published figure can be recomputed from its own row and checked against a
-- fresh archive read at the same height.
--
-- IDEMPOTENT BY CONSTRUCTION, NOT BY LUCK. `observed_at` is the ETHEREUM
-- BLOCK'S OWN TIMESTAMP, never the wall clock at ingestion. Re-running a tick
-- for the same height therefore produces a row identical in both PK columns,
-- so ON CONFLICT DO NOTHING is a true no-op. Had observed_at been "now", every
-- re-run would have inserted a near-duplicate the constraint could not see --
-- requirement 4(d) failing silently, which is the worst way for it to fail.
CREATE TABLE IF NOT EXISTS tao_usd_index (
  -- Ethereum mainnet height every call in the observation was pinned to. A
  -- third party can re-execute the same reads against it and get this row
  -- back, which is ADR 0025 decision 5's reproducibility claim.
  block_number  BIGINT  NOT NULL,
  -- The block's timestamp, epoch ms -- matching the BIGINT epoch-ms convention
  -- every other time-series table here uses. Also the partition column, so it
  -- is in the PK per TimescaleDB's rule (see `blocks` in schema.sql).
  observed_at   BIGINT  NOT NULL,
  -- NULL whenever the basis is 'insufficient_pools'. Never a fabricated
  -- number, never a stale carry-forward: the CHECK below makes that
  -- unrepresentable rather than merely conventional.
  usd_per_tao   NUMERIC,
  -- ADR 0025 decision 7's honesty vocabulary, extending price_basis in
  -- src/price-at-tx.ts. 'wrapped_onchain_median' names the wrapping: these
  -- pools price wTAO, and a bridge incident would have them confidently
  -- pricing a different asset.
  price_basis   TEXT    NOT NULL,
  -- The anchor leg, stored because the index is a PRODUCT of two readings and
  -- a reader who cannot see both cannot verify either.
  eth_usd       NUMERIC,
  -- Pools that actually contributed, after TVL floor and outlier rejection.
  pool_count    INTEGER NOT NULL,
  -- Every pool the tick read: contributors with price + TVL, rejects with a
  -- reason. NUMERIC-typed values are written as JSON numbers here, which is
  -- lossier than the NUMERIC columns above -- deliberately, because this is
  -- the audit trail for a float-valued price, not a balance.
  pools         JSONB   NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (block_number, observed_at),
  CONSTRAINT tao_usd_index_basis_check
    CHECK (price_basis IN ('wrapped_onchain_median', 'insufficient_pools')),
  -- The ADR states "null iff basis is insufficient_pools". Enforced rather
  -- than documented: a bug that publishes a price under an insufficient-pools
  -- label is exactly the failure this whole design exists to prevent, and it
  -- would otherwise be invisible until someone read the numbers.
  CONSTRAINT tao_usd_index_value_matches_basis_check
    CHECK (
      (price_basis = 'insufficient_pools' AND usd_per_tao IS NULL)
      OR (price_basis <> 'insufficient_pools' AND usd_per_tao IS NOT NULL)
    ),
  CONSTRAINT tao_usd_index_pool_count_check CHECK (pool_count >= 0)
);

-- The serving query is "latest value" and "the last N minutes", both of which
-- lead with observed_at.
CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed
  ON tao_usd_index (observed_at DESC);

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
