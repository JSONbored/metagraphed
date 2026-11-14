-- The on-chain TAO/USD oracle (#13164, runtime v490; #13161, epic #13142).
--
-- /network/tao-usd has always served the OFF-CHAIN composed index (ADR 0025:
-- a liquidity-weighted median across wTAO/WETH pools through an ETH/USDC
-- anchor), because the chain had no TAO/USD pair. Runtime v490 added one:
-- SubtensorModule.TaoUsdPrice (fed by the authorized
-- SubtensorModule.TaoUsdPriceOracle account, event TaoUsdPriceFed). This
-- table gives that feed history its keyed place to land, one row per fed
-- block; the newest row is the current on-chain price. The writers -- the
-- engine's TaoUsdPrice / TaoUsdPriceOracle storage decode and TaoUsdPriceFed
-- event decode -- land with the engine; until they do the table is empty and
-- the serving tier declines schema-stably (oracle: null, never a fabricated
-- price).
--
-- usd_per_tao is the decode's normalized USD-per-TAO figure (float, same
-- representation as tao_usd_index's own column); price_raw preserves the
-- chain's raw price encoding verbatim as canonical decimal text, because the
-- decode owns the scaling and re-deriving it at serve time would invent
-- precision. Both are nullable: a NULL is "not carried / not normalizable at
-- capture time", never a zero price. Mainnet-only, like every table without
-- a network column.
CREATE TABLE app.tao_usd_oracle (
    block_number bigint NOT NULL CHECK (block_number >= 0),
    usd_per_tao double precision CHECK (usd_per_tao IS NULL OR usd_per_tao > 0),
    price_raw text COLLATE "C" CHECK (
        price_raw IS NULL OR ((price_raw = '0' OR price_raw ~ '^[1-9][0-9]*$')
            AND (length(price_raw), price_raw) <= (39, '340282366920938463463374607431768211455'))
    ),
    oracle text COLLATE "C" CHECK (oracle IS NULL OR oracle <> ''),
    observed_at bigint NOT NULL CHECK (observed_at >= 1000000000000),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (block_number)
);

-- The serving reads are newest-first over the feed history; the primary key
-- orders by block, and the feed lands at most once per block.
CREATE INDEX idx_tao_usd_oracle_observed
    ON app.tao_usd_oracle (observed_at DESC);
