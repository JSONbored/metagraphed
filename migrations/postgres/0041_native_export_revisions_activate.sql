-- Apply transactionally after the source tables and document views are loaded.
-- Each revision changes in the same transaction as its source, including direct
-- SQL, empty statements and TRUNCATE. Readers lock the exact source tables in
-- SHARE mode before reading revision and rows in one READ COMMITTED transaction.
-- A repeatable-read snapshot alone does not protect against concurrent TRUNCATE.
DO $$
DECLARE
    families CONSTANT text[] := ARRAY[
        'account_balances', 'account_identity', 'neurons', 'neuron_daily',
        'account_position_daily', 'subnet_snapshots', 'nominator_positions',
        'subnet_hyperparams', 'subnet_identity', 'subnet_ownership',
        'validator_nominator_counts', 'account_identity_history',
        'subnet_hyperparams_history', 'subnet_identity_history',
        'subnet_ownership_history', 'chain_concentration_daily',
        'compute_declarations', 'hotkey_alpha', 'revenue_observations',
        'subnet_deregistration_daily', 'surface_failure_daily',
        'surface_uptime_daily', 'treasury_readings', 'emission_flow_watch',
        'emission_gate_param_history', 'subnet_emission_enabled_history',
        'subnet_lifecycle', 'surface_history', 'tao_usd_index',
        'subnet_burn_history', 'providers', 'subnets', 'surfaces',
        'self_health_daily'
    ];
    family text;
    dependency text;
    dependencies text[];
    day_column text;
BEGIN
    -- Check the entire dependency set before installing any revision owners.
    FOREACH family IN ARRAY families LOOP
        dependencies := CASE WHEN family IN ('neurons', 'neuron_daily', 'account_position_daily')
            THEN ARRAY[family || '_documents', family || '_members'] ELSE ARRAY[family] END;
        FOREACH dependency IN ARRAY dependencies LOOP
            IF to_regclass(format('app.%I', dependency)) IS NULL THEN
                RAISE EXCEPTION 'native export dependency is missing: %', dependency USING ERRCODE = '55000';
            END IF;
        END LOOP;
    END LOOP;

    FOREACH family IN ARRAY families LOOP
        INSERT INTO app.native_export_revisions(family) VALUES (family);
        dependencies := CASE WHEN family IN ('neurons', 'neuron_daily', 'account_position_daily')
            THEN ARRAY[family || '_documents', family || '_members'] ELSE ARRAY[family] END;
        FOREACH dependency IN ARRAY dependencies LOOP
            EXECUTE format('CREATE TRIGGER native_export_revision
                BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON app.%I
                FOR EACH STATEMENT EXECUTE FUNCTION app.native_export_bump(%L)', dependency, family);
            IF family IN ('neuron_daily', 'account_position_daily', 'subnet_snapshots') THEN
                day_column := CASE WHEN dependency LIKE '%_documents' THEN 'day' ELSE 'snapshot_date' END;
                EXECUTE format('INSERT INTO app.native_export_revisions(family,revision)
                    SELECT %L || ''/'' || %I,0 FROM app.%I GROUP BY %I ON CONFLICT(family) DO NOTHING',
                    family,day_column,dependency,day_column);
                EXECUTE format('CREATE TRIGGER native_export_closed_day
                    AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW
                    EXECUTE FUNCTION app.native_export_day_bump(%L,%L)', dependency, family, day_column);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;
