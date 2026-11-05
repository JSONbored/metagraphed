-- Preparation only. The migration runner owns the transaction.
-- Public rows require a matching archive receipt. Fullnode retains its existing
-- age-based policy because it is explicitly outside the public archive series.
CREATE TABLE app.rpc_usage_prune_state (
    singleton boolean PRIMARY KEY CHECK (singleton),
    after_day date
);
INSERT INTO app.rpc_usage_prune_state(singleton) VALUES (true);

CREATE FUNCTION app.rpc_usage_prune(p_cutoff bigint, p_limit integer DEFAULT 10000)
RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
    removed integer := 0;
    batch integer;
    candidate record;
    actual record;
    cursor_day date;
BEGIN
    IF p_cutoff IS NULL OR p_cutoff < 0 OR p_cutoff > 9007199254740991
        OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
        RAISE EXCEPTION 'Invalid RPC retention bound';
    END IF;
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'RPC retention requires READ COMMITTED';
    END IF;
    -- Same source-first order as the archive recorder. This serializes pruners
    -- and prevents a concurrent insert/update between fingerprint and deletion.
    LOCK TABLE app.rpc_usage_events IN SHARE ROW EXCLUSIVE MODE;
    DELETE FROM app.rpc_usage_events WHERE event_id IN (
        SELECT event_id FROM app.rpc_usage_events
        WHERE pool='fullnode' AND occurred_at < p_cutoff
        ORDER BY occurred_at,event_id LIMIT p_limit
    );
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed = p_limit THEN RETURN removed; END IF;

    -- Rotate a durable cursor across at most eight eligible receipt days.
    -- Stale days remain intact but cannot starve later qualified days forever.
    SELECT after_day INTO cursor_day FROM app.rpc_usage_prune_state
        WHERE singleton FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RPC retention cursor is missing'; END IF;
    FOR candidate IN
        SELECT r.* FROM app.rpc_usage_archive_days r
        WHERE r.remaining_rows > 0
          AND (extract(epoch FROM r.day::timestamp AT TIME ZONE 'UTC') * 1000)::bigint < p_cutoff
          AND EXISTS (SELECT 1 FROM app.rpc_usage_events e WHERE e.pool='public'
              AND e.occurred_at >= (extract(epoch FROM r.day::timestamp AT TIME ZONE 'UTC') * 1000)::bigint
              AND e.occurred_at < (extract(epoch FROM r.day::timestamp AT TIME ZONE 'UTC') * 1000)::bigint + 86400000
              AND e.occurred_at < p_cutoff)
        ORDER BY coalesce(r.day <= cursor_day, false), r.day LIMIT 8 FOR UPDATE
    LOOP
        UPDATE app.rpc_usage_prune_state SET after_day=candidate.day WHERE singleton;
        SELECT * INTO actual FROM app.rpc_usage_day_fingerprint(candidate.day);
        IF actual.source_rows IS DISTINCT FROM candidate.remaining_rows
            OR actual.source_sha256 IS DISTINCT FROM candidate.remaining_sha256 THEN
            CONTINUE;
        END IF;
        DELETE FROM app.rpc_usage_events WHERE event_id IN (
            SELECT event_id FROM app.rpc_usage_events
            WHERE pool='public' AND occurred_at < p_cutoff
              AND occurred_at >= (extract(epoch FROM candidate.day::timestamp AT TIME ZONE 'UTC') * 1000)::bigint
              AND occurred_at < (extract(epoch FROM candidate.day::timestamp AT TIME ZONE 'UTC') * 1000)::bigint + 86400000
            ORDER BY event_id LIMIT (p_limit - removed)
        );
        GET DIAGNOSTICS batch = ROW_COUNT;
        -- VOLATILE gives this post-delete call a new command snapshot. Counts
        -- and fingerprints advance in the same transaction as physical deletion.
        SELECT * INTO actual FROM app.rpc_usage_day_fingerprint(candidate.day);
        UPDATE app.rpc_usage_archive_days
        SET remaining_rows=actual.source_rows, remaining_sha256=actual.source_sha256
        WHERE day=candidate.day;
        removed := removed + batch;
        EXIT WHEN removed = p_limit;
    END LOOP;
    RETURN removed;
END $$;
