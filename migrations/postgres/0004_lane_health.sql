-- Load phase. Preserve original hidden SQLite rowids as explicit stable keys.
CREATE SCHEMA IF NOT EXISTS app;

-- SQLite subtraction stays integer until signed-int64 overflow, then converts
-- both operands to binary64 before subtracting. Store that binary64 result as
-- its exact numeric value, so import and subsequent trigger writes agree.
CREATE FUNCTION app.lane_health_gap(current_at bigint, prior_at bigint) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE
    difference numeric := current_at::numeric - prior_at::numeric;
    packed bytea;
    significand numeric;
    exponent integer;
    position integer;
BEGIN
    IF difference BETWEEN -9223372036854775808::numeric AND 9223372036854775807::numeric THEN
        RETURN difference;
    END IF;
    packed := float8send(current_at::double precision - prior_at::double precision);
    exponent := ((get_byte(packed, 0) & 127) << 4) | (get_byte(packed, 1) >> 4);
    significand := get_byte(packed, 1) & 15;
    FOR position IN 2..7 LOOP
        significand := significand * 256 + get_byte(packed, position);
    END LOOP;
    -- Overflow results have magnitude at least 2^63. Their binary64 fraction
    -- is therefore an integer multiple of 2^11, with no decimal rounding.
    difference := (4503599627370496::numeric + significand) * power(2::numeric, exponent - 1075);
    IF (get_byte(packed, 0) & 128) <> 0 THEN
        difference := -difference;
    END IF;
    RETURN difference;
END;
$$;

CREATE TABLE app.lane_health (
    source_row_id bigint PRIMARY KEY,
    lane text COLLATE "C" NOT NULL,
    verdict text COLLATE "C" NOT NULL,
    age_ms bigint,
    detail text,
    checked_at bigint NOT NULL,
    _source_tid text COLLATE "C" UNIQUE
);
CREATE TABLE app.lane_health_current (
    lane text COLLATE "C" PRIMARY KEY,
    verdict text COLLATE "C" NOT NULL,
    age_ms bigint,
    detail text,
    checked_at bigint NOT NULL,
    _history_rowid bigint NOT NULL
);
CREATE TABLE app.lane_health_clocks (
    lane text COLLATE "C" NOT NULL,
    checked_at bigint NOT NULL,
    occurrences bigint NOT NULL,
    previous_at bigint,
    gap numeric,
    PRIMARY KEY (lane, checked_at),
    CHECK (gap IS NOT DISTINCT FROM app.lane_health_gap(checked_at, previous_at))
);
CREATE TABLE app.lane_health_verdict_latest (
    lane text COLLATE "C" NOT NULL,
    verdict text COLLATE "C" NOT NULL,
    checked_at bigint NOT NULL,
    PRIMARY KEY (lane, verdict)
);

CREATE INDEX idx_lane_health_lane_checked ON app.lane_health (lane, checked_at DESC);
CREATE INDEX idx_lane_health_stale ON app.lane_health (checked_at DESC) WHERE verdict = 'stale';
CREATE INDEX idx_lane_health_time ON app.lane_health (checked_at, lane, verdict);
CREATE INDEX idx_lane_health_verdict ON app.lane_health (lane, verdict, checked_at);
CREATE INDEX idx_lane_health_gaps ON app.lane_health_clocks (lane, gap DESC NULLS LAST, checked_at DESC, previous_at);

-- The load schema accepts the original stored gap. After validation this trigger
-- supplies its generated-column semantics to every clock insert/update.
CREATE FUNCTION app.lane_health_clock_gap() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    NEW.gap := app.lane_health_gap(NEW.checked_at, NEW.previous_at);
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.lane_health_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    -- A statement trigger takes the history-wide lock before any tuple lock.
    -- This also fences rowid allocation against deletes and explicit row moves.
    PERFORM pg_advisory_xact_lock(1297304, 0);
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.lane_health_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE
    largest bigint;
    candidate bigint;
    attempt integer;
BEGIN
    IF NEW.source_row_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT MAX(source_row_id) INTO largest FROM app.lane_health;
    IF largest IS NULL THEN
        NEW.source_row_id := 1;
    ELSIF largest < 9223372036854775807 THEN
        NEW.source_row_id := largest + 1;
    ELSE
        -- SQLite's non-AUTOINCREMENT rowid allocation tries positive random
        -- identities when the largest signed rowid is present, at most 100 times.
        FOR attempt IN 1..100 LOOP
            candidate := floor(random()::numeric * 9223372036854775806)::bigint + 1;
            IF NOT EXISTS (SELECT 1 FROM app.lane_health WHERE source_row_id = candidate) THEN
                NEW.source_row_id := candidate;
                RETURN NEW;
            END IF;
        END LOOP;
        RAISE EXCEPTION 'lane-health could not allocate a free row identity' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.lane_health_maintain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE
    remove_clock boolean := TG_OP = 'DELETE';
    add_clock boolean := TG_OP = 'INSERT';
    remove_verdict boolean := TG_OP = 'DELETE';
    add_verdict boolean := TG_OP = 'INSERT';
