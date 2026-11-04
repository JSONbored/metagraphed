-- Run transactionally while external application writers remain fenced.
LOCK TABLE app.rpc_accounts, app.github_accounts, app.api_keys, app.api_key_blocks,
    app.chain_alert_triggers, app.chain_alert_deliveries, app.watch_push_subscriptions,
    source_meta.state_sqlite_sequence IN ACCESS EXCLUSIVE MODE;

-- The load phase permits arbitrary table order. Activation validates the source
-- relationship before any nontransactional sequence advancement occurs.
ALTER TABLE app.chain_alert_deliveries
    ADD CONSTRAINT chain_alert_deliveries_trigger_id_fkey
    FOREIGN KEY (trigger_id) REFERENCES app.chain_alert_triggers(id) ON DELETE CASCADE;

DO $$
DECLARE
    sequence_tables CONSTANT text[] := ARRAY[
        'rpc_accounts', 'github_accounts', 'api_keys', 'api_key_blocks',
        'chain_alert_triggers', 'chain_alert_deliveries', 'watch_push_subscriptions'
    ];
    table_name text;
    imported_floor bigint;
    legacy_floor bigint;
    consumed_floor bigint;
    identity_floor bigint;
    floors bigint[] := ARRAY[]::bigint[];
    position integer;
BEGIN
    -- Validate every sequence before changing any of them. setval is not
    -- transactional, so an exhausted later table must not advance earlier ones.
    FOREACH table_name IN ARRAY sequence_tables LOOP
        EXECUTE format('SELECT max(id) FROM app.%I', table_name) INTO imported_floor;
        SELECT max(seq) INTO legacy_floor
            FROM source_meta.state_sqlite_sequence WHERE name = table_name;
        SELECT last_value INTO consumed_floor FROM pg_sequences
            WHERE schemaname = 'app' AND sequencename = table_name || '_id_seq';
        identity_floor := GREATEST(COALESCE(imported_floor, 0), COALESCE(legacy_floor, 0),
            COALESCE(consumed_floor, 0));
        IF identity_floor >= 9223372036854775807 THEN
            RAISE EXCEPTION 'account state identity has no next bigint value in %', table_name
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
