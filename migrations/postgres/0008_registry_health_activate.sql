-- Explicit post-load phase. Run transactionally while external writers remain fenced.
LOCK TABLE app.surface_history, source_meta.state_sqlite_sequence,
    app.surface_status IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM (
            SELECT max(id) AS value FROM app.surface_history
            UNION ALL SELECT max(seq) FROM source_meta.state_sqlite_sequence WHERE name = 'surface_history'
            UNION ALL SELECT last_value FROM pg_sequences
                WHERE schemaname = 'app' AND sequencename = 'surface_history_id_seq'
        ) AS high_water WHERE value >= 9223372036854775807
    ) THEN
        RAISE EXCEPTION 'surface history identity has no next bigint value' USING ERRCODE = '22003';
    END IF;
END;
$$;
SELECT setval(pg_get_serial_sequence('app.surface_history', 'id'), GREATEST(floor, 1), floor >= 1)
FROM (
    SELECT GREATEST(
        COALESCE((SELECT max(id) FROM app.surface_history), 0),
        COALESCE((SELECT max(seq) FROM source_meta.state_sqlite_sequence WHERE name = 'surface_history'), 0),
        COALESCE((SELECT last_value FROM pg_sequences
            WHERE schemaname = 'app' AND sequencename = 'surface_history_id_seq'), 0)
    ) AS floor
) AS identity_floor;

CREATE TRIGGER surface_status_lock BEFORE INSERT OR UPDATE OR DELETE ON app.surface_status
    FOR EACH STATEMENT EXECUTE FUNCTION app.surface_status_lock();
CREATE TRIGGER surface_status_alias_insert BEFORE INSERT ON app.surface_status
    FOR EACH ROW EXECUTE FUNCTION app.surface_status_alias_insert();
