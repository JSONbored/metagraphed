-- Success-only latency completeness + durable tail latency on the daily rollup.
--
-- Latency is now recorded only for `ok` probes. The daily rollup additionally
-- stores how many healthy probes backed each day's mean (latency_samples) and
-- that day's exact p50/p95/p99, so tail latency survives the 30-day raw prune
-- (percentiles can't be reconstructed from a stored mean).
--
-- ALTER TABLE ... ADD COLUMN is non-destructive in SQLite; existing rows read
-- NULL until the next hourly rollup recomputes that day. Apply BEFORE deploying
-- the prober code that writes these columns so a missing column can never make
-- the (try/catch-wrapped) rollup silently drop history.

ALTER TABLE surface_uptime_daily ADD COLUMN latency_samples INTEGER;
ALTER TABLE surface_uptime_daily ADD COLUMN p50_latency_ms INTEGER;
ALTER TABLE surface_uptime_daily ADD COLUMN p95_latency_ms INTEGER;
ALTER TABLE surface_uptime_daily ADD COLUMN p99_latency_ms INTEGER;
