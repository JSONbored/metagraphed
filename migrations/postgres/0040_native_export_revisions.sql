-- Native export revisions are runtime state. Original D1 revision rows remain
-- untouched source-custody evidence in app.archive_export_revisions.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.native_export_revisions (
    family text COLLATE "C" PRIMARY KEY,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991)
);

CREATE FUNCTION app.native_export_bump() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    changed integer;
    family_name text;
    next_revision bigint;
BEGIN
    UPDATE app.native_export_revisions SET revision = revision + 1
        WHERE family = ANY(TG_ARGV);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> TG_NARGS THEN
        RAISE EXCEPTION 'native export revision owner is incomplete' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'TRUNCATE' THEN
        FOREACH family_name IN ARRAY TG_ARGV LOOP
            SELECT revision INTO next_revision FROM app.native_export_revisions WHERE family=family_name;
            UPDATE app.native_export_revisions SET revision=next_revision
                WHERE starts_with(family,family_name || '/');
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.native_export_day_bump() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    old_day text;
    new_day text;
    selected_day text;
    current_revision bigint;
    today text := to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
    IF TG_OP <> 'INSERT' THEN old_day := to_jsonb(OLD)->>TG_ARGV[1]; END IF;
    IF TG_OP <> 'DELETE' THEN new_day := to_jsonb(NEW)->>TG_ARGV[1]; END IF;
    SELECT revision INTO STRICT current_revision FROM app.native_export_revisions WHERE family=TG_ARGV[0];
    FOR selected_day IN SELECT DISTINCT day FROM unnest(ARRAY[old_day,new_day]) AS days(day) WHERE day IS NOT NULL LOOP
        INSERT INTO app.native_export_revisions(family,revision)
            VALUES(TG_ARGV[0] || '/' || selected_day,CASE WHEN selected_day COLLATE "C" < today COLLATE "C" THEN current_revision ELSE 0 END)
            ON CONFLICT(family) DO UPDATE SET revision=CASE WHEN selected_day COLLATE "C" < today COLLATE "C"
                THEN current_revision ELSE app.native_export_revisions.revision END;
    END LOOP;
    RETURN NULL;
END;
$$;
