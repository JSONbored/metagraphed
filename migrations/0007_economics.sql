-- Live economics tier (#1009 follow-up): durable D1 fallback for /api/v1/economics.
--
-- The live economics tier is KV-blob-primary (METAGRAPH_CONTROL 'economics:current',
-- the byte-identical economics.json), with this table as a best-effort DURABILITY
-- fallback read only when KV is cold, and the committed R2 economics.json as the
-- final cold/stale fallback. Written verbatim from the already-built economics
-- artifact (slug/name/emission_share never re-derived in the Worker). All economic
-- magnitudes are NULLABLE REAL with NO DEFAULT — a missing chain field is null, not
-- a misleading 0. registration_allowed is 0/1. emission_share is the pre-computed
-- price/Σprice value (stored, never recomputed at read time). captured_at +
-- contract_version + the row count gate the freshness/integrity checks in
-- resolveLiveEconomics. Idempotent (CREATE TABLE IF NOT EXISTS) like the others.

CREATE TABLE IF NOT EXISTS subnet_economics (
  netuid                INTEGER PRIMARY KEY,
  slug                  TEXT,
  name                  TEXT,
  max_uids              INTEGER,
  validator_count       INTEGER,
  max_validators        INTEGER,
  miner_count           INTEGER,
  registration_allowed  INTEGER,           -- 0 | 1
  registration_cost_tao REAL,
  alpha_price_tao       REAL,
  emission_share        REAL,              -- pre-computed price / Σ price
  total_stake_tao       REAL,
  max_stake_tao         REAL,
  tao_in_pool_tao       REAL,
  alpha_in_pool         REAL,
  alpha_out_pool        REAL,
  subnet_volume_tao     REAL,
  owner_hotkey          TEXT,
  owner_coldkey         TEXT,
  captured_at           TEXT,              -- snapshot capture ISO (freshness gate)
  contract_version      TEXT,              -- guards stale-contract reads
  updated_at            INTEGER NOT NULL   -- epoch milliseconds
);
