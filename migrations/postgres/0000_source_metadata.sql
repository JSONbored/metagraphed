-- Original source bookkeeping stays separate from PostgreSQL migration state.
-- Profile-qualified tables preserve each source's own IDs and duplicate rows.
CREATE SCHEMA source_meta;

CREATE TABLE source_meta.state_d1_migrations (
  id bigint PRIMARY KEY,
  name text COLLATE "C" UNIQUE,
  applied_at text COLLATE "C" NOT NULL
);

CREATE TABLE source_meta.retained_d1_migrations (
  id bigint PRIMARY KEY,
  name text COLLATE "C" UNIQUE,
  applied_at text COLLATE "C" NOT NULL
);

-- SQLite's internal sqlite_sequence table has no primary/unique constraint.
-- Keep its exact rows, including a sequence above the largest retained ID.
CREATE TABLE source_meta.state_sqlite_sequence (
  name text COLLATE "C",
  seq bigint
);

CREATE TABLE source_meta.retained_sqlite_sequence (
  name text COLLATE "C",
  seq bigint
);
