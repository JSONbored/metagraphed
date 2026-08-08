-- lane_health, the durable sink every watchdog writes to (#10135).
--
-- HELD BACK FROM 0005 DELIBERATELY, and that is how it got lost. 0005's header
-- lists this table as one it excludes -- "it moves LAST and on its own, because
-- until it does it is the only thing that can report a lane that broke while
-- being moved" -- which was the right call and left no migration behind. When
-- #10127 flipped lane_health to sole-store, the flag pointed at a table Neon
-- did not have.
--
-- The failure was exactly as quiet as this table's own design makes it:
-- recordLaneVerdict swallows its errors on purpose, so every verdict was
-- dropped with nothing to report the dropping. D1's copy went on filling from
-- Workers that had not redeployed yet, which made the two stores look merely
-- out of step rather than one of them missing.
--
-- TYPES. INTEGER -> BIGINT for both epoch-ms columns: checked_at is a
-- millisecond timestamp (1.79e12 today) and age_ms is a duration that can
-- exceed a 32-bit int on a lane that has been silent for a month. Postgres
-- INTEGER tops out at 2.1e9 and would have failed on the first write.
CREATE TABLE IF NOT EXISTS lane_health (
  lane       TEXT   NOT NULL,
  -- 'ok' | 'stale' | 'unknown'. `unknown` is deliberately distinct from `ok`: a
  -- watchdog that could not evaluate has not observed health, and collapsing
  -- the two would report an unmeasured lane as a healthy one.
  verdict    TEXT   NOT NULL,
  age_ms     BIGINT,
  detail     TEXT,
  checked_at BIGINT NOT NULL
);

-- The two reads this table exists for: the newest verdict per lane
-- (self-health), and "was anything stale in a window" (triage).
CREATE INDEX IF NOT EXISTS idx_lane_health_lane_checked
  ON lane_health (lane, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_lane_health_stale
  ON lane_health (checked_at DESC)
  WHERE verdict = 'stale';
