-- Durable record of every watchdog verdict (#9330, #9340).
--
-- Every staleness watchdog reported through one channel: recordExceptionEvent ->
-- PostHog $exception. PostHog drops $exception silently once the free-tier quota is
-- exhausted, and this project runs at roughly 1M events/day. Three lanes have now gone
-- stale with the alarm working perfectly and nobody hearing it -- most recently the
-- 2026-08-03 chain-detail outage (#9316), ~4 hours against a 20-minute threshold, which
-- should have produced roughly ten stale verdicts and surfaced none.
--
-- One row per lane per tick. A few bytes, and it answers the question a notification
-- cannot: "was anything stale overnight".
CREATE TABLE IF NOT EXISTS lane_health (
  lane       TEXT    NOT NULL,
  -- 'ok' | 'stale' | 'unknown'. `unknown` is deliberately distinct from `ok`: a
  -- watchdog that could not evaluate has not observed health, and collapsing the two
  -- would report an unmeasured lane as a healthy one.
  verdict    TEXT    NOT NULL,
  age_ms     INTEGER,
  detail     TEXT,
  checked_at INTEGER NOT NULL
);

-- The two reads this table exists for: the newest verdict per lane (self-health), and
-- "was anything stale in a window" (triage). Both are served by one composite.
CREATE INDEX IF NOT EXISTS idx_lane_health_lane_checked
  ON lane_health (lane, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_lane_health_stale
  ON lane_health (checked_at DESC)
  WHERE verdict = 'stale';
