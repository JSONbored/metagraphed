-- The subnet-hyperparams + account-identity families on D1 (box decommission,
-- the #9146/#9157 pattern applied to the two remaining live sync lanes).
--
-- Both families are LIVE-refreshed: the poller POSTs
-- /api/v1/internal/subnet-hyperparams-sync hourly and
-- /api/v1/internal/account-identity-sync daily. Their only store was the
-- box's Postgres, so once the box is wiped every tick fails and the data
-- freezes at the lakehouse cold-tier snapshot. These tables are where those
-- two syncs land instead; the reads follow behind the same flags
-- (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE / METAGRAPH_ACCOUNT_IDENTITY_SOURCE).
--
-- Column sets are NOT transcribed by hand from deploy/postgres/schema.sql:
-- they are exactly the lists the writer binds --
-- SUBNET_HYPERPARAMS_INSERT_COLUMNS (src/subnet-hyperparams.ts),
-- ACCOUNT_IDENTITY_INSERT_COLUMNS (src/account-identity.ts), and the history
-- column lists in src/hyperparams-identity-d1-write.ts.
-- tests/hyperparams-identity-d1-write.test.ts asserts that correspondence in
-- both directions, same anti-drift guarantee as 0007's
-- tests/neurons-d1-schema.test.ts.
--
-- Type translation follows 0007_neurons.sql's conventions:
--   netuid / *_period / tempo / counts   -> INTEGER
--   boolean-flag columns                  -> INTEGER 0/1 with CHECK
--   NUMERIC ratios / TAO values           -> REAL. This includes
--     weights_rate_limit: root (netuid 0) carries the chain's u64::MAX
--     "unlimited" sentinel, which overflows SQLite's signed-64 INTEGER the
--     same way it overflowed Postgres BIGINT (#4843 widened it to NUMERIC);
--     the value arrives as a JS number, so REAL is the honest declaration.
--   captured_at / observed_at             -> INTEGER epoch-ms
--   identity fields                       -> TEXT
--   bigserial history ids                 -> INTEGER PRIMARY KEY AUTOINCREMENT
--     (0004/0005's convention; the (observed_at, id) keyset cursor relies on
--     ids never being reused, which AUTOINCREMENT guarantees)

-- Latest-only, upserted on (netuid) with the captured_at staleness guard and
-- pruned to the batch's netuids every sync (every successful upstream fetch
-- covers ALL active subnets, so a netuid absent from a batch is deregistered
-- -- see handleSubnetHyperparamsSync's own header). Bounded at ~129 rows.
CREATE TABLE IF NOT EXISTS subnet_hyperparams (
  netuid                      INTEGER NOT NULL,
  kappa_ratio                 REAL,
  immunity_period             INTEGER,
  min_allowed_weights         INTEGER,
  max_weight_limit_ratio      REAL,
  tempo                       INTEGER,
  weights_version             INTEGER,
  weights_rate_limit          REAL,
  activity_cutoff             INTEGER,
  activity_cutoff_factor      INTEGER,
  registration_allowed        INTEGER CHECK (registration_allowed IN (0, 1)),
  target_regs_per_interval    INTEGER,
  min_burn_tao                REAL,
  max_burn_tao                REAL,
  burn_half_life              INTEGER,
  burn_increase_mult          REAL,
  bonds_moving_avg_raw        INTEGER,
  max_regs_per_block          INTEGER,
  serving_rate_limit          INTEGER,
  max_validators              INTEGER,
  commit_reveal_period        INTEGER,
  commit_reveal_enabled       INTEGER CHECK (commit_reveal_enabled IN (0, 1)),
  alpha_high_ratio            REAL,
  alpha_low_ratio             REAL,
  liquid_alpha_enabled        INTEGER CHECK (liquid_alpha_enabled IN (0, 1)),
  alpha_sigmoid_steepness     REAL,
  yuma_version                INTEGER,
  subnet_is_active            INTEGER CHECK (subnet_is_active IN (0, 1)),
  transfers_enabled           INTEGER CHECK (transfers_enabled IN (0, 1)),
  bonds_reset_enabled         INTEGER CHECK (bonds_reset_enabled IN (0, 1)),
  user_liquidity_enabled      INTEGER CHECK (user_liquidity_enabled IN (0, 1)),
  owner_cut_enabled           INTEGER CHECK (owner_cut_enabled IN (0, 1)),
  owner_cut_auto_lock_enabled INTEGER CHECK (owner_cut_auto_lock_enabled IN (0, 1)),
  min_childkey_take_ratio     REAL,
  block_number                INTEGER,
  captured_at                 INTEGER NOT NULL,
  PRIMARY KEY (netuid)
);

-- Append-only change log, diffed by hyperparams_hash on each sync: a row
-- exists only where a value actually moved (mirrors Postgres'
-- subnet_hyperparams_history, whose only key is its BIGSERIAL id -- the
-- writer never upserts here, so there is no conflict target). The 33
-- hyperparameter fields are stored as formatSubnetHyperparams shapes them
-- (real booleans, bound as 0/1 by D1's documented boolean mapping), the same
-- values the hash is computed over.
--
-- FORWARD-ONLY from the D1 cutover: pre-wipe history lives in the lakehouse
-- cold tier (src/subnet-hyperparams-cold-tier.ts), which stays the read
-- fallback while this table is empty. Ids restart at 1 here; the keyset
-- cursor is (observed_at, id), so pages never interleave across the seam.
CREATE TABLE IF NOT EXISTS subnet_hyperparams_history (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  netuid                      INTEGER NOT NULL,
  block_number                INTEGER,
  observed_at                 INTEGER NOT NULL,
  kappa_ratio                 REAL,
  immunity_period             INTEGER,
  min_allowed_weights         INTEGER,
  max_weight_limit_ratio      REAL,
  tempo                       INTEGER,
  weights_version             INTEGER,
  weights_rate_limit          REAL,
  activity_cutoff             INTEGER,
  activity_cutoff_factor      INTEGER,
  registration_allowed        INTEGER CHECK (registration_allowed IN (0, 1)),
  target_regs_per_interval    INTEGER,
  min_burn_tao                REAL,
  max_burn_tao                REAL,
  burn_half_life              INTEGER,
  burn_increase_mult          REAL,
  bonds_moving_avg_raw        INTEGER,
  max_regs_per_block          INTEGER,
  serving_rate_limit          INTEGER,
  max_validators              INTEGER,
  commit_reveal_period        INTEGER,
  commit_reveal_enabled       INTEGER CHECK (commit_reveal_enabled IN (0, 1)),
  alpha_high_ratio            REAL,
  alpha_low_ratio             REAL,
  liquid_alpha_enabled        INTEGER CHECK (liquid_alpha_enabled IN (0, 1)),
  alpha_sigmoid_steepness     REAL,
  yuma_version                INTEGER,
  subnet_is_active            INTEGER CHECK (subnet_is_active IN (0, 1)),
  transfers_enabled           INTEGER CHECK (transfers_enabled IN (0, 1)),
  bonds_reset_enabled         INTEGER CHECK (bonds_reset_enabled IN (0, 1)),
  user_liquidity_enabled      INTEGER CHECK (user_liquidity_enabled IN (0, 1)),
  owner_cut_enabled           INTEGER CHECK (owner_cut_enabled IN (0, 1)),
  owner_cut_auto_lock_enabled INTEGER CHECK (owner_cut_auto_lock_enabled IN (0, 1)),
  min_childkey_take_ratio     REAL,
  hyperparams_hash            TEXT NOT NULL
);

-- The paginated per-subnet timeline reads (netuid, observed_at DESC, id DESC);
-- the keyset cursor seeks the same tuple. Mirrors Postgres'
-- idx_subnet_hyperparams_history_netuid_observed.
CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_observed
  ON subnet_hyperparams_history (netuid, observed_at DESC, id DESC);
-- The diff-and-append's "latest hash per netuid" group-wise MAX(id) scan.
CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_id
  ON subnet_hyperparams_history (netuid, id DESC);

-- Latest-only, upserted on (account) with the captured_at staleness guard.
-- NO prune, deliberately: an identity is a property of the owning account,
-- not of currently having an active neuron -- an account missing from one
-- snapshot pass hasn't necessarily lost its identity (same reasoning as the
-- Postgres write path). ~460 rows live-observed.
CREATE TABLE IF NOT EXISTS account_identity (
  account     TEXT    NOT NULL,
  name        TEXT,
  url         TEXT,
  github      TEXT,
  image       TEXT,
  discord     TEXT,
  description TEXT,
  additional  TEXT,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (account)
);

-- Append-only change log, diffed by identity_hash on each sync -- same
-- no-conflict-target append contract as subnet_hyperparams_history above,
-- and the same forward-only-from-cutover caveat. No block_number column,
-- matching Postgres (an account carries no chain block height, only
-- captured_at/observed_at).
CREATE TABLE IF NOT EXISTS account_identity_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account       TEXT    NOT NULL,
  observed_at   INTEGER NOT NULL,
  name          TEXT,
  url           TEXT,
  github        TEXT,
  image         TEXT,
  discord       TEXT,
  description   TEXT,
  additional    TEXT,
  identity_hash TEXT NOT NULL
);

-- The paginated per-account timeline + its keyset cursor, mirroring
-- Postgres' idx_account_identity_history_account_observed.
CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_observed
  ON account_identity_history (account, observed_at DESC, id DESC);
-- The diff-and-append's "latest hash per account" group-wise MAX(id) scan.
CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_id
  ON account_identity_history (account, id DESC);
