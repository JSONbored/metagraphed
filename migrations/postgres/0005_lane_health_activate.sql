-- Run transactionally with the external writer fence still held. Imported
-- current rows can choose any member of a tied maximum; preserve that choice.
LOCK TABLE app.lane_health, app.lane_health_current, app.lane_health_clocks,
    app.lane_health_verdict_latest IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM app.lane_health_current c
        LEFT JOIN app.lane_health h ON h.source_row_id = c._history_rowid
        WHERE h.source_row_id IS NULL OR
            ROW(c.lane, c.verdict, c.age_ms, c.detail, c.checked_at) IS DISTINCT FROM
            ROW(h.lane, h.verdict, h.age_ms, h.detail, h.checked_at) OR
            EXISTS (SELECT 1 FROM app.lane_health newer WHERE newer.lane = c.lane AND
                (newer.checked_at > c.checked_at OR (newer.checked_at = c.checked_at AND
                    CASE newer.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END >
                    CASE c.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END)))
    ) OR EXISTS (
        SELECT lane FROM app.lane_health EXCEPT SELECT lane FROM app.lane_health_current
    ) THEN
        RAISE EXCEPTION 'lane-health current projection differs' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        WITH counts AS (
            SELECT lane, checked_at, count(*) AS occurrences FROM app.lane_health GROUP BY lane, checked_at
        ), expected AS (
            SELECT lane, checked_at, occurrences,
                lag(checked_at) OVER (PARTITION BY lane ORDER BY checked_at) AS previous_at
            FROM counts
        )
        SELECT 1 FROM expected e FULL JOIN app.lane_health_clocks c USING (lane, checked_at)
        WHERE e.occurrences IS DISTINCT FROM c.occurrences OR e.previous_at IS DISTINCT FROM c.previous_at
    ) THEN
        RAISE EXCEPTION 'lane-health clock projection differs' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        WITH expected AS (
            SELECT lane, verdict, max(checked_at) AS checked_at FROM app.lane_health GROUP BY lane, verdict
        )
        SELECT 1 FROM expected e FULL JOIN app.lane_health_verdict_latest c USING (lane, verdict)
        WHERE e.checked_at IS DISTINCT FROM c.checked_at
    ) THEN
        RAISE EXCEPTION 'lane-health verdict projection differs' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE TRIGGER lane_health_lock BEFORE INSERT OR UPDATE OR DELETE ON app.lane_health
    FOR EACH STATEMENT EXECUTE FUNCTION app.lane_health_lock();
CREATE TRIGGER lane_health_identity BEFORE INSERT ON app.lane_health
    FOR EACH ROW EXECUTE FUNCTION app.lane_health_identity();
CREATE TRIGGER lane_health_maintain AFTER INSERT OR UPDATE OR DELETE ON app.lane_health
    FOR EACH ROW EXECUTE FUNCTION app.lane_health_maintain();
CREATE TRIGGER lane_health_clock_gap BEFORE INSERT OR UPDATE ON app.lane_health_clocks
    FOR EACH ROW EXECUTE FUNCTION app.lane_health_clock_gap();
