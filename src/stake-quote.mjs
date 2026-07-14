// Constant-product AMM slippage/price-impact quote for one subnet's stake
// pool (#5235, epic #5229's read-only "developer-grade API" gap -- a
// scriptable quote endpoint alongside the wallet-connected signing flow).
// Pure + exported for tests; the Worker handler resolves the economics row
// (tao_in_pool_tao/alpha_in_pool, already TAO/alpha-float, no rao conversion)
// and calls this. Deliberately does NOT use alpha_out_pool -- that field is
// the subnet's total *emitted* alpha (a market-cap input), not an AMM swap
// reserve; the formula only ever touches the two actual pool reserves.

export const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"];
export const DEFAULT_STAKE_QUOTE_DIRECTION = "stake";

// The chain's own InsufficientLiquidity guard rejects an extrinsic whose
// input would swing a pool by more than this multiple of its own reserve --
// mirrored here as a static, documented client-side bound (the deliverable's
// own ">1000x pool-reserve rejection" case) so this endpoint never quotes an
// amount that could never actually confirm on-chain.
const MAX_POOL_MULTIPLE = 1000;

function isPositiveFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Every call site here already has a finite value in hand (amountOut/
// spotPriceTao/effectivePriceTao/priceImpactPct are all derived from the
// isPositiveFinite-checked pool reserves above) -- no null/non-finite guard,
// unlike src/metagraph-neurons.mjs's own round() which serves nullable D1
// cells.
function round(value, dp = 6) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * amount is the input leg: TAO being staked (direction "stake") or alpha
 * being unstaked (direction "unstake"). Returns either the quote object or
 * `{ error: { parameter, message } }` (mirrors parseGlobalValidatorsQuery's
 * own { error } shape) for the handler to translate into a 400.
 */
export function buildStakeQuote(row, netuid, { amount, direction }) {
  // Root (netuid 0) has no AMM -- stake there is TAO-denominated 1:1 with no
  // swap fee and no price impact (ADR 0018 §3) -- exempt from the
  // constant-product formula entirely rather than running it against
  // economics.json's non-AMM root reserves.
  if (netuid === 0) {
    return {
      schema_version: 1,
      netuid,
      direction,
      amount_in: amount,
      amount_out: amount,
      spot_price_tao: 1,
      effective_price_tao: 1,
      price_impact_pct: 0,
    };
  }

  const taoIn = row?.tao_in_pool_tao;
  const alphaIn = row?.alpha_in_pool;
  if (!isPositiveFinite(taoIn) || !isPositiveFinite(alphaIn)) {
    return {
      error: {
        parameter: "netuid",
        message: `subnet ${netuid} has no pool liquidity to quote against.`,
      },
    };
  }

  const spotPriceTao = taoIn / alphaIn; // TAO per alpha, pre-trade marginal price
  const poolReserve = direction === "stake" ? taoIn : alphaIn;
  if (amount > poolReserve * MAX_POOL_MULTIPLE) {
    return {
      error: {
        parameter: "amount",
        message: `amount exceeds ${MAX_POOL_MULTIPLE}x this subnet's pool reserve -- this trade would never confirm on-chain (mirrors the chain's own InsufficientLiquidity guard).`,
      },
    };
  }

  // alpha_out = alpha_in - (alpha_in * tao_in) / (tao_in + delta_tao), and its
  // inverse (tao_out from delta_alpha) for the unstake direction.
  const amountOut =
    direction === "stake"
      ? alphaIn - (alphaIn * taoIn) / (taoIn + amount)
      : taoIn - (taoIn * alphaIn) / (alphaIn + amount);
  const effectivePriceTao =
    direction === "stake" ? amount / amountOut : amountOut / amount;
  const priceImpactPct =
    (Math.abs(effectivePriceTao - spotPriceTao) / spotPriceTao) * 100;

  return {
    schema_version: 1,
    netuid,
    direction,
    amount_in: amount,
    amount_out: round(amountOut),
    spot_price_tao: round(spotPriceTao),
    effective_price_tao: round(effectivePriceTao),
    price_impact_pct: round(priceImpactPct),
  };
}
