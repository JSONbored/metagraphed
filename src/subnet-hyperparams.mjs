// Subnet hyperparameters (#4303, epic #4301): one row per netuid, latest-only.
// Field mapping documented in
// apps/indexer-rs/src/bin/poller/jobs/subnet_hyperparams.rs and
// migrations/0036_subnet_hyperparams.sql. Mirrors NEURON_INSERT_COLUMNS's
// role in src/metagraph-neurons.mjs — the full column set written by the
// Postgres write path (workers/data-api.mjs's handleSubnetHyperparamsSync)
// and read by the serving route (#4307/1.4).

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

// Same D1-cell coercion helpers as src/metagraph-neurons.mjs (each domain file
// owns its own small copies rather than a shared util — see formatNeuron's
// header comment for why the null-guards matter: Number(null) is 0, not NaN).
function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nullableNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function round(value, dp) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// *_ratio columns are already a 0..1 U16-derived ratio by the time they reach
// D1 (apps/indexer-rs/src/bin/poller/jobs/subnet_hyperparams.rs's u16_ratio,
// rounded to 9dp there
// too) — round again here as defense-in-depth against a future writer that
// skips that rounding, not because this path expects dirty data.
function ratio(value) {
  return round(nullableNumber(value), 9);
}

// D1 0/1 INTEGER -> real boolean, matching toD1Flag in metagraph-neurons.mjs.
function toD1Flag(value) {
  return Number(value) === 1;
}

export function formatSubnetHyperparams(row) {
  if (!row || typeof row !== "object") return null;
  return {
    kappa_ratio: ratio(row.kappa_ratio),
    immunity_period: nonNegativeInt(row.immunity_period),
    min_allowed_weights: nonNegativeInt(row.min_allowed_weights),
    max_weight_limit_ratio: ratio(row.max_weight_limit_ratio),
    tempo: nonNegativeInt(row.tempo),
    weights_version: nonNegativeInt(row.weights_version),
    weights_rate_limit: nonNegativeInt(row.weights_rate_limit),
    activity_cutoff: nonNegativeInt(row.activity_cutoff),
    activity_cutoff_factor: nonNegativeInt(row.activity_cutoff_factor),
    registration_allowed: toD1Flag(row.registration_allowed),
    target_regs_per_interval: nonNegativeInt(row.target_regs_per_interval),
    // rao/1e9-exact-split TAO values (rao_to_tao_exact) — round to rao
    // precision (9dp), not formatNeuron's 6dp roundTao, so no low-order rao
    // digits are lost re-serializing an already-exact value.
    min_burn_tao: round(nullableNumber(row.min_burn_tao), 9),
    max_burn_tao: round(nullableNumber(row.max_burn_tao), 9),
    burn_half_life: nonNegativeInt(row.burn_half_life),
    // Already float-decoded fixed-point on the SDK side — passed through.
    burn_increase_mult: nullableNumber(row.burn_increase_mult),
    // Raw on-chain integer, deliberately not scaled to a ratio (unconfirmed
    // scaling constant — see migrations/0036_subnet_hyperparams.sql).
    bonds_moving_avg_raw: nonNegativeInt(row.bonds_moving_avg_raw),
    max_regs_per_block: nonNegativeInt(row.max_regs_per_block),
    serving_rate_limit: nonNegativeInt(row.serving_rate_limit),
    max_validators: nonNegativeInt(row.max_validators),
    commit_reveal_period: nonNegativeInt(row.commit_reveal_period),
    commit_reveal_enabled: toD1Flag(row.commit_reveal_enabled),
    alpha_high_ratio: ratio(row.alpha_high_ratio),
    alpha_low_ratio: ratio(row.alpha_low_ratio),
    liquid_alpha_enabled: toD1Flag(row.liquid_alpha_enabled),
    alpha_sigmoid_steepness: nullableNumber(row.alpha_sigmoid_steepness),
    yuma_version: nonNegativeInt(row.yuma_version),
    subnet_is_active: toD1Flag(row.subnet_is_active),
    transfers_enabled: toD1Flag(row.transfers_enabled),
    bonds_reset_enabled: toD1Flag(row.bonds_reset_enabled),
    user_liquidity_enabled: toD1Flag(row.user_liquidity_enabled),
    owner_cut_enabled: toD1Flag(row.owner_cut_enabled),
    owner_cut_auto_lock_enabled: toD1Flag(row.owner_cut_auto_lock_enabled),
    min_childkey_take_ratio: ratio(row.min_childkey_take_ratio),
  };
}

// GET /api/v1/subnets/{netuid}/hyperparameters (#4307/1.4). Cold/absent
// snapshot -> 200 with hyperparameters:null, consistent with handleNeuron and
// the other live D1 tiers (never 404 on a cold store).
export function buildSubnetHyperparams(row, netuid) {
  return {
    schema_version: 1,
    netuid,
    captured_at: toIso(row?.captured_at),
    block_number: nonNegativeInt(row?.block_number),
    hyperparameters: formatSubnetHyperparams(row),
  };
}
