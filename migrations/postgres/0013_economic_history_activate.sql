-- Run transactionally while external application writers remain fenced.
LOCK TABLE app.subnet_hyperparams_history, app.subnet_identity_history,
    app.subnet_ownership_history, app.subnet_lifecycle,
    app.subnet_emission_enabled_history, app.emission_flow_watch,
    app.emission_gate_param_history, source_meta.state_sqlite_sequence IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
    sequence_tables CONSTANT text[] := ARRAY[
        'subnet_hyperparams_history', 'subnet_identity_history', 'subnet_ownership_history',
        'subnet_lifecycle', 'subnet_emission_enabled_history', 'emission_flow_watch',
        'emission_gate_param_history'
    ];
    table_name text;
    imported_floor bigint;
    legacy_floor bigint;
    consumed_floor bigint;
    identity_floor bigint;
    floors bigint[] := ARRAY[]::bigint[];
    position integer;
BEGIN
    -- setval is not transactional. Validate all floors before advancing any.
    FOREACH table_name IN ARRAY sequence_tables LOOP
        EXECUTE format('SELECT max(id) FROM app.%I', table_name) INTO imported_floor;
        SELECT max(seq) INTO legacy_floor
            FROM source_meta.state_sqlite_sequence WHERE name = table_name;
        SELECT last_value INTO consumed_floor FROM pg_sequences
            WHERE schemaname = 'app' AND sequencename = table_name || '_id_seq';
        identity_floor := GREATEST(COALESCE(imported_floor, 0), COALESCE(legacy_floor, 0),
            COALESCE(consumed_floor, 0));
        IF identity_floor >= 9223372036854775807 THEN
            RAISE EXCEPTION 'economic history identity has no next bigint value in %', table_name
                USING ERRCODE = '22003';
        END IF;
        floors := array_append(floors, identity_floor);
    END LOOP;
    FOR position IN 1..array_length(sequence_tables, 1) LOOP
        PERFORM setval(pg_get_serial_sequence(format('app.%I', sequence_tables[position]), 'id'),
            GREATEST(floors[position], 1), floors[position] >= 1);
    END LOOP;
END;
$$;
