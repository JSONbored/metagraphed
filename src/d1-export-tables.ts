// Fixed archive shapes. Keys follow primary/covering indexes, including the
// nullable failure-group expression. No request supplies an SQL identifier.
export const D1_EXPORT_TABLES: Record<
  string,
  { keys: string[]; watermark?: string[]; daily?: boolean }
> = {
  account_balances: { keys: ["ss58"] },
  account_identity: { keys: ["account"] },
  neurons: { keys: ["netuid", "uid"] },
  neuron_daily: { keys: ["snapshot_date", "netuid", "uid"], daily: true },
  account_position_daily: {
    keys: ["snapshot_date", "netuid", "account"],
    daily: true,
  },
  subnet_snapshots: { keys: ["snapshot_date", "netuid"], daily: true },
  nominator_positions: { keys: ["coldkey", "hotkey", "netuid"] },
  subnet_hyperparams: { keys: ["netuid"] },
  subnet_identity: { keys: ["netuid"] },
  subnet_ownership: { keys: ["netuid"] },
  validator_nominator_counts: { keys: ["hotkey"] },
  account_identity_history: { keys: ["id"], watermark: ["id"] },
  subnet_hyperparams_history: { keys: ["id"], watermark: ["id"] },
  subnet_identity_history: { keys: ["id"], watermark: ["id"] },
  subnet_ownership_history: { keys: ["id"], watermark: ["id"] },
  chain_concentration_daily: { keys: ["day"] },
  compute_declarations: { keys: ["netuid", "source_url"] },
  hotkey_alpha: { keys: ["hotkey", "netuid"] },
  revenue_observations: { keys: ["surface_id", "period"] },
  subnet_deregistration_daily: { keys: ["netuid", "snapshot_date"] },
  surface_failure_daily: {
    keys: ["day", "coalesce(netuid,-1)", "kind", "classification"],
  },
  surface_uptime_daily: { keys: ["surface_id", "day"] },
  treasury_readings: { keys: ["netuid", "source_url"] },
  emission_flow_watch: { keys: ["id"], watermark: ["id"] },
  emission_gate_param_history: { keys: ["id"], watermark: ["id"] },
  subnet_emission_enabled_history: { keys: ["id"], watermark: ["id"] },
  subnet_lifecycle: { keys: ["id"], watermark: ["id"] },
  surface_history: { keys: ["id"], watermark: ["id"] },
  tao_usd_index: {
    keys: ["observed_at", "block_number"],
    watermark: ["observed_at"],
  },
  subnet_burn_history: {
    keys: ["observed_at", "netuid"],
    watermark: ["observed_at", "netuid"],
  },
  providers: { keys: ["id"] },
  subnets: { keys: ["netuid"] },
  surfaces: { keys: ["id"] },
  self_health_daily: { keys: ["day", "component"], watermark: ["day"] },
};
