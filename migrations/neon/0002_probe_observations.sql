-- The probe-derived observation tables (#9787).
--
-- WHY THESE FOUR, AND NOT THE WHOLE surface_* FAMILY. `surface_*` looks like
-- one family and is two, split by who writes it:
--
--   PROBE-DERIVED   surface_checks, surface_status, surface_uptime_daily,
--                   surface_failure_daily.
--                   Written by the health prober every sweep
--                   (src/observations-d1.ts). Live, growing, and the reason
--                   this file exists -- surface_checks alone is 1,349,625 rows,
--                   86% of everything still on D1.
--
--   REGISTRY-SIDE   surfaces, surface_history. Written by
--                   workers/registry-sync-api.ts, which #9779 established has
--                   NO CALLER -- its only sync path was a retired GitHub
--                   Actions lane, and surface_history has been frozen since
--                   2026-08-02. Moving a frozen table is not migration, it is
--                   relocation, and `surfaces` additionally carries FOREIGN
--                   KEYs to `subnets` and `providers` which are themselves
--                   still on D1. They come after #9779 has a writer again.
--
-- surface_failure_daily is here too, and its uniqueness needed the server
-- version READ rather than assumed. D1 spells it
-- `(day, ifnull(netuid, -1), kind, classification)` -- netuid is nullable
-- because a registry-level surface belongs to no subnet, and the ifnull is
-- what stops two such rows counting as distinct. Postgres's equivalent is
-- NULLS NOT DISTINCT, which requires server >= 15; this project reports
-- **pg_version 18** (Neon API, 2026-08-07), so it is available. The
-- alternatives were both wrong: a plain unique index treats NULLs as distinct
-- and would admit duplicates D1 rejects, and an expression index on
-- COALESCE(netuid, -1) would work but makes the reconciler's conflict target
-- an expression rather than a column list, which its keyset invariant cannot
-- express.
--
-- TYPE MAPPING, unchanged from 0001 and verified against D1's own DDL:
--
--   INTEGER CHECK (x IN (0,1))   -> BOOLEAN            the mirror writes real
--                                                      JS booleans; Postgres
--                                                      rejects `boolean = 1`
--   INTEGER (epoch milliseconds) -> BIGINT             does not fit in int4
--   INTEGER (counts, netuid)     -> INTEGER
--   REAL                         -> DOUBLE PRECISION
--   TEXT                         -> TEXT
--
-- `day` stays TEXT 'YYYY-MM-DD' for the same reason `snapshot_date` did in
-- 0001: the reconciler compares the two stores on it, and lexicographic order
-- IS date order for ISO dates on both sides. A DATE here would round-trip
-- differently from D1's TEXT.

-- ---------------------------------------------------------------------------
-- surface_checks -- the raw probe log, 1,349,625 rows over a ~27-day window
-- ---------------------------------------------------------------------------
--
-- D1 DECLARES NO PRIMARY KEY. This one does, and the difference is deliberate:
-- the reconciler needs a conflict target or its copy is not idempotent, and a
-- retried page would duplicate rows rather than settle.
--
-- (surface_id, checked_at) IS SOUND, MEASURED RATHER THAN ASSUMED. Against
-- production 2026-08-07:
--
--     COUNT(*)                                    1,349,625
--     COUNT(DISTINCT surface_id || checked_at)    1,349,625
--     rows with a NULL surface_id                         0
--
-- and structurally, not just today: the writer binds `surface_id: surface.id`
-- (src/health-probe-core.ts) where `surfaces.id` is TEXT NOT NULL PRIMARY KEY,
-- so a null cannot arrive without the registry itself being broken. One probe
-- per surface per millisecond is what a sweep produces.
--
-- The NOT NULL on surface_id is therefore a tightening D1 permits and the
-- producer never exercises. If one ever did arrive the insert fails and the
-- lane records it -- which is the right failure, and louder than D1's, where
-- the row would land unkeyed and quietly break the rollups that group on it.
CREATE TABLE IF NOT EXISTS surface_checks (
  surface_id     TEXT    NOT NULL,
  surface_key    TEXT,
  netuid         INTEGER,
  kind           TEXT,
  status         TEXT,
  classification TEXT,
  latency_ms     INTEGER,
  status_code    INTEGER,
  ok             BOOLEAN,
  checked_at     BIGINT  NOT NULL,
  PRIMARY KEY (surface_id, checked_at)
);

-- D1 also carries idx_surface_checks_surface_time (surface_id, checked_at
-- DESC). It is NOT recreated here: the primary key's index covers the same
-- columns in the same order, and Postgres scans an index backwards at the same
-- cost as forwards, so a second copy would be ~1.35M rows of duplicate index
-- for no plan the planner cannot already reach.
CREATE INDEX IF NOT EXISTS idx_surface_checks_time
  ON surface_checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_checks_netuid_time
  ON surface_checks (netuid, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_checks_key_time
  ON surface_checks (surface_key, checked_at DESC);

-- ---------------------------------------------------------------------------
-- surface_status -- latest status per surface, 640 rows, updated in place
-- ---------------------------------------------------------------------------
--
-- The partial unique index is reproduced exactly. Postgres supports the same
-- `WHERE surface_key IS NOT NULL` predicate SQLite does, and the D1 writer's
-- upsert names BOTH conflict targets -- ON CONFLICT(surface_key) WHERE
-- surface_key IS NOT NULL, then ON CONFLICT(surface_id) -- so dropping the
-- predicate would change which of the two the planner matches.
CREATE TABLE IF NOT EXISTS surface_status (
  surface_id           TEXT    PRIMARY KEY,
  surface_key          TEXT,
  netuid               INTEGER,
  kind                 TEXT,
  url                  TEXT,
  provider             TEXT,
  status               TEXT,
  classification       TEXT,
  latency_ms           INTEGER,
  status_code          INTEGER,
  last_checked         BIGINT,
  last_ok              BIGINT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_status_key
  ON surface_status (surface_key) WHERE surface_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surface_status_netuid
  ON surface_status (netuid);

-- ---------------------------------------------------------------------------
-- surface_uptime_daily -- the day rollup, 14,520 rows
-- ---------------------------------------------------------------------------
--
-- D1 declares PRIMARY KEY (surface_id, day) over a column typed plain TEXT,
-- which in SQLite still admits NULL -- a genuine quirk of every non-INTEGER
-- primary key there. Postgres does not, so the PK forces NOT NULL. Measured
-- before relying on it: 14,520 rows, zero NULL surface_id, zero NULL day.
CREATE TABLE IF NOT EXISTS surface_uptime_daily (
  surface_id      TEXT    NOT NULL,
  surface_key     TEXT,
  netuid          INTEGER,
  day             TEXT    NOT NULL,
  samples         INTEGER NOT NULL,
  ok_count        INTEGER NOT NULL,
  uptime_ratio    DOUBLE PRECISION,
  avg_latency_ms  INTEGER,
  status          TEXT,
  latency_samples INTEGER,
  p50_latency_ms  INTEGER,
  p95_latency_ms  INTEGER,
  p99_latency_ms  INTEGER,
  updated_at      BIGINT,
  PRIMARY KEY (surface_id, day)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_uptime_daily_key_day
  ON surface_uptime_daily (surface_key, day) WHERE surface_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_netuid_day
  ON surface_uptime_daily (netuid, day DESC);

-- ---------------------------------------------------------------------------
-- surface_failure_daily -- failure-mix rollup, 7,663 rows
-- ---------------------------------------------------------------------------
--
-- D1 declares NO primary key here either; uniqueness lives entirely in
-- ux_surface_failure_daily_key. Reproduced below with NULLS NOT DISTINCT so a
-- NULL netuid collides with another NULL netuid exactly as D1's
-- ifnull(netuid, -1) makes it. Measured before relying on the shape: 7,663
-- rows, 7,663 distinct (day, ifnull(netuid,-1), kind, classification), and
-- zero NULL netuid TODAY -- but the column stays nullable because the schema
-- comment says a registry-level surface has no subnet, and a constraint should
-- match the design rather than the current sample.
CREATE TABLE IF NOT EXISTS surface_failure_daily (
  day            TEXT    NOT NULL,
  netuid         INTEGER,
  kind           TEXT    NOT NULL,
  classification TEXT    NOT NULL,
  checks         INTEGER NOT NULL,
  updated_at     BIGINT  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_surface_failure_daily_key
  ON surface_failure_daily (day, netuid, kind, classification) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_surface_failure_daily_day
  ON surface_failure_daily (day DESC, netuid);
