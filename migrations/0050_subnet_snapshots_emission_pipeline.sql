-- v440 emission-pipeline inputs on the daily subnet rollup (#8743).
--
-- The point samples these come from are per-block, reservoir-smoothed and
-- cap-limited, so a single observation is noisy BY CONSTRUCTION. The daily
-- rollup is the reportable figure, which is why these live here and not only
-- in the economics artifact.
--
-- Nullable throughout, and deliberately: a refresh whose node could not serve
-- state_queryStorageAt publishes the rest of the economics block rather than
-- nothing, so a row can legitimately carry structural columns and no pipeline
-- ones. NULL means "not captured", never "zero".
--
-- subnet_snapshots predates the migration directory -- its DDL lives in
-- deploy/postgres/schema.sql, which only ever runs against a fresh database.
-- The live box needs this ALTER to see the columns at all.
ALTER TABLE subnet_snapshots
  -- Stage 8: TAO injected into the subnet's own pool. Stage 7: TAO the chain
  -- bought on its behalf. Their sum across subnets equals the
  -- issuance-derived block emission -- the strongest single identity in the
  -- pipeline, and the reason both are stored rather than just their total.
  ADD COLUMN IF NOT EXISTS tao_in_emission_tao   NUMERIC,
  ADD COLUMN IF NOT EXISTS excess_tao            NUMERIC,
  -- Alpha into the pool, and alpha to participants. alpha_out_emission is a
  -- per-subnet halving curve, NOT the constant 1.0 it currently resembles.
  ADD COLUMN IF NOT EXISTS alpha_in_emission     NUMERIC,
  ADD COLUMN IF NOT EXISTS alpha_out_emission    NUMERIC,
  -- Stage 2. A FRACTION IN [0, 1] -- MinerBurned is U96F32 (divide by 2^32,
  -- never by 1e9). NUMERIC rather than a float so the fixed-point value is
  -- not re-rounded on the way in.
  ADD COLUMN IF NOT EXISTS miner_burned_fraction NUMERIC,
  -- Stage 5. DEFAULTS TO TRUE ON CHAIN: absent storage means enabled and
  -- 0x00 means disabled, so this column holds the DECODED boolean and never
  -- key presence. No DEFAULT here on purpose -- an unwritten row must read
  -- NULL ("not captured"), not TRUE ("captured, and enabled").
  ADD COLUMN IF NOT EXISTS emission_enabled      BOOLEAN,
  -- Stage 0 eligibility.
  ADD COLUMN IF NOT EXISTS subtoken_enabled      BOOLEAN,
  ADD COLUMN IF NOT EXISTS first_emission_block  BIGINT;
