-- Run transactionally after all document/member load tables and original
-- revisions exist. Missing dependencies fail before any trigger is installed.
LOCK TABLE app.subnet_snapshots, app.neuron_daily_documents, app.neuron_daily_members,
    app.account_position_daily_documents, app.account_position_daily_members,
    app.archive_export_revisions IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
    dependency record;
    operation text;
BEGIN
    FOR dependency IN SELECT * FROM (VALUES
        ('subnet_snapshots', 'subnet_snapshots', 'snapshot_date'),
        ('neuron_daily_documents', 'neuron_daily', 'day'),
        ('neuron_daily_members', 'neuron_daily', 'snapshot_date'),
        ('account_position_daily_documents', 'account_position_daily', 'day'),
        ('account_position_daily_members', 'account_position_daily', 'snapshot_date')
    ) AS dependencies(table_name, export_family, day_column) LOOP
        EXECUTE format('CREATE TRIGGER archive_export_revision_lock BEFORE INSERT OR UPDATE OR DELETE ON app.%I
            FOR EACH STATEMENT EXECUTE FUNCTION app.archive_export_revision_lock()', dependency.table_name);
        FOREACH operation IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
            EXECUTE format('CREATE TRIGGER %I AFTER %s ON app.%I
                FOR EACH ROW EXECUTE FUNCTION app.archive_export_closed_day(%L, %L)',
                dependency.table_name || '_closed_day_' || lower(operation), operation,
                dependency.table_name, dependency.export_family, dependency.day_column);
        END LOOP;
    END LOOP;
END;
$$;
