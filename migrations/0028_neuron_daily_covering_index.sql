-- Cover the per-subnet history rollup so the aggregate query can seek the
-- (netuid, snapshot_date) range and read the SUM columns from the index leaf
-- without per-row heap lookups on the hot path.

CREATE INDEX IF NOT EXISTS idx_neuron_daily_netuid_date_agg
  ON neuron_daily (netuid, snapshot_date, validator_permit, stake_tao, emission_tao);
