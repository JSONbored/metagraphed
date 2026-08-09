import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_API_BASE } from "./config";

/**
 * The TAO market figures the header ticker shows, composed from OUR OWN API.
 *
 * ## Why this stopped calling coinpaprika
 *
 * It used to fetch `api.coinpaprika.com/v1/tickers/tao-bittensor` and read
 * `quotes.USD`. We publish a TAO/USD price ourselves -- and ours is the one we
 * can explain: `/api/v1/network/tao-usd` is a liquidity-weighted median across
 * qualifying wTAO/WETH pools with outlier rejection and a two-pool quorum,
 * multiplied through an ETH/USDC anchor (ADR 0025), pinned to an Ethereum
 * block, with the pool addresses and their liquidity published beside it.
 * Measured 2026-08-09 the two agreed to 0.05% ($207.03 vs $207.14), so this is
 * not a correction -- it is removing a third-party dependency for a number we
 * already serve, and keeping one source of truth instead of two.
 *
 * ## The other two figures are NOT the same quantities coinpaprika reported
 *
 * That matters more than the price, and both are relabelled in the ticker
 * rather than silently swapped:
 *
 *   - MARKET CAP is `TotalIssuance x usd_per_tao` -- the chain's own issuance,
 *     not a circulating-supply estimate. Coinpaprika reported
 *     `circulating_supply: 0` and a market cap implying ~9.61M TAO against the
 *     chain's 11.22M, so ours reads ~17% higher. Neither is wrong; they are
 *     different denominators, which is exactly why `supply_basis` rides along.
 *
 *   - VOLUME is on-chain subnet-AMM volume over 24h, from the same
 *     account_events stream `/chain/alpha-volume` serves. It is NOT global
 *     exchange volume: measured 2026-08-09 it was ~$34M against coinpaprika's
 *     ~$115M, because most TAO trades on centralized venues we do not index.
 *     Calling it "24h volume" unqualified would be a confident wrong answer,
 *     so the tile says "24h on-chain vol" and `volume_basis` states it.
 *
 * ## Cost
 *
 * Three requests instead of one, but all three are ours, edge-cached, and tiny
 * -- 743 B + 1,285 B + 1,297 B measured against production, ~3.3 KB total. The
 * volume read is narrowed with `limit=1` because the ticker needs the network
 * aggregate and not the 128 per-subnet rows, and the price read drops its 1,428
 * series points with `include_points=false` for the same reason.
 *
 * A failed leg yields `undefined` for that figure rather than failing the
 * whole payload: the price tile going blank should not take the market cap
 * with it, and `formatUsdCompact` already renders an em-dash for undefined.
 */
export interface TaoMarketData {
  price?: number;
  market_cap?: number;
  volume_24h?: number;
  /** What denominator `market_cap` used. Published so the gap with venues
   * quoting a circulating-supply estimate is explicable, not surprising. */
  supply_basis?: "total_issuance";
  /** What `volume_24h` measures. NOT global exchange volume. */
  volume_basis?: "subnet_amm_onchain";
}

/** One JSON leg. Resolves to null on any failure -- never throws, so one cold
 * surface cannot blank the other two tiles. */
async function leg(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${DEFAULT_API_BASE}${path}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    if (body?.ok !== true || typeof body.data !== "object" || body.data === null) {
      return null;
    }
    return body.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A finite, strictly-positive number, or undefined. Zero is rejected for the
 * same reason `resolveTaoPrice` rejects it: a zero price or a zero cap is a
 * failed read wearing a plausible value. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// Extracted from the createServerFn handler so the fetch/compose path is
// unit-testable directly, without TanStack Start's AsyncLocalStorage request
// context (see market.functions.test.ts). getTaoMarket delegates to it, so
// runtime behavior is unchanged.
export async function fetchTaoMarket(): Promise<TaoMarketData> {
  const [priceData, params, volume] = await Promise.all([
    leg("/api/v1/network/tao-usd?include_points=false"),
    leg("/api/v1/network/parameters"),
    leg("/api/v1/chain/alpha-volume?limit=1"),
  ]);

  const latest = (priceData?.latest ?? null) as Record<string, unknown> | null;
  // A null usd_per_tao is a STATED OUTCOME on that surface (price_basis
  // "insufficient_pools"), not a gap -- so it must read as "no price", which
  // positive() already does, rather than as zero.
  const price = positive(latest?.usd_per_tao);
  const issuance = positive(params?.total_issuance_tao);
  const volumeTao = positive(
    (volume?.network as Record<string, unknown> | undefined)?.total_volume_tao,
  );

  // Both derived figures need the price, so both are absent without it. A
  // market cap in TAO would be a different number wearing a dollar sign.
  return {
    price,
    market_cap: price !== undefined && issuance !== undefined ? price * issuance : undefined,
    volume_24h: price !== undefined && volumeTao !== undefined ? price * volumeTao : undefined,
    supply_basis: "total_issuance",
    volume_basis: "subnet_amm_onchain",
  };
}

export const getTaoMarket = createServerFn({ method: "GET" }).handler(fetchTaoMarket);
