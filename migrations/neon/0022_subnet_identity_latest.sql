-- #10710: the latest-only half of the subnet identity family.
--
-- 0021 gave the history table back. This is its card -- one row per netuid,
-- overwritten in place -- and it is the half the REGISTRY needs. History
-- answers "what was this subnet called before"; the card answers "what is it
-- called now", which is the question that was being answered from a
-- hand-refreshed file measured 54 days stale, with 82 of 129 subnets
-- disagreeing with the live chain and 28 renamed outright.
--
-- WHY BOTH, rather than deriving the card from the history's newest row.
-- Every other identity/hyperparams family here is a card plus a history, and
-- `FAMILY_MIRROR_PLANS` is written against exactly that pair. Deriving would
-- also make the hot read -- current name for one subnet -- a sort over that
-- subnet's whole revision list, on a route that is deliberately not
-- edge-cached.
--
-- COLUMNS MATCH THE HISTORY'S, minus `id` and plus `captured_at`. The producer
-- sends one shape; the card keeps the freshness stamp and the history keeps the
-- revision hash, which is the same split subnet_hyperparams uses.
CREATE TABLE IF NOT EXISTS subnet_identity (
  netuid        INTEGER PRIMARY KEY,
  block_number  BIGINT  NOT NULL,
  -- Epoch milliseconds. BIGINT for the reason 0006 documents: INTEGER
  -- truncates silently rather than erroring.
  captured_at   BIGINT  NOT NULL,
  -- Nullable for the same reason as the history: an owner who never called
  -- set_identity has no name, and the producer sends null rather than "" so a
  -- consumer cannot overwrite a curated fallback with an empty string.
  subnet_name   TEXT,
  symbol        TEXT,
  description   TEXT,
  github_repo   TEXT,
  subnet_url    TEXT,
  discord       TEXT,
  logo_url      TEXT,
  identity_hash TEXT
);

-- The freshness guard the card write uses (`captured_at <`), and the ordering
-- a "which subnets are stalest" sweep would want.
CREATE INDEX IF NOT EXISTS subnet_identity_captured_at_idx
  ON subnet_identity (captured_at DESC);
