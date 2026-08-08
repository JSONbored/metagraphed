-- Registry database on D1 (SQLite), translated from the self-hosted Postgres
-- instance behind registry-sync-api.
--
-- WHY THIS ONE FIRST. The registry database is 9,157 rows across four tables
-- (22 MB) -- roughly 450x under D1's 10 GB ceiling. It is a DIFFERENT database
-- from the 1.4 TB chain-data tier and is not blocked on anything, so it is the
-- honest pilot for the D1 migration: small enough to complete and verify
-- end-to-end, real enough that the schema/migration/rollback path gets
-- exercised before a larger tier depends on it.
--
-- FOUR TRANSLATIONS ARE NOT MECHANICAL. Each changes what callers must do, so
-- each is called out rather than left for someone to discover at runtime.
--
-- 1. jsonb -> TEXT. SQLite has no jsonb type. The `overlay` columns become TEXT
--    holding the same JSON. Any query using a Postgres JSON operator (->, ->>,
--    @>, jsonb_path_query) MUST be rewritten to json_extract()/json_each().
--    This is the single largest source of silent breakage in this migration:
--    `overlay->>'x'` is a syntax error in SQLite, so it fails loudly, but
--    `json_extract(overlay,'$.x')` returns NULL for a path that does not exist
--    rather than erroring -- so a wrong path reads as "no value", not "bad
--    query".
--
-- 2. uuid DEFAULT gen_random_uuid() -> TEXT with NO default. SQLite cannot
--    generate a UUID. `surfaces.id` must be supplied by the caller
--    (crypto.randomUUID() in the Worker). A row inserted without one will fail
--    the NOT NULL rather than silently taking a surrogate, which is the
--    behaviour we want: a surface with a fabricated id is worse than a failed
--    insert.
--
-- 3. bigint GENERATED ALWAYS AS IDENTITY -> INTEGER PRIMARY KEY AUTOINCREMENT.
--    In SQLite only INTEGER PRIMARY KEY aliases the rowid, which is what makes
--    autoincrement work. AUTOINCREMENT (rather than bare INTEGER PRIMARY KEY)
--    is deliberate: without it SQLite may REUSE the id of a deleted row, and
--    surface_history is an append-only audit trail where a reused id would
--    silently conflate two different events.
--
-- 4. timestamptz DEFAULT now() -> INTEGER epoch milliseconds. Matches the
--    BIGINT epoch-ms convention the chain-data schema already uses everywhere,
--    rather than introducing a second time representation. SQLite has no native
--    timestamp type, so the alternative (ISO strings) would sort correctly but
--    compare and arithmetic badly.
--
-- Foreign keys are declared and D1 enforces them, but note SQLite checks them
-- per-statement rather than deferring to commit, so a bulk load must insert
-- parents (subnets, providers) before children (surfaces, surface_history).

CREATE TABLE IF NOT EXISTS providers (
  id            TEXT    NOT NULL PRIMARY KEY,
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS subnets (
  netuid        INTEGER NOT NULL PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'community',
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS surfaces (
  -- No default: see translation (2). The caller supplies crypto.randomUUID().
  id            TEXT    NOT NULL PRIMARY KEY,
  subnet_netuid INTEGER NOT NULL,
  provider_id   TEXT,
  surface_key   TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  authority     TEXT    NOT NULL DEFAULT 'community',
  review_state  TEXT    NOT NULL DEFAULT 'community-submitted',
  -- SQLite has no BOOLEAN; 0/1 with a CHECK so a stray 2 cannot creep in and
  -- read as truthy.
  probe_eligible INTEGER NOT NULL DEFAULT 0 CHECK (probe_eligible IN (0, 1)),
  public_safe    INTEGER NOT NULL DEFAULT 1 CHECK (public_safe IN (0, 1)),
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (subnet_netuid, kind, url),
  FOREIGN KEY (provider_id) REFERENCES providers (id) ON DELETE RESTRICT,
  FOREIGN KEY (subnet_netuid) REFERENCES subnets (netuid) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS surface_history (
  -- AUTOINCREMENT, not bare INTEGER PRIMARY KEY: see translation (3).
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Intentionally NOT a foreign key, matching the source schema: history must
  -- survive the deletion of the surface it describes, which is the entire point
  -- of an audit trail.
  surface_id    TEXT,
  subnet_netuid INTEGER NOT NULL,
  action        TEXT    NOT NULL,
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  recorded_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_subnets_source ON subnets (source);
CREATE INDEX IF NOT EXISTS idx_surfaces_subnet ON surfaces (subnet_netuid);
CREATE INDEX IF NOT EXISTS idx_surfaces_provider ON surfaces (provider_id);
-- Partial index, same as the source. SQLite supports these, and it matters
-- here: probe_eligible rows are a small minority, so a full index would be
-- mostly dead weight on every write.
CREATE INDEX IF NOT EXISTS idx_surfaces_probe
  ON surfaces (probe_eligible, review_state) WHERE probe_eligible = 1;
CREATE INDEX IF NOT EXISTS idx_surface_history_subnet
  ON surface_history (subnet_netuid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_history_surface
  ON surface_history (surface_id, recorded_at DESC);
