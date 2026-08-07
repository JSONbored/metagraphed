-- The append-only history tables (#9787).
--
-- Seven tables, 45,854 rows. They belong together because they share the
-- property that decides how the reconciler treats them: with one named
-- exception a row, once written, is never rewritten. That is what #9886's
-- `freshness: null` exists for -- the pair (COUNT, MAX(freshness)) degrades to
-- COUNT alone, and for these tables that is not a weakening, because there is
-- no in-place drift for a timestamp to reveal.
--
-- THE EXCEPTION IS chain_concentration_daily, and it is keyed `day`: today's
-- row is recomputed as the day fills in. It carries `computed_at` and must be
-- compared on it. Grouping it here with a note is better than filing it
-- elsewhere -- the whole point of the file is which tables are append-only,
-- and the one that is not has to be visible in the same place.
--
-- ## The AUTOINCREMENT question, and why Neon assigns its own ids
--
-- Four of these declare `id INTEGER PRIMARY KEY AUTOINCREMENT`:
-- account_identity_history, subnet_hyperparams_history,
-- emission_gate_param_history, subnet_emission_enabled_history.
--
-- A mirror cannot preserve such an id. The D1 writer inserts without one and
-- D1 assigns it; the mirror would have to read it back to copy it. So the
-- question is whether a divergent id COSTS anything, and the answer is no,
-- because the id is a tiebreaker that can never tie. Measured against
-- production 2026-08-07:
--
--     account_identity_history         531 rows, 531 distinct (account, observed_at)
--     subnet_hyperparams_history       137 rows, 137 distinct (netuid, observed_at)
--     emission_gate_param_history      123 rows, 123 distinct (param, observed_at)
--     subnet_emission_enabled_history   77 rows,  77 distinct (netuid, observed_at)
--
-- Every natural key is already unique, and D1's own indexes read
-- `(account, observed_at DESC, id DESC)` -- the id is the last tiebreaker in
-- an ordering whose earlier terms are unique, so it is never reached.
--
-- Therefore: `id` is GENERATED ALWAYS here, not copied. The UNIQUE constraint
-- on the natural key is what the mirror and the backfill conflict on, and it
-- is the real identity of the row in both stores.
--
-- GENERATED ALWAYS rather than BY DEFAULT is deliberate. BY DEFAULT would let
-- a caller insert an explicit id without advancing the sequence, and a later
-- generated id would then collide -- a failure that appears long after the
-- insert that caused it. ALWAYS makes copying an id an error at the point of
-- the mistake, verified: an explicit id is refused with
-- `cannot insert a non-DEFAULT value into column "id"`.
--
-- One consequence worth stating, because it looks like a bug the first time
-- somebody sees it: an upsert that CONFLICTS still consumes a sequence value,
-- so Neon's ids have gaps (a three-statement exercise produced ids 1 and 3).
-- That is ordinary Postgres identity behaviour and harmless here for the same
-- reason the ids may diverge at all -- nothing orders on the id alone.
--
-- TYPE MAPPING, unchanged from 0001/0002:
--
--   INTEGER CHECK (x IN (0,1))   -> BOOLEAN
--   INTEGER (epoch milliseconds) -> BIGINT
--   INTEGER (counts, netuid)     -> INTEGER
--   REAL                         -> DOUBLE PRECISION
--   TEXT                         -> TEXT
--
-- The CHECK constraints carry over verbatim; Postgres accepts the same
-- `IN (...)` predicates SQLite does, and they are the schema's own statement
-- about what the producer may emit.

-- ---------------------------------------------------------------------------
-- subnet_burn_history -- 36,894 rows, the largest of the seven
-- ---------------------------------------------------------------------------
--
-- Natural PRIMARY KEY already, so nothing to synthesise. burn_tao is NOT NULL
-- deliberately -- D1's own comment records that netuid 76 reads a TRUE zero and
-- is the cheapest registration on the network, so a missing read must be an
-- absent ROW rather than a zero one. Preserved exactly.
CREATE TABLE IF NOT EXISTS subnet_burn_history (
  netuid      INTEGER          NOT NULL,
  observed_at BIGINT           NOT NULL,
  burn_tao    DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (netuid, observed_at)
);

-- (netuid, observed_at DESC) is not recreated: the primary key indexes the
-- same columns and Postgres scans an index backwards at the same cost.
CREATE INDEX IF NOT EXISTS idx_subnet_burn_history_observed
  ON subnet_burn_history (observed_at);

-- ---------------------------------------------------------------------------
-- tao_usd_index -- 7,965 rows
-- ---------------------------------------------------------------------------
--
-- Both CHECKs carry over, including the table-level one coupling price_basis
-- to usd_per_tao. That constraint is the schema saying "insufficient_pools
-- means we have NO price", which is exactly the distinction a NULL would
-- otherwise lose against a 0.
CREATE TABLE IF NOT EXISTS tao_usd_index (
  block_number BIGINT           NOT NULL,
  observed_at  BIGINT           NOT NULL,
  usd_per_tao  DOUBLE PRECISION,
  price_basis  TEXT             NOT NULL
    CHECK (price_basis IN ('wrapped_onchain_median', 'insufficient_pools')),
  eth_usd      DOUBLE PRECISION,
  pool_count   INTEGER          NOT NULL CHECK (pool_count >= 0),
  pools        TEXT             NOT NULL DEFAULT '[]',
  PRIMARY KEY (block_number, observed_at),
  CHECK (
    (price_basis = 'insufficient_pools' AND usd_per_tao IS NULL)
    OR (price_basis <> 'insufficient_pools' AND usd_per_tao IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed
  ON tao_usd_index (observed_at DESC);

-- ---------------------------------------------------------------------------
-- account_identity_history -- 531 rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_identity_history (
  id            BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account       TEXT    NOT NULL,
  observed_at   BIGINT  NOT NULL,
  name          TEXT,
  url           TEXT,
  github        TEXT,
  image         TEXT,
  discord       TEXT,
  description   TEXT,
  additional    TEXT,
  identity_hash TEXT    NOT NULL,
  UNIQUE (account, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_observed
  ON account_identity_history (account, observed_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- subnet_hyperparams_history -- 137 rows
-- ---------------------------------------------------------------------------
--
-- Nine BOOLEAN columns, the same nine `subnet_hyperparams` carries in 0001.
-- Postgres rejects `boolean = 1`, which is what emptied /validators in #9802,
-- so the portability gate's deny-list covers these names repo-wide.
CREATE TABLE IF NOT EXISTS subnet_hyperparams_history (
  id                          BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  netuid                      INTEGER NOT NULL,
  block_number                BIGINT,
  observed_at                 BIGINT  NOT NULL,
  kappa_ratio                 DOUBLE PRECISION,
  immunity_period             INTEGER,
  min_allowed_weights         INTEGER,
  max_weight_limit_ratio      DOUBLE PRECISION,
  tempo                       INTEGER,
  weights_version             INTEGER,
  weights_rate_limit          DOUBLE PRECISION,
  activity_cutoff             INTEGER,
  activity_cutoff_factor      INTEGER,
  registration_allowed        BOOLEAN,
  target_regs_per_interval    INTEGER,
  min_burn_tao                DOUBLE PRECISION,
  max_burn_tao                DOUBLE PRECISION,
  burn_half_life              INTEGER,
  burn_increase_mult          DOUBLE PRECISION,
  bonds_moving_avg_raw        BIGINT,
  max_regs_per_block          INTEGER,
  serving_rate_limit          INTEGER,
  max_validators              INTEGER,
  commit_reveal_period        INTEGER,
  commit_reveal_enabled       BOOLEAN,
  alpha_high_ratio            DOUBLE PRECISION,
  alpha_low_ratio             DOUBLE PRECISION,
  liquid_alpha_enabled        BOOLEAN,
  alpha_sigmoid_steepness     DOUBLE PRECISION,
  yuma_version                INTEGER,
  subnet_is_active            BOOLEAN,
  transfers_enabled           BOOLEAN,
  bonds_reset_enabled         BOOLEAN,
  user_liquidity_enabled      BOOLEAN,
  owner_cut_enabled           BOOLEAN,
  owner_cut_auto_lock_enabled BOOLEAN,
  min_childkey_take_ratio     DOUBLE PRECISION,
  hyperparams_hash            TEXT    NOT NULL,
  UNIQUE (netuid, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_observed
  ON subnet_hyperparams_history (netuid, observed_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- emission_gate_param_history -- 123 rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emission_gate_param_history (
  id               BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  param            TEXT    NOT NULL,
  value            DOUBLE PRECISION,
  previous_value   DOUBLE PRECISION,
  source           TEXT    NOT NULL
    CHECK (source IN ('governance', 'runtime_recomputed')),
  block_number     BIGINT,
  observed_at      BIGINT  NOT NULL,
  predates_capture BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (param, observed_at)
);

CREATE INDEX IF NOT EXISTS emission_gate_param_history_param_observed_idx
  ON emission_gate_param_history (param, observed_at DESC);

-- ---------------------------------------------------------------------------
-- subnet_emission_enabled_history -- 77 rows
-- ---------------------------------------------------------------------------
--
-- previous_enabled stays NULLABLE: the first observation of a subnet has no
-- previous value, and a NULL there is "we had not seen it before", which is a
-- different claim from `false`.
CREATE TABLE IF NOT EXISTS subnet_emission_enabled_history (
  id               BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  netuid           INTEGER NOT NULL,
  enabled          BOOLEAN NOT NULL,
  previous_enabled BOOLEAN,
  block_number     BIGINT,
  observed_at      BIGINT  NOT NULL,
  predates_capture BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (netuid, observed_at)
);

CREATE INDEX IF NOT EXISTS subnet_emission_enabled_history_netuid_observed_idx
  ON subnet_emission_enabled_history (netuid, observed_at DESC);

-- ---------------------------------------------------------------------------
-- chain_concentration_daily -- 27 rows, and the ONE table here that is
-- rewritten in place
-- ---------------------------------------------------------------------------
--
-- Keyed on `day`, and today's row is recomputed as the day fills in. So unlike
-- its six neighbours this one CANNOT compare on COUNT alone -- two stores can
-- hold 27 rows each and disagree about today's card indefinitely. Its plan
-- carries `freshness: "computed_at"`.
--
-- `card` stays TEXT rather than becoming JSONB. It is stored, served and
-- compared as an opaque payload; JSONB would reformat it on the way in (key
-- order, whitespace, numeric spelling) and the two stores would then differ
-- byte-for-byte on rows that are semantically identical.
CREATE TABLE IF NOT EXISTS chain_concentration_daily (
  day                TEXT    NOT NULL PRIMARY KEY,
  neuron_count       INTEGER NOT NULL,
  card               TEXT    NOT NULL,
  source_captured_at BIGINT,
  computed_at        BIGINT  NOT NULL,
  builder_version    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chain_concentration_daily_day
  ON chain_concentration_daily (day DESC);
