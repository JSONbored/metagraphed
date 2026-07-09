-- Historical hyperparameter change tracking (#4309, epic #4301): append-only
-- timeline of subnet_hyperparams changes, detected when the daily-or-weekly
-- refresh-subnet-hyperparams cron diffs the freshly-staged snapshot against
-- the last recorded hash per netuid. Mirrors subnet_identity_history
-- (migrations/0031_subnet_identity_history.sql) exactly, just keyed by
-- hyperparameters instead of on-chain identity fields. Live-forward only —
-- a full historical backfill needs archive-node state_call at past block
-- heights (#2111, mid-sync as of 2026-07-07), so this table only ever has
-- rows from the point this migration shipped forward.
CREATE TABLE IF NOT EXISTS subnet_hyperparams_history (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  netuid                        INTEGER NOT NULL,
  block_number                  INTEGER,
  observed_at                   INTEGER NOT NULL,
  kappa_ratio                   REAL,
  immunity_period                INTEGER,
  min_allowed_weights            INTEGER,
  max_weight_limit_ratio         REAL,
  tempo                         INTEGER,
  weights_version                INTEGER,
  weights_rate_limit             INTEGER,
  activity_cutoff                INTEGER,
  activity_cutoff_factor         INTEGER,
  registration_allowed           INTEGER,    -- 0/1
  target_regs_per_interval       INTEGER,
  min_burn_tao                  REAL,
  max_burn_tao                  REAL,
  burn_half_life                 INTEGER,
  burn_increase_mult             REAL,
  bonds_moving_avg_raw            INTEGER,    -- raw on-chain integer, not a ratio
  max_regs_per_block             INTEGER,
  serving_rate_limit             INTEGER,
  max_validators                 INTEGER,
  commit_reveal_period           INTEGER,
  commit_reveal_enabled          INTEGER,    -- 0/1
  alpha_high_ratio               REAL,
  alpha_low_ratio                REAL,
  liquid_alpha_enabled           INTEGER,    -- 0/1
  alpha_sigmoid_steepness        REAL,
  yuma_version                   INTEGER,
  subnet_is_active               INTEGER,    -- 0/1
  transfers_enabled              INTEGER,    -- 0/1
  bonds_reset_enabled            INTEGER,    -- 0/1
  user_liquidity_enabled         INTEGER,    -- 0/1
  owner_cut_enabled              INTEGER,    -- 0/1
  owner_cut_auto_lock_enabled    INTEGER,    -- 0/1
  min_childkey_take_ratio        REAL,
  hyperparams_hash               TEXT NOT NULL
);

-- Newest-first paginated reads for one subnet.
CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_observed
  ON subnet_hyperparams_history (netuid, observed_at DESC, id DESC);

-- Latest-hash lookup per netuid during the refresh diff.
CREATE INDEX IF NOT EXISTS idx_subnet_hyperparams_history_netuid_id
  ON subnet_hyperparams_history (netuid, id DESC);
