// #8600: turn one batch of Ethereum `eth_call` results into an index reading.
//
// Everything here is pure. The Worker in workers/data-api.ts owns the two HTTP
// requests (a block height, then one batch pinned to it) and the Postgres
// write; this module owns which calls to make and what the answers mean, so
// both are testable without a network or a database.
//
// PINNED TO A HEIGHT, WHICH IS WHY IT IS IDEMPOTENT. Every call in a tick is
// made at one block number, and `observed_at` is that block's own timestamp
// rather than the wall clock. Re-running a tick therefore produces a row
// identical in both unique-constraint columns, so the ON CONFLICT in the
// ingestion path is a real no-op and not a race with a differing timestamp.
// It is also what makes the reading reproducible by a third party, which is
// ADR 0025 decision 5's whole point.
//
// A CALL PLAN, NOT A POSITIONAL BATCH. JSON-RPC batch responses may come back
// in any order, and a decoder that trusts array position is one reordering
// proxy away from pricing wTAO with a USDC balance. Each call carries an id
// and the decoder matches on it.

import {
  decodeFirstWord,
  encodeBalanceOf,
  priceToken1PerToken0,
  scaleBalance,
  UNISWAP_V3_SELECTORS,
} from "./uniswap-v3.ts";
import type { PoolReading } from "./tao-usd-index.ts";

/** ERC-20s this index reads. Addresses are canonical mainnet, lower-cased. */
export const TOKENS = {
  wtao: {
    address: "0x77e06c9eccf2e797fd462a92b6d7642ef85b0a44",
    decimals: 9,
  },
  weth: {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    decimals: 18,
  },
  usdc: {
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
  },
} as const;

/**
 * The anchor leg. USDC is token0 and WETH is token1 — Uniswap v3 orders a
 * pool's tokens by address, and 0xa0b8… sorts below 0xc02a…, so this ordering
 * is fixed for the life of the pool rather than a convention we chose.
 */
export const WETH_USDC_POOL = {
  address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  fee: 500,
} as const;

/**
 * The TAO leg. wTAO (0x77e0…) sorts below WETH (0xc02a…), so wTAO is token0
 * in both, and `priceToken1PerToken0` yields ETH per wTAO directly.
 */
export const WTAO_WETH_POOLS = [
  { address: "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc", fee: 10_000 },
  { address: "0x2982d3295a0e1a99e6e88ece0e93ffdfc5c761ae", fee: 3_000 },
] as const;

/** ADR 0025 criterion 2b: a pool below this TVL does not qualify. */
export const MIN_POOL_TVL_USD = 250_000;

/** One `eth_call` to make, tagged so the decoder never trusts array order. */
export interface ObservationCall {
  id: string;
  to: string;
  data: string;
}

/**
 * Every call one observation needs: the anchor pool's price, and each TAO
 * pool's price plus both token balances (the TVL that becomes its weight).
 */
export function buildObservationCalls(): ObservationCall[] {
  const calls: ObservationCall[] = [
    {
      id: "anchor:slot0",
      to: WETH_USDC_POOL.address,
      data: UNISWAP_V3_SELECTORS.slot0,
    },
  ];
  for (const pool of WTAO_WETH_POOLS) {
    calls.push({
      id: `${pool.address}:slot0`,
      to: pool.address,
      data: UNISWAP_V3_SELECTORS.slot0,
    });
    calls.push({
      id: `${pool.address}:wtao`,
      to: TOKENS.wtao.address,
      data: encodeBalanceOf(pool.address),
    });
    calls.push({
      id: `${pool.address}:weth`,
      to: TOKENS.weth.address,
      data: encodeBalanceOf(pool.address),
    });
  }
  return calls;
}

export interface Observation {
  /** ETH priced in USD, from the anchor pool. Null if it did not read. */
  ethUsd: number | null;
  /** Pools that read cleanly and clear the TVL floor. */
  pools: PoolReading[];
  /** Pools that read but did not qualify, and why — never silently dropped. */
  rejected: { address: string; reason: string }[];
}

/**
 * Decode one batch into pool readings.
 *
 * `results` maps a call id to that call's raw `eth_call` result. A missing or
 * unreadable entry costs its own pool and nothing else: requirement 4(a) is
 * that one failing read must not fail the run, and the natural way to honour
 * that is for every read to be independently optional here rather than for the
 * caller to wrap the whole batch in a try.
 */
export function decodeObservation(
  results: ReadonlyMap<string, unknown>,
): Observation {
  const rejected: { address: string; reason: string }[] = [];

  // USDC per WETH. The anchor pool quotes token1-per-token0 = WETH per USDC,
  // so the leg we want is its reciprocal.
  const anchorWord = decodeFirstWord(results.get("anchor:slot0"));
  const wethPerUsdc =
    anchorWord === null
      ? null
      : priceToken1PerToken0(
          anchorWord,
          TOKENS.usdc.decimals,
          TOKENS.weth.decimals,
        );
  const ethUsd =
    wethPerUsdc !== null && wethPerUsdc > 0 ? 1 / wethPerUsdc : null;

  const pools: PoolReading[] = [];
  for (const pool of WTAO_WETH_POOLS) {
    const priceWord = decodeFirstWord(results.get(`${pool.address}:slot0`));
    const ethPerTao =
      priceWord === null
        ? null
        : priceToken1PerToken0(
            priceWord,
            TOKENS.wtao.decimals,
            TOKENS.weth.decimals,
          );
    if (ethPerTao === null) {
      rejected.push({ address: pool.address, reason: "price_unreadable" });
      continue;
    }

    const taoBalance = scaleBalance(
      decodeFirstWord(results.get(`${pool.address}:wtao`)),
      TOKENS.wtao.decimals,
    );
    const wethBalance = scaleBalance(
      decodeFirstWord(results.get(`${pool.address}:weth`)),
      TOKENS.weth.decimals,
    );
    if (taoBalance === null || wethBalance === null) {
      rejected.push({ address: pool.address, reason: "balance_unreadable" });
      continue;
    }

    // TVL both sides, valued in ETH by the pool's OWN ratio and then in USD by
    // the anchor. Not circular: nothing here uses the index being computed,
    // only the two readings this pool and the anchor already produced. Without
    // the anchor there is no USD to compare against the floor, so the pool is
    // rejected on that basis rather than admitted on an unchecked one.
    const tvlEth = taoBalance * ethPerTao + wethBalance;
    if (ethUsd === null) {
      rejected.push({ address: pool.address, reason: "anchor_unavailable" });
      continue;
    }
    const liquidityUsd = tvlEth * ethUsd;
    if (!(liquidityUsd >= MIN_POOL_TVL_USD)) {
      rejected.push({ address: pool.address, reason: "below_tvl_floor" });
      continue;
    }

    pools.push({
      address: pool.address,
      eth_per_tao: ethPerTao,
      liquidity_usd: liquidityUsd,
    });
  }

  return { ethUsd, pools, rejected };
}
