-- Run transactionally while external application writers remain fenced.
LOCK TABLE app.account_identity_history, source_meta.state_sqlite_sequence IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM (
            SELECT max(id) AS value FROM app.account_identity_history
            UNION ALL SELECT max(seq) FROM source_meta.state_sqlite_sequence WHERE name = 'account_identity_history'
            UNION ALL SELECT last_value FROM pg_sequences
                WHERE schemaname = 'app' AND sequencename = 'account_identity_history_id_seq'
        ) AS high_water WHERE value >= 9223372036854775807
    ) THEN
        RAISE EXCEPTION 'account identity history has no next bigint value' USING ERRCODE = '22003';
    END IF;
END;
$$;
SELECT setval(pg_get_serial_sequence('app.account_identity_history', 'id'), GREATEST(floor, 1), floor >= 1)
FROM (
    SELECT GREATEST(
        COALESCE((SELECT max(id) FROM app.account_identity_history), 0),
        COALESCE((SELECT max(seq) FROM source_meta.state_sqlite_sequence WHERE name = 'account_identity_history'), 0),
        COALESCE((SELECT last_value FROM pg_sequences
            WHERE schemaname = 'app' AND sequencename = 'account_identity_history_id_seq'), 0)
    ) AS floor
) AS identity_floor;
