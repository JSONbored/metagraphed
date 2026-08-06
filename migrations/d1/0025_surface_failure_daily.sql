-- Keep the REASON a probe failed, not just the rate (#9622).
--
-- WHAT IS BEING LOST TODAY. `surface_checks` records a `classification` on every
-- probe -- live, transient, rate-limited, redirected, dead, timeout,
-- content-mismatch, unsupported, auth-required -- and that column is the only
-- record of WHY a surface failed. `rollupDailyUptime` aggregates the same table
-- into `surface_uptime_daily`, which is retained indefinitely and carries
-- samples, ok_count, uptime_ratio and latency percentiles but NOT the
-- classification: it keeps the rate of failure and discards the reason.
-- `pruneHealthHistory` then deletes the raw rows at 30 days.
--
-- So the answer to "why did this surface fail" has a 30-day expiry, and nothing
-- downstream of the prune has ever been able to reconstruct it. A reader alone
-- could not fix that -- it would be capped at the retention window forever.
--
-- THE GRAIN. One row per (day, netuid, kind, classification). Measured
-- 2026-08-06 over the 26 days currently retained: 7,312 rows, about 280 a day,
-- from 1,263,089 raw checks. Cheap to read, cheap to keep forever, and fine
-- enough to answer both "is the network's failure mix shifting" and "why is THIS
-- subnet's API failing".
CREATE TABLE IF NOT EXISTS surface_failure_daily (
  -- UTC day, 'YYYY-MM-DD', matching surface_uptime_daily.day so the two rollups
  -- join without a conversion.
  day            TEXT    NOT NULL,
  -- Nullable because surface_checks.netuid is: a registry-level surface belongs
  -- to no subnet. See the unique index below for how that is keyed.
  netuid         INTEGER,
  kind           TEXT    NOT NULL,
  classification TEXT    NOT NULL,
  -- Probes with this classification on this day. `live` rows are kept too: a
  -- failure mix without its denominator is a count, not a rate, and a reader
  -- that had to fetch the total from elsewhere would be free to pair it with a
  -- different window.
  checks         INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- The uniqueness key, and the reason it is an EXPRESSION index rather than a
-- plain PRIMARY KEY: SQLite treats NULLs as distinct in a unique constraint, so
-- a bare (day, netuid, kind, classification) key would let every hourly rollup
-- tick append another row for the registry-level surfaces instead of updating
-- the one it wrote last time. The alternative -- storing a sentinel netuid --
-- puts an invented subnet in the data, which is worse than a slightly unusual
-- index. `ifnull(netuid, -1)` collapses those rows for keying only; the column
-- itself stays honestly null, and this expression is what the writer's ON
-- CONFLICT target names.
CREATE UNIQUE INDEX IF NOT EXISTS ux_surface_failure_daily_key
  ON surface_failure_daily (day, ifnull(netuid, -1), kind, classification);

-- The serving read: a window of days, network-wide or scoped to one subnet.
CREATE INDEX IF NOT EXISTS idx_surface_failure_daily_day
  ON surface_failure_daily (day DESC, netuid);

-- BACKFILL FROM THE RAW TABLE, so the route ships with the history that already
-- exists rather than starting empty and becoming useful in a month. Everything
-- `surface_checks` still holds -- 26 days at the time of writing, back to
-- 2026-07-11 -- is aggregated here in one pass.
--
-- This is a copy, not a reconstruction: the raw rows carry the classification
-- directly. Rows missing any part of the key are skipped rather than bucketed
-- under a placeholder, because a row that cannot say which surface kind it
-- describes cannot honestly be counted in that kind's mix. Measured across all
-- 1,263,089 raw rows, none are missing one -- but the schema permits it, so the
-- backfill is written to the schema and not to today's data.
--
-- INSERT OR IGNORE, not a bare INSERT: re-running this migration against a
-- database that already has the rollup must be a no-op rather than a duplicate-
-- key failure, and the hourly writer owns every day from here on.
INSERT OR IGNORE INTO surface_failure_daily
  (day, netuid, kind, classification, checks, updated_at)
SELECT date(checked_at / 1000, 'unixepoch') AS day,
       netuid,
       kind,
       classification,
       COUNT(*) AS checks,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS updated_at
  FROM surface_checks
 WHERE kind IS NOT NULL
   AND classification IS NOT NULL
 GROUP BY 1, 2, 3, 4;
