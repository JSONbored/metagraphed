// Subnet hyperparameters (#4303, epic #4301): one row per netuid, latest-only.
// Field mapping documented in scripts/fetch-subnet-hyperparams.py's docstring
// and migrations/0036_subnet_hyperparams.sql. Mirrors NEURON_INSERT_COLUMNS's
// role in src/metagraph-neurons.mjs — the full column set written by the
// staged-load path (loadStagedSubnetHyperparams) and read by the serving
// route (#4307/1.4).

export const SUBNET_HYPERPARAMS_INSERT_COLUMNS = [
  "netuid",
  "kappa_ratio",
  "immunity_period",
  "min_allowed_weights",
  "max_weight_limit_ratio",
  "tempo",
  "weights_version",
  "weights_rate_limit",
  "activity_cutoff",
  "activity_cutoff_factor",
  "registration_allowed",
  "target_regs_per_interval",
  "min_burn_tao",
  "max_burn_tao",
  "burn_half_life",
  "burn_increase_mult",
  "bonds_moving_avg_raw",
  "max_regs_per_block",
  "serving_rate_limit",
  "max_validators",
  "commit_reveal_period",
  "commit_reveal_enabled",
  "alpha_high_ratio",
  "alpha_low_ratio",
  "liquid_alpha_enabled",
  "alpha_sigmoid_steepness",
  "yuma_version",
  "subnet_is_active",
  "transfers_enabled",
  "bonds_reset_enabled",
  "user_liquidity_enabled",
  "owner_cut_enabled",
  "owner_cut_auto_lock_enabled",
  "min_childkey_take_ratio",
  "block_number",
  "captured_at",
];
