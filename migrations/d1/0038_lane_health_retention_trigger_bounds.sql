-- Next prefix on current main. Held 0038-0042 require coordinated renumbering;
-- see docs/lane-health-retention.md before merging either source sequence.
-- Functional prerequisites are 0001-0003. Keep historical migrations immutable.
-- Repair one successor by its timestamp key, as the existing insert trigger does.
DROP TRIGGER lane_health_clocks_delete;
-- statement-breakpoint
CREATE TRIGGER lane_health_clocks_delete AFTER DELETE ON lane_health BEGIN
    UPDATE lane_health_clocks SET occurrences = occurrences - 1
    WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
    DELETE FROM lane_health_clocks
    WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
    UPDATE lane_health_clocks SET previous_at =
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
    WHERE lane = OLD.lane AND checked_at =
        (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at > OLD.checked_at)
        AND previous_at = OLD.checked_at
        AND NOT EXISTS (SELECT 1 FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);
END;
-- statement-breakpoint
-- Only removing the last tie at the selected verdict timestamp needs a refresh.
CREATE TRIGGER lane_health_verdict_delete AFTER DELETE ON lane_health
WHEN EXISTS (SELECT 1 FROM lane_health_verdict_latest
        WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at)
    AND NOT EXISTS (SELECT 1 FROM lane_health
        WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at) BEGIN
    DELETE FROM lane_health_verdict_latest WHERE lane = OLD.lane AND verdict = OLD.verdict;
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    SELECT lane, verdict, checked_at FROM lane_health
    WHERE lane = OLD.lane AND verdict = OLD.verdict ORDER BY checked_at DESC LIMIT 1;
END;
-- statement-breakpoint
DROP TRIGGER lane_health_clocks_update;
-- statement-breakpoint
CREATE TRIGGER lane_health_clocks_update AFTER UPDATE OF lane, checked_at ON lane_health
WHEN OLD.lane IS NOT NEW.lane OR OLD.checked_at IS NOT NEW.checked_at BEGIN
    UPDATE lane_health_clocks SET occurrences = occurrences - 1
    WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
    DELETE FROM lane_health_clocks
    WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
    UPDATE lane_health_clocks SET previous_at =
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
    WHERE lane = OLD.lane AND checked_at =
        (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at > OLD.checked_at)
        AND previous_at = OLD.checked_at
        AND NOT EXISTS (SELECT 1 FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);

    INSERT INTO lane_health_clocks (lane, checked_at, occurrences, previous_at)
    VALUES (NEW.lane, NEW.checked_at, 1,
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at < NEW.checked_at))
    ON CONFLICT(lane, checked_at) DO UPDATE SET occurrences = occurrences + 1;
    UPDATE lane_health_clocks SET previous_at = NEW.checked_at
    WHERE lane = NEW.lane AND checked_at =
        (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at > NEW.checked_at)
        AND previous_at IS NOT NEW.checked_at;
END;
-- statement-breakpoint
DROP TRIGGER lane_health_verdict_update;
-- statement-breakpoint
CREATE TRIGGER lane_health_verdict_update AFTER UPDATE OF lane, verdict, checked_at ON lane_health
WHEN (OLD.lane IS NOT NEW.lane OR OLD.verdict IS NOT NEW.verdict OR OLD.checked_at IS NOT NEW.checked_at)
    AND EXISTS (SELECT 1 FROM lane_health_verdict_latest
        WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at)
    AND NOT EXISTS (SELECT 1 FROM lane_health
        WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at) BEGIN
    DELETE FROM lane_health_verdict_latest WHERE lane = OLD.lane AND verdict = OLD.verdict;
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    SELECT lane, verdict, checked_at FROM lane_health
    WHERE lane = OLD.lane AND verdict = OLD.verdict ORDER BY checked_at DESC LIMIT 1;
END;
-- statement-breakpoint
-- Kept separate from the conditional old-key repair. Either execution order
-- yields the same maxima, including moving a latest row earlier or later.
CREATE TRIGGER lane_health_verdict_update_new AFTER UPDATE OF lane, verdict, checked_at ON lane_health
WHEN OLD.lane IS NOT NEW.lane OR OLD.verdict IS NOT NEW.verdict OR OLD.checked_at IS NOT NEW.checked_at BEGIN
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    VALUES (NEW.lane, NEW.verdict, NEW.checked_at)
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;
