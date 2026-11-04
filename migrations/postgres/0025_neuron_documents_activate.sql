-- Install after every original row and its pinned decoder receipt is loaded.
-- Use one transaction while native writers remain fenced.
LOCK TABLE app.neurons_documents, app.neurons_members, app.neuron_daily_documents,
    app.neuron_daily_members, app.account_position_daily_documents,
    app.account_position_daily_members, app._audit_neuron_docs_20260922,
    app._audit_neuron_members_20260922, app.neurons_capture_batches,
    app.neurons_passes, app.neuron_document_projections IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION app.sqlite_scalar_number(value json) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE
    packed bytea;
    exponent integer;
    significand numeric;
    result numeric;
    position integer;
BEGIN
    IF value->>0 = 'integer' THEN RETURN (value->>1)::numeric; END IF;
    IF value->>0 <> 'real' THEN RAISE EXCEPTION 'SQLite scalar is not numeric'; END IF;
    packed := decode(value->>1, 'hex');
    exponent := ((get_byte(packed, 0) & 127) << 4) | (get_byte(packed, 1) >> 4);
    significand := get_byte(packed, 1) & 15;
    FOR position IN 2..7 LOOP
        significand := significand * 256 + get_byte(packed, position);
    END LOOP;
    IF exponent = 2047 THEN
        IF significand <> 0 THEN RAISE EXCEPTION 'SQLite cannot store NaN'; END IF;
        RETURN CASE WHEN (get_byte(packed, 0) & 128) <> 0 THEN '-Infinity'::numeric ELSE 'Infinity'::numeric END;
    ELSIF exponent = 0 THEN
        exponent := -1074;
    ELSE
        significand := significand + 4503599627370496::numeric;
        exponent := exponent - 1075;
    END IF;
    IF exponent >= 0 THEN
        result := significand * power(2::numeric, exponent);
    ELSE
        result := significand * power(5::numeric, -exponent) * ('1e' || exponent)::numeric;
    END IF;
    IF (get_byte(packed, 0) & 128) <> 0 THEN result := -result; END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION app.sqlite_scalar_same(left_value json, right_value json) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, app AS $$
    SELECT CASE
        WHEN left_value IS NULL OR json_typeof(left_value) = 'null'
            THEN right_value IS NULL OR json_typeof(right_value) = 'null'
        WHEN right_value IS NULL OR json_typeof(right_value) = 'null' THEN false
        WHEN left_value->>0 IN ('integer', 'real') AND right_value->>0 IN ('integer', 'real')
            THEN app.sqlite_scalar_number(left_value) = app.sqlite_scalar_number(right_value)
        ELSE left_value->>0 = right_value->>0 AND left_value->>1 = right_value->>1
    END
$$;

CREATE FUNCTION app.neuron_document_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'neuron document writes require read committed isolation' USING ERRCODE = '25000';
    END IF;
    -- Same family lock as closed-day revisions, taken before all tuple locks.
    PERFORM pg_advisory_xact_lock(1297307, 0);
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.neuron_document_assert(source_name text, source_netuid bigint, source_day text, source_shard bigint)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE
    source_payload bytea;
