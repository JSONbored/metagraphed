-- Preparation only. The migration runner owns the transaction.
-- JSON string text preserves NUL and lone surrogates without PG JSON coercion.
CREATE TABLE app.rpc_usage_events (
    event_id uuid PRIMARY KEY,
    occurred_at bigint NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
    pool text NOT NULL CHECK (pool IN ('public', 'fullnode')),
    network_key text NOT NULL,
    endpoint_key text NOT NULL,
    provider_key text NOT NULL,
    cache text NOT NULL CHECK (cache IN ('hit', 'miss', 'bypass')),
    ok boolean NOT NULL,
    attempts double precision NOT NULL CHECK (attempts > '-Infinity'::float8 AND attempts < 'Infinity'::float8),
    latency_ms double precision NOT NULL CHECK (latency_ms >= 0 AND latency_ms < 'Infinity'::float8),
    status double precision NOT NULL CHECK (status > '-Infinity'::float8 AND status < 'Infinity'::float8),
    sample_weight bigint NOT NULL CHECK (sample_weight BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX idx_rpc_usage_pool_time ON app.rpc_usage_events (pool, occurred_at);
CREATE INDEX idx_rpc_usage_retention ON app.rpc_usage_events (occurred_at, event_id);
