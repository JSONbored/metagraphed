-- Preparation only. The migration runner owns the transaction.
-- Native RPC archive receipts bind source bytes to a committed Iceberg snapshot.
CREATE TABLE app.rpc_usage_archive_days (
    day date PRIMARY KEY,
    source_rows bigint NOT NULL CHECK (source_rows BETWEEN 0 AND 250000),
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    table_uuid text NOT NULL CHECK (table_uuid ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
    snapshot_id text NOT NULL CHECK (snapshot_id ~ '^[1-9][0-9]{0,18}$' AND snapshot_id::numeric <= 9223372036854775807),
    completed_at bigint NOT NULL CHECK (completed_at BETWEEN 0 AND 9007199254740991),
    remaining_rows bigint NOT NULL CHECK (remaining_rows BETWEEN 0 AND source_rows),
    remaining_sha256 text NOT NULL CHECK (remaining_sha256 ~ '^[a-f0-9]{64}$')
);

-- Both exporter and pruner call this function, in their own bounded transaction.
-- Binary send functions preserve negative zero and exact float8 bits. Text is
-- the raw JSON-quoted identity, before JSON parsing; a length prefix separates it.
-- Count and byte caps apply before client buffering or the ordered aggregation.
CREATE FUNCTION app.rpc_usage_day_fingerprint(p_day date)
RETURNS TABLE (source_rows bigint, source_sha256 text)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
    n bigint;
    bytes bigint;
    oversized bigint;
    fingerprint text;
    start_ms bigint := (extract(epoch FROM p_day::timestamp AT TIME ZONE 'UTC') * 1000)::bigint;
BEGIN
    IF p_day IS NULL OR p_day < DATE '1970-01-01' THEN
        RAISE EXCEPTION 'Invalid RPC archive day';
    END IF;
    WITH bounded AS MATERIALIZED (
        SELECT * FROM app.rpc_usage_events
        WHERE pool = 'public' AND occurred_at >= start_ms AND occurred_at < start_ms + 86400000
        ORDER BY event_id LIMIT 250001
    ), sized AS MATERIALIZED (
        SELECT *, octet_length(network_key) + octet_length(endpoint_key) +
            octet_length(provider_key) + 256 AS row_bytes FROM bounded
    ), hashed AS (
        SELECT event_id, row_bytes, CASE WHEN row_bytes <= 16384 THEN
            encode(sha256(uuid_send(event_id) || int8send(occurred_at) ||
            int4send(octet_length(pool)) || textsend(pool) ||
            int4send(octet_length(network_key)) || textsend(network_key) ||
            int4send(octet_length(endpoint_key)) || textsend(endpoint_key) ||
            int4send(octet_length(provider_key)) || textsend(provider_key) ||
            int4send(octet_length(cache)) || textsend(cache) || boolsend(ok) ||
            float8send(attempts) || float8send(latency_ms) || float8send(status) ||
            int8send(sample_weight)), 'hex') END AS row_hash FROM sized
    )
    SELECT count(*), coalesce(sum(row_bytes), 0),
        count(*) FILTER (WHERE row_bytes > 16384),
        encode(sha256(convert_to('metagraphed-rpc-public-day-v1:' || to_char(p_day, 'YYYY-MM-DD') || ':' ||
            coalesce(string_agg(row_hash, '' ORDER BY event_id), ''), 'UTF8')), 'hex')
    INTO n, bytes, oversized, fingerprint FROM hashed;
    IF n > 250000 OR bytes > 67108864 OR oversized > 0 THEN
        RAISE EXCEPTION 'RPC archive day exceeds its bounded snapshot budget';
    END IF;
    RETURN QUERY SELECT n, fingerprint;
END $$;

-- Called only after independently reading the committed Iceberg snapshot.
-- SHARE fences concurrent source writes until verification and receipt commit.
-- Existing receipts are immutable; late source changes never authorize reappend.
CREATE FUNCTION app.rpc_usage_record_archive(
    p_day date, p_rows bigint, p_sha256 text, p_table_uuid text,
    p_snapshot_id text, p_completed_at bigint
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE actual record; prior app.rpc_usage_archive_days%ROWTYPE;
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'RPC archive receipt requires READ COMMITTED';
    END IF;
    IF p_day >= (statement_timestamp() AT TIME ZONE 'UTC')::date THEN
        RAISE EXCEPTION 'RPC archive requires a complete UTC day';
    END IF;
    LOCK TABLE app.rpc_usage_events IN SHARE MODE;
    SELECT * INTO prior FROM app.rpc_usage_archive_days WHERE day=p_day FOR UPDATE;
    IF FOUND THEN
        IF prior.source_rows IS DISTINCT FROM p_rows OR prior.source_sha256 IS DISTINCT FROM p_sha256
            OR prior.table_uuid IS DISTINCT FROM p_table_uuid OR prior.snapshot_id IS DISTINCT FROM p_snapshot_id THEN
            RAISE EXCEPTION 'RPC archive receipt identity differs';
        END IF;
        RETURN;
    END IF;
    SELECT * INTO actual FROM app.rpc_usage_day_fingerprint(p_day);
    IF actual.source_rows IS DISTINCT FROM p_rows OR actual.source_sha256 IS DISTINCT FROM p_sha256 THEN
        RAISE EXCEPTION 'RPC archive source changed before receipt';
    END IF;
    INSERT INTO app.rpc_usage_archive_days VALUES
        (p_day,p_rows,p_sha256,p_table_uuid,p_snapshot_id,p_completed_at,p_rows,p_sha256)
        ON CONFLICT (day) DO NOTHING;
    -- Another source SHARE holder may have committed the same day while this
    -- insertion waited. Accept only the identical archive identity.
    SELECT * INTO prior FROM app.rpc_usage_archive_days WHERE day=p_day FOR UPDATE;
    IF prior.source_rows IS DISTINCT FROM p_rows OR prior.source_sha256 IS DISTINCT FROM p_sha256
        OR prior.table_uuid IS DISTINCT FROM p_table_uuid OR prior.snapshot_id IS DISTINCT FROM p_snapshot_id THEN
        RAISE EXCEPTION 'RPC archive receipt identity differs';
    END IF;
END $$;