BEGIN
    IF TG_OP = 'UPDATE' THEN
        remove_clock := OLD.lane IS DISTINCT FROM NEW.lane OR OLD.checked_at IS DISTINCT FROM NEW.checked_at;
        add_clock := remove_clock;
        remove_verdict := remove_clock OR OLD.verdict IS DISTINCT FROM NEW.verdict;
        add_verdict := remove_verdict;
    END IF;

    IF remove_clock THEN
        UPDATE app.lane_health_clocks SET occurrences = occurrences - 1
        WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
        DELETE FROM app.lane_health_clocks
        WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
        UPDATE app.lane_health_clocks SET previous_at =
            (SELECT MAX(checked_at) FROM app.lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
        WHERE lane = OLD.lane AND previous_at = OLD.checked_at
            AND NOT EXISTS (SELECT 1 FROM app.lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);
    END IF;
    IF add_clock THEN
        INSERT INTO app.lane_health_clocks (lane, checked_at, occurrences, previous_at)
        VALUES (NEW.lane, NEW.checked_at, 1,
            (SELECT MAX(checked_at) FROM app.lane_health_clocks WHERE lane = NEW.lane AND checked_at < NEW.checked_at))
        ON CONFLICT (lane, checked_at) DO UPDATE SET occurrences = app.lane_health_clocks.occurrences + 1;
        UPDATE app.lane_health_clocks SET previous_at = NEW.checked_at
        WHERE lane = NEW.lane AND checked_at =
            (SELECT MIN(checked_at) FROM app.lane_health_clocks WHERE lane = NEW.lane AND checked_at > NEW.checked_at)
            AND previous_at IS DISTINCT FROM NEW.checked_at;
    END IF;

    IF remove_verdict THEN
        DELETE FROM app.lane_health_verdict_latest
        WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at;
        INSERT INTO app.lane_health_verdict_latest (lane, verdict, checked_at)
        SELECT lane, verdict, MAX(checked_at) FROM app.lane_health
        WHERE lane = OLD.lane AND verdict = OLD.verdict GROUP BY lane, verdict
        ON CONFLICT (lane, verdict) DO UPDATE SET checked_at = EXCLUDED.checked_at
        WHERE EXCLUDED.checked_at > app.lane_health_verdict_latest.checked_at;
    END IF;
    IF add_verdict THEN
        INSERT INTO app.lane_health_verdict_latest (lane, verdict, checked_at)
        VALUES (NEW.lane, NEW.verdict, NEW.checked_at)
        ON CONFLICT (lane, verdict) DO UPDATE SET checked_at = EXCLUDED.checked_at
        WHERE EXCLUDED.checked_at > app.lane_health_verdict_latest.checked_at;
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Equal timestamp/severity retains the existing row, even when an
        -- explicitly imported key is numerically smaller.
        INSERT INTO app.lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
        VALUES (NEW.lane, NEW.verdict, NEW.age_ms, NEW.detail, NEW.checked_at, NEW.source_row_id)
        ON CONFLICT (lane) DO UPDATE SET verdict = EXCLUDED.verdict, age_ms = EXCLUDED.age_ms,
            detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at, _history_rowid = EXCLUDED._history_rowid
        WHERE EXCLUDED.checked_at > app.lane_health_current.checked_at OR
            (EXCLUDED.checked_at = app.lane_health_current.checked_at AND
                CASE EXCLUDED.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END >
                CASE app.lane_health_current.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END);
    ELSIF TG_OP = 'UPDATE' THEN
        DELETE FROM app.lane_health_current WHERE lane IN (OLD.lane, NEW.lane);
        INSERT INTO app.lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
        SELECT DISTINCT ON (lane) lane, verdict, age_ms, detail, checked_at, source_row_id
        FROM app.lane_health WHERE lane IN (OLD.lane, NEW.lane)
        ORDER BY lane, checked_at DESC,
            CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, source_row_id;
    ELSIF EXISTS (SELECT 1 FROM app.lane_health_current WHERE lane = OLD.lane AND _history_rowid = OLD.source_row_id) THEN
        DELETE FROM app.lane_health_current WHERE lane = OLD.lane;
        INSERT INTO app.lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
        SELECT lane, verdict, age_ms, detail, checked_at, source_row_id
        FROM app.lane_health WHERE lane = OLD.lane
        ORDER BY checked_at DESC, CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, source_row_id LIMIT 1;
    END IF;
    RETURN NULL;
END;
$$;
