-- Live operational-health store (Phase 1).
--
-- Written every 2 minutes by the Cloudflare cron prober (src/health-prober.mjs)
-- and read live by the serving layer (workers/api.mjs). Decoupled from the 6h
-- build pipeline: a stale structural snapshot can never freeze health again.
--
-- `surface_checks` is the append-only time-series (powers /health/trends and is
-- pruned by the hourly cron). `surface_status` is the upserted latest row per
-- surface (powers live serving + the cross-isolate circuit-breaker counter).

CREATE TABLE IF NOT EXISTS surface_checks (
  surface_id     TEXT    NOT NULL,
  netuid         INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  status         TEXT    NOT NULL,            -- ok | degraded | failed | unknown
  classification TEXT,
  latency_ms     INTEGER,
  status_code    INTEGER,
  ok             INTEGER NOT NULL DEFAULT 0,  -- 1 when status = 'ok', else 0
  checked_at     INTEGER NOT NULL             -- epoch milliseconds
);

CREATE INDEX IF NOT EXISTS idx_surface_checks_surface_time
  ON surface_checks (surface_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_surface_checks_netuid_time
  ON surface_checks (netuid, checked_at);
CREATE INDEX IF NOT EXISTS idx_surface_checks_time
  ON surface_checks (checked_at);

CREATE TABLE IF NOT EXISTS surface_status (
  surface_id           TEXT PRIMARY KEY,
  netuid               INTEGER NOT NULL,
  kind                 TEXT    NOT NULL,
  url                  TEXT,
  provider             TEXT,
  status               TEXT    NOT NULL,
  classification       TEXT,
  latency_ms           INTEGER,
  status_code          INTEGER,
  last_checked         INTEGER,               -- epoch milliseconds
  last_ok              INTEGER,               -- epoch milliseconds
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL       -- epoch milliseconds
);

CREATE INDEX IF NOT EXISTS idx_surface_status_netuid
  ON surface_status (netuid);
