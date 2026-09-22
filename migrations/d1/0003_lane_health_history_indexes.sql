-- Keep adjacency and last-verdict indexes transactionally consistent with history.
-- Duplicate timestamps count as multiple samples but have zero intervening gap.
-- Late arrivals split an interval; pruning rejoins it. All readers retain the
-- original strict cutoff semantics, including excluding the first sample's gap.
CREATE TABLE lane_health_clocks (
    lane TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    occurrences INTEGER NOT NULL,
    previous_at INTEGER,
    gap INTEGER GENERATED ALWAYS AS (checked_at - previous_at) STORED,
    PRIMARY KEY (lane, checked_at)
) WITHOUT ROWID;
-- statement-breakpoint
INSERT INTO lane_health_clocks (lane, checked_at, occurrences, previous_at)
SELECT lane, checked_at, COUNT(*), LAG(checked_at) OVER (PARTITION BY lane ORDER BY checked_at)
FROM lane_health GROUP BY lane, checked_at;
-- statement-breakpoint
CREATE INDEX idx_lane_health_gaps ON lane_health_clocks (lane, gap DESC, checked_at DESC, previous_at);
-- statement-breakpoint
CREATE INDEX idx_lane_health_time ON lane_health (checked_at, lane, verdict);
-- statement-breakpoint
CREATE INDEX idx_lane_health_verdict ON lane_health (lane, verdict, checked_at);
-- statement-breakpoint
CREATE TABLE lane_health_verdict_latest (
    lane TEXT NOT NULL, verdict TEXT NOT NULL, checked_at INTEGER NOT NULL,
    PRIMARY KEY (lane, verdict)
) WITHOUT ROWID;
-- statement-breakpoint
INSERT INTO lane_health_verdict_latest SELECT lane, verdict, MAX(checked_at) FROM lane_health GROUP BY lane, verdict;
-- statement-breakpoint
CREATE TRIGGER lane_health_clocks_insert AFTER INSERT ON lane_health BEGIN 
    INSERT INTO lane_health_clocks (lane, checked_at, occurrences, previous_at)
    VALUES (NEW.lane, NEW.checked_at, 1,
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at < NEW.checked_at))
    ON CONFLICT(lane, checked_at) DO UPDATE SET occurrences = occurrences + 1;
    UPDATE lane_health_clocks SET previous_at = NEW.checked_at
    WHERE lane = NEW.lane AND checked_at = (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at > NEW.checked_at)
        AND previous_at IS NOT NEW.checked_at;

    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at) VALUES (NEW.lane, NEW.verdict, NEW.checked_at)
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;
-- statement-breakpoint
CREATE TRIGGER lane_health_clocks_delete AFTER DELETE ON lane_health BEGIN 
    UPDATE lane_health_clocks SET occurrences = occurrences - 1 WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
    DELETE FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
    UPDATE lane_health_clocks SET previous_at =
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
    WHERE lane = OLD.lane AND previous_at = OLD.checked_at
        AND NOT EXISTS (SELECT 1 FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);

    DELETE FROM lane_health_verdict_latest WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at;
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    SELECT lane, verdict, MAX(checked_at) FROM lane_health WHERE lane = OLD.lane AND verdict = OLD.verdict GROUP BY lane, verdict
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;
-- statement-breakpoint
CREATE TRIGGER lane_health_clocks_update AFTER UPDATE OF lane, checked_at ON lane_health
WHEN OLD.lane IS NOT NEW.lane OR OLD.checked_at IS NOT NEW.checked_at BEGIN 
    UPDATE lane_health_clocks SET occurrences = occurrences - 1 WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
    DELETE FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
    UPDATE lane_health_clocks SET previous_at =
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
    WHERE lane = OLD.lane AND previous_at = OLD.checked_at
        AND NOT EXISTS (SELECT 1 FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);

    INSERT INTO lane_health_clocks (lane, checked_at, occurrences, previous_at)
    VALUES (NEW.lane, NEW.checked_at, 1,
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at < NEW.checked_at))
    ON CONFLICT(lane, checked_at) DO UPDATE SET occurrences = occurrences + 1;
    UPDATE lane_health_clocks SET previous_at = NEW.checked_at
    WHERE lane = NEW.lane AND checked_at = (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at > NEW.checked_at)
        AND previous_at IS NOT NEW.checked_at;
END;
-- statement-breakpoint
CREATE TRIGGER lane_health_verdict_update AFTER UPDATE OF lane, verdict, checked_at ON lane_health
WHEN OLD.lane IS NOT NEW.lane OR OLD.verdict IS NOT NEW.verdict OR OLD.checked_at IS NOT NEW.checked_at BEGIN 
    DELETE FROM lane_health_verdict_latest WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at;
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    SELECT lane, verdict, MAX(checked_at) FROM lane_health WHERE lane = OLD.lane AND verdict = OLD.verdict GROUP BY lane, verdict
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;

    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at) VALUES (NEW.lane, NEW.verdict, NEW.checked_at)
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;
