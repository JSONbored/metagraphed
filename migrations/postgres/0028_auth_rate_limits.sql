-- Requires 0009_auth_kv.sql and 0010_account_state.sql. Explicit native counters; no Worker
-- binding or production source selection is changed by this declaration.
CREATE TABLE auth.rate_limit_policies (
    binding text COLLATE "C" PRIMARY KEY CHECK (binding ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    request_limit integer NOT NULL CHECK (request_limit > 0),
    period_seconds integer NOT NULL CHECK (period_seconds IN (10, 60))
);
CREATE FUNCTION auth.reject_rate_limit_policy_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Native rate policies are immutable; use an explicit migration';
END
$$;
CREATE TRIGGER rate_limit_policies_immutable
BEFORE UPDATE OR DELETE ON auth.rate_limit_policies
FOR EACH ROW EXECUTE FUNCTION auth.reject_rate_limit_policy_change();

CREATE TABLE auth.rate_limit_buckets (
    binding text COLLATE "C" NOT NULL REFERENCES auth.rate_limit_policies(binding),
    key bytea NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1024),
    bucket_second bigint NOT NULL CHECK (bucket_second >= 0),
    requests integer NOT NULL CHECK (requests > 0),
    expires_at bigint NOT NULL CHECK (expires_at > bucket_second),
    PRIMARY KEY (binding, key, bucket_second)
);
CREATE INDEX rate_limit_buckets_expiry ON auth.rate_limit_buckets (expires_at);

-- D1 binds JavaScript numbers as REAL; INTEGER affinity still permits
-- fractional values and integral binary64 values outside signed int64. Keep
-- exact numeric source values. For units_spent the storage-sensitive import
-- codec keeps INTEGER at scale zero and marks integral REAL values with .0;
-- the composite-key UPSERT's arithmetic depends on that source storage kind.
ALTER TABLE app.api_quota_daily
    ALTER COLUMN account_id TYPE numeric,
    ALTER COLUMN units_spent TYPE numeric;
