// Type-level SELECT-list drift protection (types-epic C, #7861 requirement
// 5): one compile-time assertion per adopted table, spelling out the real
// column list a workers/data-api.ts query selects, independently of the
// generated type's own field list. If a future migration renames/drops a
// column that Kanel picks up (generated/db regenerated) but a query in
// workers/data-api.ts still references, `npm run typecheck` fails here --
// these are pure type assertions, never expected to fail at vitest runtime.
import { expectTypeOf, test } from "vitest";
import type Neurons from "../generated/db/public/Neurons.ts";
import type NeuronDaily from "../generated/db/public/NeuronDaily.ts";
import type AccountEvents from "../generated/db/public/AccountEvents.ts";
import type Extrinsics from "../generated/db/public/Extrinsics.ts";
import type Blocks from "../generated/db/public/Blocks.ts";
import type SubnetSnapshots from "../generated/db/public/SubnetSnapshots.ts";
import type SurfaceStatus from "../generated/db/public/SurfaceStatus.ts";
import type SurfaceChecks from "../generated/db/public/SurfaceChecks.ts";
import type SubnetLocks from "../generated/db/public/SubnetLocks.ts";
import type SubnetHyperparams from "../generated/db/public/SubnetHyperparams.ts";

test("neurons: NEURON_COLUMNS (metagraph/validator-detail routes) exist on the generated row type", () => {
  const t = expectTypeOf<Neurons>();
  t.toHaveProperty("netuid");
  t.toHaveProperty("uid");
  t.toHaveProperty("hotkey");
  t.toHaveProperty("coldkey");
  t.toHaveProperty("active");
  t.toHaveProperty("validator_permit");
  t.toHaveProperty("rank");
  t.toHaveProperty("trust");
  t.toHaveProperty("validator_trust");
  t.toHaveProperty("consensus");
  t.toHaveProperty("incentive");
  t.toHaveProperty("dividends");
  t.toHaveProperty("emission_tao");
  t.toHaveProperty("stake_tao");
  t.toHaveProperty("registered_at_block");
  t.toHaveProperty("is_immunity_period");
  t.toHaveProperty("axon");
  t.toHaveProperty("block_number");
  t.toHaveProperty("captured_at");
  t.toHaveProperty("take");
});

test("neuron_daily: neuron-history route's full snapshot column list exists on the generated row type", () => {
  const t = expectTypeOf<NeuronDaily>();
  t.toHaveProperty("netuid");
  t.toHaveProperty("snapshot_date");
  t.toHaveProperty("uid");
  t.toHaveProperty("hotkey");
  t.toHaveProperty("coldkey");
  t.toHaveProperty("active");
  t.toHaveProperty("validator_permit");
  t.toHaveProperty("rank");
  t.toHaveProperty("trust");
  t.toHaveProperty("validator_trust");
  t.toHaveProperty("consensus");
  t.toHaveProperty("incentive");
  t.toHaveProperty("dividends");
  t.toHaveProperty("emission_tao");
  t.toHaveProperty("stake_tao");
  t.toHaveProperty("registered_at_block");
  t.toHaveProperty("is_immunity_period");
  t.toHaveProperty("axon");
  t.toHaveProperty("block_number");
  t.toHaveProperty("captured_at");
});

test("account_events: the full 11-column AccountEventReadRow list exists on the generated row type", () => {
  const t = expectTypeOf<AccountEvents>();
  t.toHaveProperty("block_number");
  t.toHaveProperty("event_index");
  t.toHaveProperty("observed_at");
  t.toHaveProperty("extrinsic_index");
  t.toHaveProperty("event_kind");
  t.toHaveProperty("hotkey");
  t.toHaveProperty("coldkey");
  t.toHaveProperty("netuid");
  t.toHaveProperty("uid");
  t.toHaveProperty("amount_tao");
  t.toHaveProperty("alpha_amount");
});

test("extrinsics: EXTRINSIC_READ_COLUMNS exist on the generated row type", () => {
  const t = expectTypeOf<Extrinsics>();
  t.toHaveProperty("block_number");
  t.toHaveProperty("extrinsic_index");
  t.toHaveProperty("observed_at");
  t.toHaveProperty("extrinsic_hash");
  t.toHaveProperty("signer");
  t.toHaveProperty("call_module");
  t.toHaveProperty("call_function");
  t.toHaveProperty("call_args");
  t.toHaveProperty("success");
  t.toHaveProperty("fee_tao");
  t.toHaveProperty("tip_tao");
});

