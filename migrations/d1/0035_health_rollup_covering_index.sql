-- Hourly uptime and failure rollups need these fields for every check in the
-- day. Cover them in the time index instead of looking up each primary row.
-- surface_id is already included by the WITHOUT ROWID table's primary key.
CREATE INDEX idx_surface_checks_rollup
ON surface_checks(checked_at DESC,surface_key,netuid,ok,latency_ms,kind,classification);
-- statement-breakpoint
DROP INDEX idx_surface_checks_time;
