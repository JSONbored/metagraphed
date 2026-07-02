-- Durable daily uptime history (live-only health, PR3).
--
-- The raw 2-minute surface_checks time-series is a 30-day hot window (powers the
-- live trends/percentiles/incidents routes) and is pruned beyond that. To retain
-- long-term uptime for analytics WITHOUT storing ~300M raw rows/yr, the hourly
-- cron rolls each UTC day's raw checks into ONE row per (surface, day) here —
-- ~420K rows/yr — and only then prunes the raw window. Retained indefinitely.

CREATE TABLE IF NOT EXISTS surface_uptime_daily (
  surface_id     TEXT    NOT NULL,
  netuid         INTEGER NOT NULL,
  day            TEXT    NOT NULL,            -- UTC date, YYYY-MM-DD
  samples        INTEGER NOT NULL,           -- probe checks recorded that day
  ok_count       INTEGER NOT NULL,           -- checks with status = 'ok'
  uptime_ratio   REAL,                       -- ok_count / samples (4dp)
  avg_latency_ms INTEGER,                    -- mean latency over the day
  status         TEXT,                       -- ok | degraded | failed (daily rollup)
  updated_at     INTEGER NOT NULL,           -- epoch ms of the last rollup write
  PRIMARY KEY (surface_id, day)
);

CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_netuid_day
  ON surface_uptime_daily (netuid, day);
