-- First-party TAO/USD index, with the pool readings that produced it (#8600).
--
-- ADR 0025's basis: a liquidity-weighted median across qualifying wTAO/WETH
-- Uniswap v3 pools, multiplied by the WETH/USDC anchor leg, read from chain
-- state at a published Ethereum block height.
--
-- WHY THE PER-POOL INPUTS ARE STORED AND NOT JUST THE ANSWER. #8503 requires
-- provenance, and an index nobody can audit after the fact is not defensible.
-- `pools` holds every pool the tick looked at -- the ones that contributed with
-- their price and TVL, and the ones that did not with the reason -- so any
-- published figure can be recomputed from its own row and checked against a
-- fresh archive read at the same height.
--
-- IDEMPOTENT BY CONSTRUCTION, NOT BY LUCK. `observed_at` is the ETHEREUM
-- BLOCK'S OWN TIMESTAMP, never the wall clock at ingestion. Re-running a tick
-- for the same height therefore produces a row identical in both PK columns,
-- so ON CONFLICT DO NOTHING is a true no-op. Had observed_at been "now", every
-- re-run would have inserted a near-duplicate the constraint could not see --
-- requirement 4(d) failing silently, which is the worst way for it to fail.
CREATE TABLE IF NOT EXISTS tao_usd_index (
  -- Ethereum mainnet height every call in the observation was pinned to. A
  -- third party can re-execute the same reads against it and get this row
  -- back, which is ADR 0025 decision 5's reproducibility claim.
  block_number  BIGINT  NOT NULL,
  -- The block's timestamp, epoch ms -- matching the BIGINT epoch-ms convention
  -- every other time-series table here uses. Also the partition column, so it
  -- is in the PK per TimescaleDB's rule (see `blocks` in schema.sql).
  observed_at   BIGINT  NOT NULL,
  -- NULL whenever the basis is 'insufficient_pools'. Never a fabricated
  -- number, never a stale carry-forward: the CHECK below makes that
  -- unrepresentable rather than merely conventional.
  usd_per_tao   NUMERIC,
  -- ADR 0025 decision 7's honesty vocabulary, extending price_basis in
  -- src/price-at-tx.ts. 'wrapped_onchain_median' names the wrapping: these
  -- pools price wTAO, and a bridge incident would have them confidently
  -- pricing a different asset.
  price_basis   TEXT    NOT NULL,
  -- The anchor leg, stored because the index is a PRODUCT of two readings and
  -- a reader who cannot see both cannot verify either.
  eth_usd       NUMERIC,
  -- Pools that actually contributed, after TVL floor and outlier rejection.
  pool_count    INTEGER NOT NULL,
  -- Every pool the tick read: contributors with price + TVL, rejects with a
  -- reason. NUMERIC-typed values are written as JSON numbers here, which is
  -- lossier than the NUMERIC columns above -- deliberately, because this is
  -- the audit trail for a float-valued price, not a balance.
  pools         JSONB   NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (block_number, observed_at),
  CONSTRAINT tao_usd_index_basis_check
    CHECK (price_basis IN ('wrapped_onchain_median', 'insufficient_pools')),
  -- The ADR states "null iff basis is insufficient_pools". Enforced rather
  -- than documented: a bug that publishes a price under an insufficient-pools
  -- label is exactly the failure this whole design exists to prevent, and it
  -- would otherwise be invisible until someone read the numbers.
  CONSTRAINT tao_usd_index_value_matches_basis_check
    CHECK (
      (price_basis = 'insufficient_pools' AND usd_per_tao IS NULL)
      OR (price_basis <> 'insufficient_pools' AND usd_per_tao IS NOT NULL)
    ),
  CONSTRAINT tao_usd_index_pool_count_check CHECK (pool_count >= 0)
);

-- The serving query is "latest value" and "the last N minutes", both of which
-- lead with observed_at.
CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed
  ON tao_usd_index (observed_at DESC);
