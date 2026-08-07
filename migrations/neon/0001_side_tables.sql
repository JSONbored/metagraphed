-- The three tables four routes read but Neon does not have (#9814).
--
-- WHY THESE THREE. The dispatcher picks ONE runner for a whole handler, so a
-- route sent to Neon sends every query there -- side loaders included. Four
-- routes read one of these through a loader and are therefore pinned to D1
-- until it exists here: /validators, /validators/{hotkey}, /accounts,
-- /accounts/{ss58}/subnets, /accounts/{ss58}/portfolio and
-- /subnets/{n}/concentration/history. Two of them served an empty 200 for
-- exactly this reason (#9825).
--
-- TYPE MAPPING, matching what the existing Neon tables already use (verified
-- against information_schema 2026-08-07, not assumed):
--
--   INTEGER CHECK (x IN (0,1))  -> BOOLEAN   the mirror writes real JS
--                                            booleans; Postgres rejects
--                                            `boolean = integer`, which is
--                                            what emptied /validators (#9802)
--   INTEGER (epoch milliseconds) -> BIGINT   captured_at does not fit in int4
--   INTEGER (block/counts)       -> INTEGER
--   REAL                         -> DOUBLE PRECISION
--   TEXT                         -> TEXT
--
-- snapshot_date stays TEXT, deliberately: it is TEXT 'YYYY-MM-DD' in D1, the
-- reconciler compares the two stores on it, and lexicographic order IS date
-- order for ISO dates in both. Making it DATE here would mean the same value
-- round-trips differently on each side.
--
-- PRIMARY KEYs match D1's exactly, because NEON_BACKFILL_PLANS names them in
-- its ON CONFLICT and an ON CONFLICT with no unique index behind it is a
-- runtime error, not a slower query.

CREATE TABLE IF NOT EXISTS subnet_snapshots (
  netuid                INTEGER NOT NULL,
  snapshot_date         TEXT    NOT NULL,
  completeness_score    INTEGER,
  surface_count         INTEGER,
  endpoint_count        INTEGER,
  monitored_count       INTEGER,
  candidate_count       INTEGER,
  captured_at           BIGINT,
  validator_count       INTEGER,
  miner_count           INTEGER,
  total_stake_tao       DOUBLE PRECISION,
  alpha_price_tao       DOUBLE PRECISION,
  emission_share        DOUBLE PRECISION,
  tao_in_pool_tao       DOUBLE PRECISION,
  alpha_in_pool         DOUBLE PRECISION,
  alpha_out_pool        DOUBLE PRECISION,
  subnet_volume_tao     DOUBLE PRECISION,
  tao_in_emission_tao   DOUBLE PRECISION,
  excess_tao            DOUBLE PRECISION,
  alpha_in_emission     DOUBLE PRECISION,
  alpha_out_emission    DOUBLE PRECISION,
  miner_burned_fraction DOUBLE PRECISION,
  emission_enabled      BOOLEAN,
  subtoken_enabled      BOOLEAN,
  first_emission_block  INTEGER,
  pipeline_block        INTEGER,
  pipeline_block_hash   TEXT,
  PRIMARY KEY (netuid, snapshot_date)
);

-- The reconciler pages a date at a time, keyed on netuid within it, and the
-- alpha-price loaders read the newest row per netuid. Both want date first.
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_date_netuid
  ON subnet_snapshots (snapshot_date, netuid);

CREATE TABLE IF NOT EXISTS subnet_hyperparams (
  netuid                      INTEGER NOT NULL,
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
  block_number                INTEGER,
  captured_at                 BIGINT NOT NULL,
  PRIMARY KEY (netuid)
);

-- bonds_moving_avg_raw is BIGINT, not INTEGER: it is a raw u64-derived value
-- from the chain and has been observed above 2^31.

CREATE TABLE IF NOT EXISTS account_identity (
  account     TEXT   NOT NULL,
  name        TEXT,
  url         TEXT,
  github      TEXT,
  image       TEXT,
  discord     TEXT,
  description TEXT,
  additional  TEXT,
  captured_at BIGINT NOT NULL,
  PRIMARY KEY (account)
);
