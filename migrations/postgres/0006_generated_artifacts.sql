CREATE SCHEMA IF NOT EXISTS app;

-- Text retains JSON number spellings, whitespace and escaped string content.
-- PostgreSQL json validates the object without jsonb numeric/Unicode coercion.
CREATE TABLE app.generated_artifacts (
    key text COLLATE "C" PRIMARY KEY,
    payload text NOT NULL CHECK (json_typeof(payload::json) = 'object'),
    updated_at text NOT NULL DEFAULT to_char(
        statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
);
