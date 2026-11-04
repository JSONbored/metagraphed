-- Source-load phase: retain each SQLite rowid before native usage writers run.
-- The import's row-identity sidecar supplies this value; never derive it from
-- export order or a PostgreSQL sequence. Source rowids may be signed int64.
ALTER TABLE app.api_key_usage_daily
    ADD COLUMN source_row_id bigint NOT NULL,
    ADD CONSTRAINT api_key_usage_daily_source_row_id_key UNIQUE (source_row_id);
ALTER TABLE app.api_usage_rollup
    ADD COLUMN source_row_id bigint NOT NULL,
    ADD CONSTRAINT api_usage_rollup_source_row_id_key UNIQUE (source_row_id);
