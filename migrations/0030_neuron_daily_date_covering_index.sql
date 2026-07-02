-- Cover the cross-subnet movers route, whose scans filter on snapshot_date first:
-- the window-boundary read (MIN/MAX(snapshot_date) WHERE snapshot_date >= ?) and the
-- two-day aggregate (WHERE snapshot_date IN (?, ?) GROUP BY netuid, snapshot_date). A
-- date-first index lets both range-seek the dates and read the SUM columns from the
-- index leaf without per-row heap lookups. The existing netuid-first
-- idx_neuron_daily_netuid_date_agg (0028) serves the per-subnet history rollup instead.

CREATE INDEX IF NOT EXISTS idx_neuron_daily_date_netuid_agg
  ON neuron_daily (snapshot_date, netuid, validator_permit, stake_tao, emission_tao);
