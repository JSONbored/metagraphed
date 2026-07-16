-- metagraphed-registry — target Postgres schema for the registry serving DB
--
-- Applies to a DEDICATED, SEPARATE Postgres instance from schema.sql's chain
-- sink (different container, different port, different credentials,
-- different host resources) -- deliberately not the same database. The
-- chain-indexer's Postgres holds blocks/extrinsics/neurons at a completely
-- different scale (hundreds of GB, growing) and operational tempo (written
-- continuously by the indexer) from this one (a few thousand rows, written
-- on contributor-PR-merge cadence). Keeping them fully independent means
-- either can be restarted, backed up, or migrated without touching the
-- other, and a chain-indexer incident can't take the registry down with it.
--
-- The single serving source of truth for EVERY subnet/provider/surface fact
-- this system knows about, regardless of where the fact came from -- both
-- the human-authored, PR-reviewed content in registry/subnets/*.json +
-- registry/providers/*.json (the Gittensory Gate's review surface -- nothing
-- about how a contributor submits or how the gate judges a PR changes) AND
-- the machine-discovered/promoted content that scripts/generated-overlays.mjs
-- computes from the native chain snapshot + candidate verification (subnets
-- with no manual file yet, and auto-promoted candidate surfaces layered onto
-- existing manual subnets). Both write paths upsert into the SAME tables --
-- deliberately not split into a separate "generated" store, so nothing ever
-- has to join two systems back together to answer "what surfaces does this
-- subnet have right now." `subnets.source` and `surfaces.authority` record
-- provenance (community vs machine) as a queryable fact ON the row, not as a
-- reason to route the row somewhere else.
--
--   - registry/subnets/*.json changes: scripts/sync-registry-to-postgres.mjs,
--     merge-triggered (event-driven, matches contributor-PR cadence).
--   - Machine-generated/promoted content: scripts/backfill-registry-postgres.mjs
--     run on a schedule (matches native-snapshot/candidate-verification
--     cadence, not a git commit).
--
-- These tables are what the Worker actually reads/serves (once the read-path
-- cutover happens -- not yet wired), so no derived registry artifact needs
-- to be committed back to git and rebuilt on a cadence again -- it's
-- computed live from these rows instead.
--
-- Not TimescaleDB hypertables (this data isn't a time series and there's no
-- partition-column requirement to work around) -- ordinary tables with real
-- foreign keys and uniqueness constraints, which is the entire point: a
-- subnet's filename and its internal slug can no longer diverge (there is no
-- filename to diverge from), and a surface can't be duplicated or farmed
-- under a different `kind` against the same URL -- the UNIQUE constraint on
-- `surfaces` rejects that insert outright, not just flags it after the fact.
-- `gen_random_uuid()` has been in Postgres core (no extension) since PG13.
-- Portable vanilla Postgres -- no extensions required.

CREATE TABLE IF NOT EXISTS subnets (
  netuid           INTEGER PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  -- 'community' (has a registry/subnets/<slug>.json file) or
  -- 'machine-generated' (native-chain-registered, no manual file yet --
  -- scripts/generated-overlays.mjs's baseline overlay is the only source).
  source           TEXT NOT NULL DEFAULT 'community',
  overlay          JSONB NOT NULL,       -- full overlay content, verbatim (manual file, or the generated baseline)
  source_commit    TEXT NOT NULL,        -- merge commit SHA (community) or the sync run's own commit SHA (generated)
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subnets_source ON subnets (source);

CREATE TABLE IF NOT EXISTS providers (
  id               TEXT PRIMARY KEY,     -- the provider slug (registry/providers/<slug>.json)
  overlay          JSONB NOT NULL,
  source_commit    TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surfaces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subnet_netuid    INTEGER NOT NULL REFERENCES subnets (netuid) ON DELETE RESTRICT,
  provider_id      TEXT REFERENCES providers (id) ON DELETE RESTRICT,
  surface_key      TEXT NOT NULL,        -- matches scripts/lib.mjs's subnetSurfaceKey()
  kind             TEXT NOT NULL,
  url              TEXT NOT NULL,
  -- source_urls lives only in `overlay` (JSONB array) -- real registry files
  -- use both a legacy singular `source_url` and the current plural
  -- `source_urls` shape, so normalizing it to one dedicated column here would
  -- misrepresent one of the two. Query it from `overlay` when needed,
  -- reconciling the singular `source_url` / plural `source_urls` shapes at
  -- read time (plural wins), rather than re-deriving it per route.
  authority        TEXT NOT NULL DEFAULT 'community',
  review_state     TEXT NOT NULL DEFAULT 'community-submitted',
  probe_eligible   BOOLEAN NOT NULL DEFAULT false,
  public_safe      BOOLEAN NOT NULL DEFAULT true,
  overlay          JSONB NOT NULL,       -- the surface object, verbatim, for round-trip fidelity
  source_commit    TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subnet_netuid, kind, url)
);
CREATE INDEX IF NOT EXISTS idx_surfaces_subnet   ON surfaces (subnet_netuid);
CREATE INDEX IF NOT EXISTS idx_surfaces_provider ON surfaces (provider_id);
CREATE INDEX IF NOT EXISTS idx_surfaces_probe    ON surfaces (probe_eligible, review_state)
  WHERE probe_eligible;

-- Append-only audit ledger: every write traces back to the PR that produced
-- it. A bad row is traced to its source_commit and reverted by reverting
-- that PR and re-running the sync -- never a mystery change with no author.
CREATE TABLE IF NOT EXISTS surface_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  surface_id       UUID,                 -- NULL if the surface was later deleted
  subnet_netuid    INTEGER NOT NULL,
  action           TEXT NOT NULL,        -- 'insert' | 'update' | 'delete'
  overlay          JSONB NOT NULL,       -- the surface's overlay content at this point in history
  source_commit    TEXT NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_surface_history_surface ON surface_history (surface_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_history_subnet  ON surface_history (subnet_netuid, recorded_at DESC);
