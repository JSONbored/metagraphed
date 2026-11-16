-- The v490 balancer-based Swap pallet and AlphaAssets (#13165, runtime v490;
-- #13161, epic #13142).
--
-- The pre-490 Swap shape this repo still declared (AlphaSqrtPrice /
-- SwapV3Initialized) no longer exists on chain: spec 490's Swap pallet is
-- balancer-based (SwapBalancer, BalancerTaoReservoir, BalancerAlphaReservoir,
-- FeeRate, PalSwapInitialized, ScrapReservoirAlpha), and the AlphaAssets
-- pallet (TotalAlphaIssuance, AlphaBurned, AlphaRecycled) is absent from
-- every surface. This migration gives both their keyed places to land. The
-- writers -- the engine's Swap balancer and AlphaAssets storage decode --
-- land with the engine; until they do, both tables below are empty and the
-- serving tier declines schema-stably (NULL counts and states, never
-- fabricated zeros).
--
-- Quantities are u64 atomic units as canonical decimal text (same discipline
-- as app.subnet_gamma); captured_at is epoch-ms, same floor as the neuron
-- document stamps. Mainnet-only, like every table without a network column.

-- One row per (netuid, captured_at): the per-subnet balancer AMM state the
-- engine fills from Swap.BalancerTaoReservoir / Swap.BalancerAlphaReservoir /
-- Swap.FeeRate. A capture SERIES rather than a current-state row (the newest
-- row per netuid is the current state), so the reservoir trajectory that
-- reconciles our derived tao_in_pool_tao / alpha_in_pool figures is kept, not
-- overwritten. fee_rate is the chain's raw u16 as stored -- the engine's
-- decode owns any scaling, and re-deriving a percentage here would invent
-- precision. Every value column is nullable because a capture truthfully
-- carries only what the chain had at that block: a NULL is "not carried at
-- capture time", never a fabricated zero.
CREATE TABLE app.swap_balancer (
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    tao_reservoir text COLLATE "C" CHECK (
        tao_reservoir IS NULL OR ((tao_reservoir = '0' OR tao_reservoir ~ '^[1-9][0-9]*$')
            AND (length(tao_reservoir), tao_reservoir) <= (20, '18446744073709551615'))
    ),
    alpha_reservoir text COLLATE "C" CHECK (
        alpha_reservoir IS NULL OR ((alpha_reservoir = '0' OR alpha_reservoir ~ '^[1-9][0-9]*$')
            AND (length(alpha_reservoir), alpha_reservoir) <= (20, '18446744073709551615'))
    ),
    fee_rate bigint CHECK (fee_rate IS NULL OR fee_rate BETWEEN 0 AND 65535),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, captured_at)
);

-- One row per (netuid, captured_at): the per-subnet alpha asset accounting
-- the engine fills from AlphaAssets.TotalAlphaIssuance /
-- AlphaAssets.AlphaBurned / AlphaAssets.AlphaRecycled. The same capture-
-- series shape as app.swap_balancer, for the same reason: issuance and its
-- burn/recycle sinks are a trajectory, and the newest row per netuid is the
-- current state.
CREATE TABLE app.alpha_assets (
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    total_issuance text COLLATE "C" CHECK (
        total_issuance IS NULL OR ((total_issuance = '0' OR total_issuance ~ '^[1-9][0-9]*$')
            AND (length(total_issuance), total_issuance) <= (20, '18446744073709551615'))
    ),
    burned text COLLATE "C" CHECK (
        burned IS NULL OR ((burned = '0' OR burned ~ '^[1-9][0-9]*$')
            AND (length(burned), burned) <= (20, '18446744073709551615'))
    ),
    recycled text COLLATE "C" CHECK (
        recycled IS NULL OR ((recycled = '0' OR recycled ~ '^[1-9][0-9]*$')
            AND (length(recycled), recycled) <= (20, '18446744073709551615'))
    ),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, captured_at)
);
