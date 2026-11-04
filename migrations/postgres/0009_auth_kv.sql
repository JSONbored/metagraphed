-- Application control, registry and pending-auth KV. This family is separate
-- from source-imported app/retained data. The native OAuth adapter owns the
-- oauth-provider namespace and serializes its grant transitions separately.
CREATE SCHEMA auth;
CREATE TABLE auth.kv_entries (
    namespace text COLLATE "C" NOT NULL,
    key bytea NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 512),
    value bytea NOT NULL CHECK (octet_length(value) <= 26214400),
    metadata text CHECK (metadata IS NULL OR octet_length(metadata) <= 1024),
    expires_at bigint CHECK (expires_at IS NULL OR expires_at >= 0),
    PRIMARY KEY (namespace, key)
);
CREATE INDEX kv_entries_expiry ON auth.kv_entries (namespace, expires_at)
    WHERE expires_at IS NOT NULL;
