-- Avoid scanning the retained history for every dashboard/watchdog read.
-- The trigger follows loadLatestLaneHealth: newer wins, and equal timestamps
-- take the worse verdict. Unknown/unrecognized verdicts rank between ok/stale.
CREATE TABLE lane_health_current (
    lane TEXT PRIMARY KEY,
    verdict TEXT NOT NULL,
    age_ms INTEGER,
    detail TEXT,
    checked_at INTEGER NOT NULL,
    _history_rowid INTEGER NOT NULL
);
-- statement-breakpoint
INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
SELECT lane, verdict, age_ms, detail, checked_at, history_rowid FROM (
    SELECT lane, verdict, age_ms, detail, checked_at, rowid AS history_rowid,
           ROW_NUMBER() OVER (PARTITION BY lane ORDER BY checked_at DESC,
               CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, rowid) AS position
    FROM lane_health
) WHERE position = 1;
-- statement-breakpoint
CREATE TRIGGER lane_health_current_insert AFTER INSERT ON lane_health BEGIN
    INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
    VALUES (NEW.lane, NEW.verdict, NEW.age_ms, NEW.detail, NEW.checked_at, NEW.rowid)
    ON CONFLICT(lane) DO UPDATE SET verdict=excluded.verdict, age_ms=excluded.age_ms,
        detail=excluded.detail, checked_at=excluded.checked_at, _history_rowid=excluded._history_rowid
    WHERE excluded.checked_at > lane_health_current.checked_at OR
        (excluded.checked_at = lane_health_current.checked_at AND
            CASE excluded.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END >
            CASE lane_health_current.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END);
END;
-- statement-breakpoint
CREATE TRIGGER lane_health_current_delete AFTER DELETE ON lane_health
WHEN EXISTS (SELECT 1 FROM lane_health_current WHERE _history_rowid = OLD.rowid AND lane = OLD.lane) BEGIN
    DELETE FROM lane_health_current WHERE lane = OLD.lane;
    INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
    SELECT lane, verdict, age_ms, detail, checked_at, rowid FROM lane_health WHERE lane = OLD.lane
    ORDER BY checked_at DESC, CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, rowid LIMIT 1;
END;
-- statement-breakpoint
CREATE TRIGGER lane_health_current_update AFTER UPDATE ON lane_health BEGIN
    DELETE FROM lane_health_current WHERE lane IN (OLD.lane, NEW.lane);
    INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
    SELECT lane, verdict, age_ms, detail, checked_at, history_rowid FROM (
        SELECT lane, verdict, age_ms, detail, checked_at, rowid AS history_rowid,
               ROW_NUMBER() OVER (PARTITION BY lane ORDER BY checked_at DESC,
                   CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, rowid) AS position
        FROM lane_health WHERE lane IN (OLD.lane, NEW.lane)
    ) WHERE position = 1;
END;
