-- Subnet hyperparameters (#4303, epic #4301): the largest confirmed capture gap
-- found in the 2026-07-08 block-explorer research pass
-- (docs/block-explorer-data-model.md). One row per netuid, refreshed daily-or-
-- weekly by the refresh-subnet-hyperparams workflow (hyperparameters change
-- rarely) — latest-only, REPLACE-on-conflict, so the table stays tiny (~129
-- rows) and never grows unbounded. Powers
-- /api/v1/subnets/{netuid}/hyperparameters (#4307).
--
-- Field mapping + units verified live against finney, 2026-07-08 (research spike
-- #4304; full detail in scripts/fetch-subnet-hyperparams.py's docstring):
--   *_ratio columns          = on-chain U16 (0..65535) / 65535
--   min_burn_tao/max_burn_tao = on-chain rao / 1e9 (exact-split, not float-lossy)
--   burn_increase_mult / alpha_sigmoid_steepness = already float-decoded
--     fixed-point on the SDK side
--   bonds_moving_avg_raw     = RAW on-chain integer, deliberately NOT scaled to
--     a ratio — the spike could not confirm its exact scaling constant against
--     the pallet source
--   *_enabled / *_allowed / subnet_is_active = 0/1 booleans
-- rho/difficulty/min_difficulty/max_difficulty/adjustment_interval/
-- adjustment_alpha are OMITTED — confirmed None (dead PoW-era fields) on every
-- probed netuid; no columns for these.
CREATE TABLE IF NOT EXISTS subnet_hyperparams (
  netuid                       INTEGER NOT NULL,
  kappa_ratio                  REAL,
  immunity_period               INTEGER,
  min_allowed_weights           INTEGER,
  max_weight_limit_ratio        REAL,
  tempo                        INTEGER,
  weights_version               INTEGER,
  weights_rate_limit            INTEGER,
  activity_cutoff               INTEGER,
  activity_cutoff_factor        INTEGER,
  registration_allowed          INTEGER,    -- 0/1
  target_regs_per_interval      INTEGER,
  min_burn_tao                 REAL,
  max_burn_tao                 REAL,
  burn_half_life                INTEGER,
  burn_increase_mult            REAL,
  bonds_moving_avg_raw           INTEGER,    -- raw on-chain integer, not a ratio
  max_regs_per_block            INTEGER,
  serving_rate_limit            INTEGER,
  max_validators                INTEGER,
  commit_reveal_period          INTEGER,
  commit_reveal_enabled         INTEGER,    -- 0/1
  alpha_high_ratio              REAL,
  alpha_low_ratio               REAL,
  liquid_alpha_enabled          INTEGER,    -- 0/1
  alpha_sigmoid_steepness       REAL,
  yuma_version                  INTEGER,
  subnet_is_active              INTEGER,    -- 0/1
  transfers_enabled             INTEGER,    -- 0/1
  bonds_reset_enabled           INTEGER,    -- 0/1
  user_liquidity_enabled        INTEGER,    -- 0/1
  owner_cut_enabled             INTEGER,    -- 0/1
  owner_cut_auto_lock_enabled   INTEGER,    -- 0/1
  min_childkey_take_ratio       REAL,
  block_number                 INTEGER,    -- chain height at capture
  captured_at                  INTEGER NOT NULL, -- epoch milliseconds
  PRIMARY KEY (netuid)
);
