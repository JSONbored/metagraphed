// Approved archive disclosure fields, independent of the live storage schema.
// Space-delimited names keep this fixed policy compact in the Worker bundle.
// A migration must explicitly review this policy before exporting new columns.
export const D1_EXPORT_COLUMNS: Readonly<Record<string, string>> = {
  account_balances: "ss58 free_tao reserved_tao captured_at",
  account_identity:
    "account name url github image discord description additional captured_at",
  neurons:
    "netuid uid hotkey coldkey active validator_permit rank trust validator_trust consensus incentive dividends emission_tao stake_tao registered_at_block is_immunity_period axon block_number captured_at take",
  neuron_daily:
    "netuid uid hotkey coldkey active validator_permit rank trust validator_trust consensus incentive dividends emission_tao stake_tao registered_at_block is_immunity_period axon block_number captured_at take snapshot_date updated_at",
  account_position_daily:
    "account netuid snapshot_date uid coldkey active validator_permit rank trust incentive dividends stake_tao emission_tao captured_at updated_at",
  subnet_snapshots:
    "netuid snapshot_date completeness_score surface_count endpoint_count monitored_count candidate_count captured_at validator_count miner_count total_stake_tao alpha_price_tao emission_share tao_in_pool_tao alpha_in_pool alpha_out_pool subnet_volume_tao tao_in_emission_tao excess_tao alpha_in_emission alpha_out_emission miner_burned_fraction emission_enabled subtoken_enabled first_emission_block pipeline_block pipeline_block_hash",
  nominator_positions:
    "coldkey hotkey netuid share_fraction captured_at shares source",
  subnet_hyperparams:
    "netuid kappa_ratio immunity_period min_allowed_weights max_weight_limit_ratio tempo weights_version weights_rate_limit activity_cutoff activity_cutoff_factor registration_allowed target_regs_per_interval min_burn_tao max_burn_tao burn_half_life burn_increase_mult bonds_moving_avg_raw max_regs_per_block serving_rate_limit max_validators commit_reveal_period commit_reveal_enabled alpha_high_ratio alpha_low_ratio liquid_alpha_enabled alpha_sigmoid_steepness yuma_version subnet_is_active transfers_enabled bonds_reset_enabled user_liquidity_enabled owner_cut_enabled owner_cut_auto_lock_enabled min_childkey_take_ratio block_number captured_at",
  subnet_identity:
    "netuid block_number captured_at subnet_name symbol description github_repo subnet_url discord logo_url identity_hash",
  subnet_ownership: "netuid owner_hotkey owner_coldkey captured_at",
  validator_nominator_counts: "hotkey nominator_count captured_at",
  account_identity_history:
    "id account observed_at name url github image discord description additional identity_hash",
  subnet_hyperparams_history:
    "id netuid block_number observed_at kappa_ratio immunity_period min_allowed_weights max_weight_limit_ratio tempo weights_version weights_rate_limit activity_cutoff activity_cutoff_factor registration_allowed target_regs_per_interval min_burn_tao max_burn_tao burn_half_life burn_increase_mult bonds_moving_avg_raw max_regs_per_block serving_rate_limit max_validators commit_reveal_period commit_reveal_enabled alpha_high_ratio alpha_low_ratio liquid_alpha_enabled alpha_sigmoid_steepness yuma_version subnet_is_active transfers_enabled bonds_reset_enabled user_liquidity_enabled owner_cut_enabled owner_cut_auto_lock_enabled min_childkey_take_ratio hyperparams_hash",
  subnet_identity_history:
    "id netuid block_number observed_at subnet_name symbol description github_repo subnet_url discord logo_url identity_hash",
  subnet_ownership_history: "id netuid owner_hotkey owner_coldkey captured_at",
  chain_concentration_daily:
    "day neuron_count card source_captured_at computed_at builder_version",
  compute_declarations:
    "netuid source_url read_at_sha observed_at first_seen found spec_version miner validator unscoped",
  hotkey_alpha: "hotkey netuid total_alpha captured_at",
  revenue_observations:
    "surface_id netuid period grain amount currency provenance response_hash observed_at",
  subnet_deregistration_daily:
    "netuid snapshot_date moving_price registered_at_block subnet_mechanism network_immunity_period pinned_block captured_at",
  surface_failure_daily: "day netuid kind classification checks updated_at",
  surface_uptime_daily:
    "surface_id surface_key netuid day samples ok_count uptime_ratio avg_latency_ms status latency_samples p50_latency_ms p95_latency_ms p99_latency_ms updated_at",
  treasury_readings:
    "netuid source_url read_at_sha observed_at first_seen found declared_share treasury_address applies_to evidence_path review_state reviewed_at",
  emission_flow_watch:
    "id item netuid is_set ema_block block_number observed_at predates_capture",
  emission_gate_param_history:
    "id param value previous_value source block_number observed_at predates_capture",
  subnet_emission_enabled_history:
    "id netuid enabled previous_enabled block_number observed_at predates_capture",
  subnet_lifecycle: "id netuid event block_number observed_at predates_capture",
  surface_history:
    "id surface_id subnet_netuid action overlay source_commit recorded_at",
  tao_usd_index:
    "block_number observed_at usd_per_tao price_basis eth_usd pool_count pools",
  subnet_burn_history: "netuid observed_at burn_tao",
  providers: "id overlay source_commit updated_at",
  subnets: "netuid slug name source overlay source_commit updated_at",
  surfaces:
    "id subnet_netuid provider_id surface_key kind url authority review_state probe_eligible public_safe overlay source_commit updated_at",
  self_health_daily: "day component checks ok_count",
};
