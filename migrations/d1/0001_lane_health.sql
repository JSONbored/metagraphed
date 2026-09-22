-- First qualified table in the Neon retirement (#12151). The serving columns
-- and indexes match Neon; _source_tid supports idempotent migration replay and
-- is absent from every serving projection. Native producers leave it NULL.
CREATE TABLE lane_health (
    lane TEXT NOT NULL,
    verdict TEXT NOT NULL,
    age_ms INTEGER,
    detail TEXT,
    checked_at INTEGER NOT NULL,
    _source_tid TEXT UNIQUE
);
-- statement-breakpoint
CREATE INDEX idx_lane_health_lane_checked ON lane_health (lane, checked_at DESC);
-- statement-breakpoint
CREATE INDEX idx_lane_health_stale ON lane_health (checked_at DESC) WHERE verdict = 'stale';
