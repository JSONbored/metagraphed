// #8600: compute the TAO/USD index from on-chain pool readings.
//
// The method is ADR 0025's, exactly: a liquidity-weighted median across
// qualifying wTAO/WETH pools, multiplied by an ETH/USDC anchor leg, with 2%
// outlier rejection and a two-pool floor below which nothing publishes.
//
// WHY COMPOSED RATHER THAN A DIRECT USD POOL. Reading wTAO/USDC looks simpler
// and is worse: measured 2026-07-31, all three such pools traded $81k/day
// combined while Uniswap v3's WETH/USDC traded $118M -- roughly 1,455x deeper.
// The thin USDC pools also demonstrably misprice (a $55k pool quoted 197.17
// against a 195.5 consensus). Two well-priced hops beat one badly-priced one.
//
// TOTAL BY CONSTRUCTION. Every degenerate input has a defined return and this
// never throws: no pools, one pool, unanimous pools, a wild outlier, a pool
// reporting zero/negative/non-finite price or liquidity, a missing or absurd
// ETH leg. It returns null-with-a-reason rather than a fabricated number,
// matching resolvePriceAtTx's posture in src/price-at-tx.ts.

/** How a `usd_per_tao` was arrived at, or why there isn't one. */
export type FiatPriceBasis = "wrapped_onchain_median" | "insufficient_pools";

/** ADR 0025 decision 4: below this many qualifying pools, publish nothing. */
export const MIN_QUALIFYING_POOLS = 2;

/** ADR 0025 decision 3: reject a pool more than this far from the median. */
export const OUTLIER_THRESHOLD = 0.02;

/** One wTAO/WETH pool reading. `tao_per_eth` is the pool's own ratio. */
export interface PoolReading {
  /** Pool contract address — published in `pools_excluded`, so it must be real. */
  address: string;
  /** wTAO priced in ETH. */
  eth_per_tao: number;
  /** Pool TVL in USD, the weight. ADR 0025 weights by liquidity, not volume. */
  liquidity_usd: number;
}

export interface TaoUsdIndex {
  usd_per_tao: number | null;
  price_basis: FiatPriceBasis;
  pool_count: number;
  /** Addresses that did not contribute, and why they didn't, is never silent. */
  pools_excluded: string[];
  /** The anchor leg, published so a consumer can check the composition. */
  eth_usd: number | null;
}

/** A number that can take part in arithmetic without poisoning it. */
function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The value at which cumulative weight crosses half the total.
 *
 * Not an interpolated median: with a handful of pools, returning an actual
 * observed price is more defensible than inventing one between two of them.
 * Assumes a non-empty, positively-weighted input — both guaranteed by the
 * caller below.
 */
function weightedMedian(
  entries: readonly { value: number; weight: number }[],
): number {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  // Written as accumulate-and-break rather than return-from-loop so there is
  // no trailing unreachable return to explain away: the crossing is always
  // found, because cumulative reaches `total` on the last entry.
  let result = sorted[0].value;
  let cumulative = 0;
  for (const entry of sorted) {
    result = entry.value;
    cumulative += entry.weight;
    if (cumulative * 2 >= total) break;
  }
  return result;
}

/** Plain median, used only to locate outliers before weighting them. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute the index, or say why it cannot be computed.
 *
 * `ethUsd` is the anchor leg (ADR 0025's WETH/USDC pool). It is required: an
 * index without it would be denominated in ETH while claiming to be in USD,
 * which is the one error a consumer could not detect from the payload.
 */
export function computeTaoUsdIndex(input: {
  pools: readonly PoolReading[];
  ethUsd: number;
}): TaoUsdIndex {
  const pools = Array.isArray(input.pools) ? input.pools : [];
  const ethUsd = usable(input.ethUsd) ? input.ethUsd : null;

  // Structurally unusable readings are excluded before any statistic sees
  // them -- a zero, negative, or NaN price would otherwise drag a mean, skew a
  // median, or silently zero the weight sum.
  const usableReadings: PoolReading[] = [];
  const excluded: string[] = [];
  for (const pool of pools) {
    if (usable(pool?.eth_per_tao) && usable(pool?.liquidity_usd)) {
      usableReadings.push(pool);
    } else if (typeof pool?.address === "string") {
      excluded.push(pool.address);
    }
  }

  const unavailable = (): TaoUsdIndex => ({
    usd_per_tao: null,
    price_basis: "insufficient_pools",
    pool_count: 0,
    pools_excluded: [...excluded, ...usableReadings.map((p) => p.address)],
    eth_usd: ethUsd,
  });

  if (ethUsd === null) return unavailable();
  if (usableReadings.length < MIN_QUALIFYING_POOLS) return unavailable();

  // Outliers are located against the UNWEIGHTED median, so a single huge pool
  // cannot define "normal" and evict the pools disagreeing with it.
  const reference = median(usableReadings.map((p) => p.eth_per_tao));
  const survivors: PoolReading[] = [];
  for (const pool of usableReadings) {
    const deviation = Math.abs(pool.eth_per_tao - reference) / reference;
    if (deviation > OUTLIER_THRESHOLD) excluded.push(pool.address);
    else survivors.push(pool);
  }

  // ADR 0025: rejection can never manufacture a quorum. If removing outliers
  // drops below the floor, nothing publishes -- we do not fall back to the
  // pre-rejection set, which would publish the very prices just rejected.
  if (survivors.length < MIN_QUALIFYING_POOLS) {
    return {
      usd_per_tao: null,
      price_basis: "insufficient_pools",
      pool_count: 0,
      pools_excluded: [...excluded, ...survivors.map((p) => p.address)],
      eth_usd: ethUsd,
    };
  }

  const ethPerTao = weightedMedian(
    survivors.map((pool) => ({
      value: pool.eth_per_tao,
      weight: pool.liquidity_usd,
    })),
  );

  return {
    usd_per_tao: ethPerTao * ethUsd,
    price_basis: "wrapped_onchain_median",
    pool_count: survivors.length,
    pools_excluded: excluded,
    eth_usd: ethUsd,
  };
}
