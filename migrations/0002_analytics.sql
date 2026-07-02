-- Historical analytics store (AI-4).
--
-- `subnet_snapshots` is a daily point-in-time capture of each subnet's
-- structural maturity (completeness + surface/endpoint counts), written once per
-- UTC day by the hourly cron (src/health-prober.mjs writeSubnetSnapshot, guarded
-- by ON CONFLICT so repeated hourly fires that day no-op). It powers the
-- week-over-week trajectory endpoint and the "fastest-growing" leaderboard.
--
-- Unlike surface_checks (a 30-day-pruned health time-series), snapshots are
-- low-volume (~129 rows/day) and retained long-term for growth analysis.

CREATE TABLE IF NOT EXISTS subnet_snapshots (
  netuid             INTEGER NOT NULL,
  snapshot_date      TEXT    NOT NULL,          -- YYYY-MM-DD (UTC)
  completeness_score INTEGER,
  surface_count      INTEGER,
  endpoint_count     INTEGER,
  monitored_count    INTEGER,
  candidate_count    INTEGER,
  captured_at        INTEGER NOT NULL,          -- epoch milliseconds
  PRIMARY KEY (netuid, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_date
  ON subnet_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_subnet_snapshots_netuid_date
  ON subnet_snapshots (netuid, snapshot_date);
