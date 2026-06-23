-- Perf hardening (audit-driven, epic #512): composite indexes that let hot
-- analytics queries SEEK instead of full-scan-then-sort. All additive
-- (CREATE INDEX IF NOT EXISTS), idempotent, safe to re-apply. Each index is
-- justified by a specific live query — see the comment above it.

-- handleLeaderboards (workers/api.mjs): `... FROM subnet_snapshots
-- WHERE snapshot_date >= ? ORDER BY netuid, snapshot_date`. The existing
-- idx_subnet_snapshots_netuid_date (netuid, snapshot_date) leads with netuid, so a
-- `snapshot_date >=` range filter cannot seek and must scan; (snapshot_date, netuid)
-- seeks the date range and yields rows already ordered for the netuid grouping.
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_date_netuid
  ON subnet_snapshots (snapshot_date, netuid);

-- handleBulkHealthTrends (workers/api.mjs): `... FROM surface_uptime_daily
-- WHERE day >= ? GROUP BY netuid, day`. The existing
-- idx_surface_uptime_daily_netuid_day (netuid, day) is backwards for a `day >=`
-- range scan across all subnets; (day, netuid) matches the access pattern.
CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_day_netuid
  ON surface_uptime_daily (day, netuid);

-- handleRpcUsage (workers/api.mjs): `... FROM rpc_proxy_events
-- WHERE observed_at >= ? AND endpoint_id IS NOT NULL GROUP BY endpoint_id, provider`.
-- The existing idx_rpc_proxy_events_observed (observed_at) seeks the range but then
-- post-filters endpoint_id; (observed_at, endpoint_id) skips NULL endpoint_id rows
-- inside the index.
CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_observed_endpoint
  ON rpc_proxy_events (observed_at, endpoint_id);

-- loadStagedNeurons prune (workers/api.mjs): `DELETE FROM neurons WHERE captured_at < ?`
-- (and the netuid-scoped variant) deregisters stale UIDs on every */3 staged load.
-- No captured_at index existed, so this prune full-scanned the ~33k-row table each
-- tick; this covers the captured_at predicate.
CREATE INDEX IF NOT EXISTS idx_neurons_captured_at
  ON neurons (captured_at);
