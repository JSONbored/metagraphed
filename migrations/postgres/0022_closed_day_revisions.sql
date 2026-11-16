-- Load original snapshots and revision rows before attaching closed-day effects.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.subnet_snapshots (
    netuid bigint NOT NULL,
    snapshot_date text COLLATE "C" NOT NULL,
    completeness_score bigint,
    surface_count bigint,
    endpoint_count bigint,
    monitored_count bigint,
    candidate_count bigint,
    captured_at bigint,
    validator_count bigint,
    miner_count bigint,
    total_stake_tao double precision,
    alpha_price_tao double precision,
    emission_share double precision,
    tao_in_pool_tao double precision,
    alpha_in_pool double precision,
    alpha_out_pool double precision,
    subnet_volume_tao double precision,
    tao_in_emission_tao double precision,
    excess_tao double precision,
    alpha_in_emission double precision,
    alpha_out_emission double precision,
    miner_burned_fraction double precision,
    emission_enabled boolean,
    subtoken_enabled boolean,
    first_emission_block bigint,
    pipeline_block bigint,
    pipeline_block_hash text,
    PRIMARY KEY (netuid, snapshot_date)
);
CREATE TABLE app.archive_export_revisions (
    table_name text COLLATE "C" PRIMARY KEY,
    revision numeric NOT NULL CHECK (revision >= 0
        AND revision NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
CREATE INDEX idx_subnet_snapshots_date_netuid ON app.subnet_snapshots (snapshot_date, netuid);

-- INTEGER affinity retains whole signed-int64 values. Other finite numeric
-- source values are binary64, including an increment that overflowed int64.
CREATE FUNCTION app.archive_revision_increment(value numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE
    packed bytea;
    exponent integer;
    significand numeric;
    result numeric;
    position integer;
BEGIN
    IF trunc(value) = value AND value BETWEEN -9223372036854775808::numeric AND 9223372036854775806::numeric THEN
        RETURN value + 1;
    END IF;
    packed := float8send(value::double precision + 1::double precision);
    exponent := ((get_byte(packed, 0) & 127) << 4) | (get_byte(packed, 1) >> 4);
    IF exponent = 2047 THEN
        RAISE EXCEPTION 'archive revision increment is not finite' USING ERRCODE = '22003';
    END IF;
    significand := get_byte(packed, 1) & 15;
    FOR position IN 2..7 LOOP
        significand := significand * 256 + get_byte(packed, position);
    END LOOP;
    IF exponent = 0 THEN
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
    IF (get_byte(packed, 0) & 128) <> 0 THEN
        result := -result;
    END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION app.archive_export_revision_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'closed-day writes require read committed isolation' USING ERRCODE = '25000';
    END IF;
    PERFORM pg_advisory_xact_lock(1297307, 0);
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.archive_export_closed_day() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE
    old_day text;
    new_day text;
    current_day text := to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
    IF TG_ARGV[1] = 'day' THEN
        IF TG_OP <> 'INSERT' THEN old_day := OLD.day; END IF;
        IF TG_OP <> 'DELETE' THEN new_day := NEW.day; END IF;
    ELSE
        IF TG_OP <> 'INSERT' THEN old_day := OLD.snapshot_date; END IF;
        IF TG_OP <> 'DELETE' THEN new_day := NEW.snapshot_date; END IF;
    END IF;
    IF old_day COLLATE "C" < current_day COLLATE "C" THEN
        INSERT INTO app.archive_export_revisions(table_name, revision)
            VALUES (TG_ARGV[0] || '/' || old_day, 1)
            ON CONFLICT (table_name) DO UPDATE
            SET revision = app.archive_revision_increment(app.archive_export_revisions.revision);
    END IF;
    IF new_day COLLATE "C" < current_day COLLATE "C" AND new_day IS DISTINCT FROM old_day THEN
        INSERT INTO app.archive_export_revisions(table_name, revision)
            VALUES (TG_ARGV[0] || '/' || new_day, 1)
            ON CONFLICT (table_name) DO UPDATE
            SET revision = app.archive_revision_increment(app.archive_export_revisions.revision);
    END IF;
    RETURN NULL;
END;
$$;
