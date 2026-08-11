-- #10710: give subnet_identity_history a table again.
--
-- WHAT WENT MISSING. This table's write path was D1-primary with a best-effort
-- Postgres mirror. D1 was eliminated, and the mirror -- `syncSubnetIdentityToPostgres`
-- -- was never written. It is named as "the sole writer now" in four places
-- (src/subnet-identity-history.ts, workers/request-handlers/entities.ts,
-- wrangler.jsonc, and a test) and does not exist. So the table has had no writer
-- since the cutover, and no Neon table to write to either.
--
-- The reads never broke, which is what kept it quiet: a Postgres miss degrades
-- to a schema-stable empty feed rather than a 404, so a store with no writer
-- reads as a healthy, permanently frozen one. The newest identity change served
-- is 2026-07-31. `previously_known_as` is published on three routes and is
-- always absent (#10706), and the change-detector diffs against an empty
-- baseline and so reports ~129 changes every tick (#10700) -- both are this.
--
-- WHAT THIS COSTS WHEN IT IS WRONG, from the lane that will fill it: the
-- hand-refreshed capture the registry fell back to was measured 54 days stale,
-- with 82 of 129 subnets disagreeing with the live chain and 28 renamed
-- outright. Subnet 53 served as "EfficientFrontier" for eight weeks while the
-- chain said "engy".
--
-- COLUMNS ARE THE READER'S, NOT A FRESH DESIGN. `READ_COLUMNS` in
-- src/subnet-identity-history.ts already names exactly what the two serving
-- routes select, and the cursor pages on `(observed_at, id)`. A table that
-- disagreed with that list would compile, deploy, and return nothing.
--
-- TYPES. `observed_at` is epoch-ms and therefore BIGINT, the trap 0006
-- documents -- INTEGER overflows in 2038 and the failure is silent truncation,
-- not an error. `block_number` is BIGINT for the same reason it is everywhere
-- else here: the chain is past 8.8M and an INTEGER ceiling is a future outage
-- with no symptom until it arrives.
CREATE TABLE IF NOT EXISTS subnet_identity_history (
  id            BIGSERIAL PRIMARY KEY,
  netuid        INTEGER NOT NULL,
  block_number  BIGINT  NOT NULL,
  -- Epoch milliseconds, matching every other captured_at/observed_at here.
  observed_at   BIGINT  NOT NULL,
  -- Every identity field is NULLABLE on purpose. An owner who never called
  -- set_identity has no name, and the producer drops empty strings to NULL
  -- rather than writing "" -- publishing an empty string would let a consumer
  -- overwrite a real curated fallback with nothing.
  subnet_name   TEXT,
  symbol        TEXT,
  description   TEXT,
  github_repo   TEXT,
  subnet_url    TEXT,
  discord       TEXT,
  logo_url      TEXT,
  -- Stable hash of the identity fields. It is what makes this table
  -- APPEND-ONLY-ON-CHANGE rather than append-on-every-pass: a pass whose hash
  -- matches the newest row for that netuid writes nothing, so a lane running
  -- hourly against an identity that never changes adds no rows at all.
  identity_hash TEXT    NOT NULL
);

-- The per-subnet timeline, and the cursor's exact shape. `(observed_at, id) <
-- (?, ?)` needs id in the index or the tiebreak reads outside it.
CREATE INDEX IF NOT EXISTS subnet_identity_history_netuid_observed_idx
  ON subnet_identity_history (netuid, observed_at DESC, id DESC);

-- The network-wide feed (/api/v1/chain/identity-history), which orders across
-- every subnet rather than within one.
CREATE INDEX IF NOT EXISTS subnet_identity_history_observed_idx
  ON subnet_identity_history (observed_at DESC, id DESC);

-- One row per (netuid, identity_hash) is the append-on-change contract stated
-- as a constraint rather than trusted to the writer. The producer is a poller
-- lane that re-reads the whole identity set every pass; without this, one
-- unchanged identity becomes 24 identical rows a day, and the "previously known
-- as" provenance the history exists for becomes noise.
CREATE UNIQUE INDEX IF NOT EXISTS subnet_identity_history_netuid_hash_idx
  ON subnet_identity_history (netuid, identity_hash);