BEGIN
    IF source_name = '_audit_neuron_docs_20260922' THEN
        SELECT payload INTO source_payload FROM app._audit_neuron_docs_20260922 WHERE netuid = source_netuid;
    ELSIF source_name IN ('neurons_documents', 'neuron_daily_documents', 'account_position_daily_documents') THEN
        EXECUTE format('SELECT payload FROM app.%I WHERE netuid=$1 AND day=$2 AND shard=$3', source_name)
            INTO source_payload USING source_netuid, source_day, source_shard;
    ELSE
        RAISE EXCEPTION 'Unknown neuron document family';
    END IF;
    IF source_payload IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM app.neuron_document_projections
        WHERE source_table = source_name AND netuid = source_netuid AND day = source_day
            AND shard = source_shard AND payload_sha256 = sha256(source_payload)
    ) THEN
        RAISE EXCEPTION 'Neuron document decoder receipt differs from source' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION app.neuron_document_receipt_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    IF TG_TABLE_NAME = 'neuron_document_projections' THEN
        IF TG_OP <> 'INSERT' THEN PERFORM app.neuron_document_assert(OLD.source_table, OLD.netuid, OLD.day, OLD.shard); END IF;
        IF TG_OP <> 'DELETE' THEN PERFORM app.neuron_document_assert(NEW.source_table, NEW.netuid, NEW.day, NEW.shard); END IF;
    ELSIF TG_TABLE_NAME = '_audit_neuron_docs_20260922' THEN
        IF TG_OP <> 'INSERT' THEN PERFORM app.neuron_document_assert(TG_TABLE_NAME, OLD.netuid, '', 0); END IF;
        IF TG_OP <> 'DELETE' THEN PERFORM app.neuron_document_assert(TG_TABLE_NAME, NEW.netuid, '', 0); END IF;
    ELSE
        IF TG_OP <> 'INSERT' THEN PERFORM app.neuron_document_assert(TG_TABLE_NAME, OLD.netuid, OLD.day, OLD.shard); END IF;
        IF TG_OP <> 'DELETE' THEN PERFORM app.neuron_document_assert(TG_TABLE_NAME, NEW.netuid, NEW.day, NEW.shard); END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.neuron_document_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE
    source_day text := '';
    source_shard bigint := 0;
BEGIN
    IF TG_TABLE_NAME <> '_audit_neuron_docs_20260922' THEN source_day := NEW.day; source_shard := NEW.shard; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM app.neuron_document_projections
        WHERE source_table = TG_TABLE_NAME AND netuid = NEW.netuid AND day = source_day
            AND shard = source_shard AND payload_sha256 = sha256(NEW.payload)
    ) THEN
        RAISE EXCEPTION 'Neuron document requires its current decoder receipt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.neuron_document_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.payload_sha256 = OLD.payload_sha256 AND (
        NEW.payload_json <> OLD.payload_json OR NEW.axon_values::text <> OLD.axon_values::text
        OR NEW.decoder_version <> OLD.decoder_version OR NEW.decoder_source_id <> OLD.decoder_source_id
    ) THEN
        RAISE EXCEPTION 'Neuron decoder receipt changed for identical bytes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.neuron_projected_axon(source_netuid bigint, source_day text, source_shard bigint, source_uid bigint)
RETURNS json LANGUAGE sql STABLE SET search_path = pg_catalog, app AS $$
    SELECT CASE WHEN json_typeof(entry->1) = 'null' THEN NULL ELSE entry->1 END
    FROM app.neuron_document_projections p CROSS JOIN LATERAL json_array_elements(p.axon_values) AS entries(entry)
    WHERE p.source_table = 'neuron_daily_documents' AND p.netuid = source_netuid
        AND p.day = source_day AND p.shard = source_shard AND entry->>0 = source_uid::text
    LIMIT 1
$$;

CREATE FUNCTION app.neuron_daily_axon_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    UPDATE app.neuron_daily_members m SET axon_index = app.neuron_projected_axon(m.netuid, m.snapshot_date, m.shard, m.uid), axon_indexed = true
    WHERE m.netuid = NEW.netuid AND m.snapshot_date = NEW.day AND m.shard = NEW.shard
        AND (TG_OP = 'INSERT' OR NOT m.axon_indexed
            OR NOT app.sqlite_scalar_same(m.axon_index, app.neuron_projected_axon(m.netuid, m.snapshot_date, m.shard, m.uid)));
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.neuron_daily_axon_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE
    present boolean;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.axon_indexed THEN RETURN NULL; END IF;
    SELECT EXISTS (SELECT 1 FROM app.neuron_daily_documents
        WHERE netuid = NEW.netuid AND day = NEW.snapshot_date AND shard = NEW.shard) INTO present;
    IF TG_OP = 'UPDATE' OR present THEN
        UPDATE app.neuron_daily_members SET
            axon_index = CASE WHEN present THEN app.neuron_projected_axon(NEW.netuid, NEW.snapshot_date, NEW.shard, NEW.uid) ELSE NULL END,
            axon_indexed = present
        WHERE netuid = NEW.netuid AND uid = NEW.uid AND snapshot_date = NEW.snapshot_date;
    END IF;
    RETURN NULL;
