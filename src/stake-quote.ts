// Pure constant-product AMM stake/unstake quote math for the dTAO subnet pools
// (#5235). Reserves come from the economics.json artifact
// (`tao_in_pool_tao` = TAO reserve, `alpha_in_pool` = alpha reserve); spot price
// is `tao_in_pool_tao / alpha_in_pool` (≈ the artifact's `alpha_price_tao`).
//
// This is a read-only, pure-math estimator — no chain write, no custody. It
// mirrors the chain's own constant-product swap and its `InsufficientLiquidity`
// guard, so callers get the same expected alpha/TAO out, effective price, and
// price impact the on-chain swap would produce, without signing anything.

export const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"];

// The chain rejects a swap whose input dwarfs the relevant reserve rather than
// draining the pool; mirror that so a nonsense amount returns a clean
// insufficient-liquidity error instead of a degenerate ~100%-impact quote.
export const MAX_INPUT_RESERVE_MULTIPLE = 1000;

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export interface StakeQuote {
  netuid: number;
  direction: string;
  amount: number;
  expected_out: number;
  expected_out_unit: "alpha" | "tao";
  spot_price_tao: number;
  effective_price_tao: number;
  price_impact_pct: number;
  tao_in_pool_tao: number | null;
  alpha_in_pool: number | null;
  is_root: boolean;
}

export interface StakeQuoteSuccess {
  ok: true;
  quote: StakeQuote;
}

export interface StakeQuoteFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type StakeQuoteResult = StakeQuoteSuccess | StakeQuoteFailure;

/**
 * Compute a stake/unstake quote against one subnet's AMM pool reserves.
 *
 * @returns `{ ok: true, quote }` on success, or `{ ok: false, status, code, error }`
 *   where `status` is the HTTP status the route should surface (400 for a bad
 *   request, 422 for insufficient liquidity — a valid request the pool can't fill).
 */
export function computeStakeQuote({
  netuid,
  taoInPool,
  alphaInPool,
  amount,
  direction,
}: {
  netuid: number;
  taoInPool: unknown;
  alphaInPool: unknown;
  amount: unknown;
  direction: string;
}): StakeQuoteResult {
  if (!STAKE_QUOTE_DIRECTIONS.includes(direction)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_direction",
      error: `\`direction\` must be one of ${STAKE_QUOTE_DIRECTIONS.join(", ")}.`,
    };
  }
  if (!isFinitePositive(amount)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_amount",
      error: "`amount` must be a finite number greater than 0.",
    };
  }

  // Root subnet (netuid 0) has no AMM pool — staking there is 1:1 TAO⇄TAO with
  // no price impact, so short-circuit rather than run the formula against
  // nonexistent reserves.
  if (netuid === 0) {
    return {
      ok: true,
      quote: {
        netuid: 0,
        direction,
        amount,
        expected_out: amount,
        expected_out_unit: direction === "stake" ? "alpha" : "tao",
        spot_price_tao: 1,
        effective_price_tao: 1,
        price_impact_pct: 0,
        tao_in_pool_tao: null,
        alpha_in_pool: null,
        is_root: true,
      },
    };
  }

  if (!isFinitePositive(taoInPool) || !isFinitePositive(alphaInPool)) {
    return {
      ok: false,
      status: 422,
      code: "insufficient_liquidity",
      error: "This subnet has no AMM pool liquidity to quote against.",
    };
  }

  // Spot price is the pool ratio; each direction below applies the
  // constant-product swap (k = tao_in · alpha_in preserved) in its stable form.
  const spotPrice = taoInPool / alphaInPool; // TAO per alpha at rest

  let expectedOut: number;
  let expectedOutUnit: "alpha" | "tao";
  let effectivePrice: number;

  if (direction === "stake") {
    // Add `amount` TAO, receive alpha. Algebraically alpha_out = alpha_in -
    // k/(tao_in + Δtao), but that subtracts two near-equal large numbers and
    // loses all precision on dust amounts, so use the equivalent closed form
    // alpha_out = alpha_in·Δtao/(tao_in + Δtao), which is stable throughout.
    if (amount > MAX_INPUT_RESERVE_MULTIPLE * taoInPool) {
      return {
        ok: false,
        status: 422,
        code: "insufficient_liquidity",
        error: `\`amount\` exceeds ${MAX_INPUT_RESERVE_MULTIPLE}× the pool's TAO reserve; the swap cannot be filled.`,
      };
    }
    expectedOut = (alphaInPool * amount) / (taoInPool + amount);
    expectedOutUnit = "alpha";
    effectivePrice = amount / expectedOut; // TAO paid per alpha received
  } else {
    // Add `amount` alpha, receive TAO — the mirror form
    // tao_out = tao_in·Δalpha/(alpha_in + Δalpha).
    if (amount > MAX_INPUT_RESERVE_MULTIPLE * alphaInPool) {
      return {
        ok: false,
        status: 422,
        code: "insufficient_liquidity",
        error: `\`amount\` exceeds ${MAX_INPUT_RESERVE_MULTIPLE}× the pool's alpha reserve; the swap cannot be filled.`,
      };
    }
    expectedOut = (taoInPool * amount) / (alphaInPool + amount);
    expectedOutUnit = "tao";
    effectivePrice = expectedOut / amount; // TAO received per alpha given
  }

  // Adverse deviation of the realized price from spot, as a non-negative percent.
  const priceImpactPct =
    Math.abs((effectivePrice - spotPrice) / spotPrice) * 100;

  return {
    ok: true,
    quote: {
      netuid,
      direction,
      amount,
      expected_out: expectedOut,
      expected_out_unit: expectedOutUnit,
      spot_price_tao: spotPrice,
      effective_price_tao: effectivePrice,
      price_impact_pct: priceImpactPct,
      tao_in_pool_tao: taoInPool,
      alpha_in_pool: alphaInPool,
      is_root: false,
    },
  };
}