test("blocks: BLOCK_READ_COLUMNS (the full row) exist on the generated row type", () => {
  const t = expectTypeOf<Blocks>();
  t.toHaveProperty("block_number");
  t.toHaveProperty("observed_at");
  t.toHaveProperty("block_hash");
  t.toHaveProperty("parent_hash");
  t.toHaveProperty("author");
  t.toHaveProperty("extrinsic_count");
  t.toHaveProperty("event_count");
  t.toHaveProperty("spec_version");
});

test("subnet_snapshots: trajectory/economics-trends/concentration-history columns exist on the generated row type", () => {
  const t = expectTypeOf<SubnetSnapshots>();
  t.toHaveProperty("netuid");
  t.toHaveProperty("snapshot_date");
  t.toHaveProperty("completeness_score");
  t.toHaveProperty("surface_count");
  t.toHaveProperty("endpoint_count");
  t.toHaveProperty("validator_count");
  t.toHaveProperty("miner_count");
  t.toHaveProperty("total_stake_tao");
  t.toHaveProperty("alpha_price_tao");
  t.toHaveProperty("emission_share");
  t.toHaveProperty("tao_in_pool_tao");
  t.toHaveProperty("alpha_in_pool");
  t.toHaveProperty("alpha_out_pool");
  t.toHaveProperty("subnet_volume_tao");
});

test("surface_status: internal/health-status-live route's column list exists on the generated row type", () => {
  const t = expectTypeOf<SurfaceStatus>();
  t.toHaveProperty("surface_id");
  t.toHaveProperty("surface_key");
  t.toHaveProperty("netuid");
  t.toHaveProperty("kind");
  t.toHaveProperty("provider");
  t.toHaveProperty("url");
  t.toHaveProperty("status");
  t.toHaveProperty("classification");
  t.toHaveProperty("latency_ms");
  t.toHaveProperty("status_code");
  t.toHaveProperty("last_checked");
  t.toHaveProperty("last_ok");
});

test("surface_checks: the full row (health-trends/incidents/uptime routes) exists on the generated row type", () => {
  const t = expectTypeOf<SurfaceChecks>();
  t.toHaveProperty("surface_id");
  t.toHaveProperty("checked_at");
  t.toHaveProperty("surface_key");
  t.toHaveProperty("netuid");
  t.toHaveProperty("kind");
  t.toHaveProperty("status");
  t.toHaveProperty("classification");
  t.toHaveProperty("latency_ms");
  t.toHaveProperty("status_code");
  t.toHaveProperty("ok");
});

test("subnet_locks: the conviction route's column list exists on the generated row type", () => {
  const t = expectTypeOf<SubnetLocks>();
  t.toHaveProperty("hotkey");
  t.toHaveProperty("is_owner");
  t.toHaveProperty("is_perpetual");
  t.toHaveProperty("locked_mass");
  t.toHaveProperty("conviction_bits");
  t.toHaveProperty("last_update");
});

test("subnet_hyperparams: the hyperparameters route's full column list (all but netuid) exists on the generated row type", () => {
  const t = expectTypeOf<SubnetHyperparams>();
  t.toHaveProperty("kappa_ratio");
  t.toHaveProperty("immunity_period");
  t.toHaveProperty("min_allowed_weights");
  t.toHaveProperty("max_weight_limit_ratio");
  t.toHaveProperty("tempo");
  t.toHaveProperty("weights_version");
  t.toHaveProperty("weights_rate_limit");
  t.toHaveProperty("activity_cutoff");
  t.toHaveProperty("activity_cutoff_factor");
  t.toHaveProperty("registration_allowed");
  t.toHaveProperty("target_regs_per_interval");
  t.toHaveProperty("min_burn_tao");
  t.toHaveProperty("max_burn_tao");
  t.toHaveProperty("burn_half_life");
  t.toHaveProperty("burn_increase_mult");
  t.toHaveProperty("bonds_moving_avg_raw");
  t.toHaveProperty("max_regs_per_block");
  t.toHaveProperty("serving_rate_limit");
  t.toHaveProperty("max_validators");
  t.toHaveProperty("commit_reveal_period");
  t.toHaveProperty("commit_reveal_enabled");
  t.toHaveProperty("alpha_high_ratio");
  t.toHaveProperty("alpha_low_ratio");
  t.toHaveProperty("liquid_alpha_enabled");
  t.toHaveProperty("alpha_sigmoid_steepness");
  t.toHaveProperty("yuma_version");
  t.toHaveProperty("subnet_is_active");
  t.toHaveProperty("transfers_enabled");
  t.toHaveProperty("bonds_reset_enabled");
  t.toHaveProperty("user_liquidity_enabled");
  t.toHaveProperty("owner_cut_enabled");
  t.toHaveProperty("owner_cut_auto_lock_enabled");
  t.toHaveProperty("min_childkey_take_ratio");
  t.toHaveProperty("block_number");
  t.toHaveProperty("captured_at");
});