END;
$$;

DO $$
DECLARE
    document record;
    name text;
BEGIN
    FOR document IN
        SELECT 'neurons_documents'::text AS source_table, netuid, day, shard FROM app.neurons_documents
        UNION ALL SELECT 'neuron_daily_documents', netuid, day, shard FROM app.neuron_daily_documents
        UNION ALL SELECT 'account_position_daily_documents', netuid, day, shard FROM app.account_position_daily_documents
        UNION ALL SELECT '_audit_neuron_docs_20260922', netuid, '', 0 FROM app._audit_neuron_docs_20260922
    LOOP
        PERFORM app.neuron_document_assert(document.source_table, document.netuid, document.day, document.shard);
    END LOOP;
    IF EXISTS (
        SELECT 1 FROM app.neuron_daily_members m JOIN app.neuron_daily_documents d
            ON d.netuid = m.netuid AND d.day = m.snapshot_date AND d.shard = m.shard
        WHERE NOT m.axon_indexed OR NOT app.sqlite_scalar_same(m.axon_index,
            app.neuron_projected_axon(m.netuid, m.snapshot_date, m.shard, m.uid))
    ) THEN
        RAISE EXCEPTION 'Imported neuron axon projection differs' USING ERRCODE = '23514';
    END IF;
    FOREACH name IN ARRAY ARRAY['neurons_documents', 'neurons_members', 'neuron_daily_documents',
        'neuron_daily_members', 'account_position_daily_documents', 'account_position_daily_members',
        '_audit_neuron_docs_20260922', '_audit_neuron_members_20260922', 'neurons_capture_batches',
        'neurons_passes', 'neuron_document_projections'] LOOP
        EXECUTE format('CREATE TRIGGER neuron_document_lock BEFORE INSERT OR UPDATE OR DELETE ON app.%I
            FOR EACH STATEMENT EXECUTE FUNCTION app.neuron_document_lock()', name);
    END LOOP;
    FOREACH name IN ARRAY ARRAY['neurons_documents', 'neuron_daily_documents', 'account_position_daily_documents', '_audit_neuron_docs_20260922'] LOOP
        EXECUTE format('CREATE TRIGGER neuron_document_source_guard BEFORE INSERT OR UPDATE ON app.%I
            FOR EACH ROW EXECUTE FUNCTION app.neuron_document_source_guard()', name);
    END LOOP;
    FOREACH name IN ARRAY ARRAY['neurons_documents', 'neuron_daily_documents', 'account_position_daily_documents', '_audit_neuron_docs_20260922', 'neuron_document_projections'] LOOP
        EXECUTE format('CREATE CONSTRAINT TRIGGER neuron_document_receipt_check AFTER INSERT OR UPDATE OR DELETE ON app.%I
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.neuron_document_receipt_check()', name);
    END LOOP;
END;
$$;

CREATE TRIGGER neuron_document_receipt_immutable BEFORE UPDATE ON app.neuron_document_projections
    FOR EACH ROW EXECUTE FUNCTION app.neuron_document_receipt_immutable();

CREATE TRIGGER neuron_daily_axon_document_insert AFTER INSERT ON app.neuron_daily_documents
    FOR EACH ROW EXECUTE FUNCTION app.neuron_daily_axon_document();
CREATE TRIGGER neuron_daily_axon_document_update AFTER UPDATE OF payload ON app.neuron_daily_documents
    FOR EACH ROW EXECUTE FUNCTION app.neuron_daily_axon_document();
CREATE TRIGGER neuron_daily_axon_member_insert AFTER INSERT ON app.neuron_daily_members
    FOR EACH ROW EXECUTE FUNCTION app.neuron_daily_axon_member();
CREATE TRIGGER neuron_daily_axon_member_move AFTER UPDATE OF netuid, uid, snapshot_date, shard ON app.neuron_daily_members
    FOR EACH ROW EXECUTE FUNCTION app.neuron_daily_axon_member();
