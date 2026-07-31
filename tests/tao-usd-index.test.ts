// Tests for src/tao-usd-index.ts (#8600).
//
// Requirement 2 asks for a TOTAL function: every degenerate input has a
// defined, tested return and nothing throws. Each case the issue lists has a
// test below, plus the two ADR 0025 rules that are easy to implement wrongly —
// rejection must never manufacture a quorum, and weighting is by liquidity
// rather than by count.
//
// The anchor case is a real reading: the pools and the ETH leg measured on
// 2026-07-31 must reproduce the price observed at that instant.

import { describe, expect, it } from "vitest";
import {
  computeTaoUsdIndex,
  MIN_QUALIFYING_POOLS,
  OUTLIER_THRESHOLD,
  type PoolReading,
} from "../src/tao-usd-index.ts";

/** wTAO/WETH pools and the WETH/USDC leg, read from chain 2026-07-31. */
const ETH_USD = 1906.46;
const LIVE_POOLS: PoolReading[] = [
  {
    address: "0x433a00819C771b33FA7223a5B3499b24FBCd1bBC",
    eth_per_tao: 195.68 / ETH_USD,
    liquidity_usd: 2_099_938,
  },
  {
    address: "0x2982d3295A0E1a99e6E88Ece0E93FfDfc5c761ae",
    eth_per_tao: 195.94 / ETH_USD,
    liquidity_usd: 297_133,
  },
];

const pool = (
  address: string,
  usdPrice: number,
  liquidity: number,
): PoolReading => ({
  address,
  eth_per_tao: usdPrice / ETH_USD,
  liquidity_usd: liquidity,
});

describe("the live chain reading", () => {
  it("reproduces the observed price from real pool state", () => {
    const index = computeTaoUsdIndex({ pools: LIVE_POOLS, ethUsd: ETH_USD });
    // Liquidity-weighted median of two pools, the deeper at 195.68.
    expect(index.usd_per_tao).toBeCloseTo(195.68, 2);
    expect(index.price_basis).toBe("wrapped_onchain_median");
    expect(index.pool_count).toBe(2);
    expect(index.pools_excluded).toEqual([]);
    expect(index.eth_usd).toBe(ETH_USD);
  });

  it("publishes the anchor leg so the composition is checkable", () => {
    // The index is a product of two readings; a consumer that cannot see both
    // cannot verify either.
    const index = computeTaoUsdIndex({ pools: LIVE_POOLS, ethUsd: ETH_USD });
    expect(index.usd_per_tao! / index.eth_usd!).toBeCloseTo(
      LIVE_POOLS[0].eth_per_tao,
      6,
    );
  });
});

describe("degenerate inputs are total, never thrown", () => {
  it("returns a reason for zero pools", () => {
    const index = computeTaoUsdIndex({ pools: [], ethUsd: ETH_USD });
    expect(index.usd_per_tao).toBeNull();
    expect(index.price_basis).toBe("insufficient_pools");
    expect(index.pool_count).toBe(0);
  });

  it("returns a reason for one pool — below the floor", () => {
    expect(MIN_QUALIFYING_POOLS).toBe(2);
    const index = computeTaoUsdIndex({
      pools: [pool("0xa", 195.5, 1_000_000)],
      ethUsd: ETH_USD,
    });
    expect(index.usd_per_tao).toBeNull();
    expect(index.price_basis).toBe("insufficient_pools");
    // The pool is named rather than silently dropped.
    expect(index.pools_excluded).toContain("0xa");
  });

  it("handles pools agreeing exactly", () => {
    const index = computeTaoUsdIndex({
      pools: [pool("0xa", 195.5, 1_000_000), pool("0xb", 195.5, 500_000)],
      ethUsd: ETH_USD,
    });
    expect(index.usd_per_tao).toBeCloseTo(195.5, 6);
    expect(index.pools_excluded).toEqual([]);
  });

  it("excludes a pool with a zero, negative, or non-finite price", () => {
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.5, 1_000_000),
        pool("0xb", 195.6, 900_000),
        { address: "0xzero", eth_per_tao: 0, liquidity_usd: 100 },
        { address: "0xneg", eth_per_tao: -1, liquidity_usd: 100 },
        { address: "0xnan", eth_per_tao: NaN, liquidity_usd: 100 },
        { address: "0xinf", eth_per_tao: Infinity, liquidity_usd: 100 },
      ],
      ethUsd: ETH_USD,
    });
    expect(index.pool_count).toBe(2);
    expect(index.pools_excluded).toEqual(
      expect.arrayContaining(["0xzero", "0xneg", "0xnan", "0xinf"]),
    );
    // The bad readings never reached the statistic.
    expect(index.usd_per_tao).toBeCloseTo(195.5, 1);
  });

  it("excludes a pool with unusable liquidity", () => {
    // Weight must be positive, or the weighted median's total collapses.
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.5, 1_000_000),
        pool("0xb", 195.6, 900_000),
        { address: "0xnoliq", eth_per_tao: 0.1, liquidity_usd: 0 },
      ],
      ethUsd: ETH_USD,
    });
    expect(index.pools_excluded).toContain("0xnoliq");
    expect(index.pool_count).toBe(2);
  });

  it("survives malformed pool objects without throwing", () => {
    const index = computeTaoUsdIndex({
      pools: [null, undefined, {}, { address: 42 }] as unknown as PoolReading[],
      ethUsd: ETH_USD,
    });
    expect(index.usd_per_tao).toBeNull();
    expect(index.price_basis).toBe("insufficient_pools");
  });

  it("tolerates a non-array pools input", () => {
    const index = computeTaoUsdIndex({
      pools: undefined as unknown as PoolReading[],
      ethUsd: ETH_USD,
    });
    expect(index.usd_per_tao).toBeNull();
  });
});

describe("the anchor leg is required", () => {
  it("publishes nothing without a usable ETH price", () => {
    // Without it the number would be denominated in ETH while claiming USD —
    // the one error a consumer could not detect from the payload.
    for (const ethUsd of [0, -1, NaN, Infinity, undefined, null]) {
      const index = computeTaoUsdIndex({
        pools: LIVE_POOLS,
        ethUsd: ethUsd as number,
      });
      expect(index.usd_per_tao).toBeNull();
      expect(index.price_basis).toBe("insufficient_pools");
      expect(index.eth_usd).toBeNull();
    }
  });
});

describe("outlier rejection", () => {
  it("rejects a wildly divergent pool and names it", () => {
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.5, 1_000_000),
        pool("0xb", 195.6, 900_000),
        pool("0xwild", 260, 50_000),
      ],
      ethUsd: ETH_USD,
    });
    expect(index.pools_excluded).toContain("0xwild");
    expect(index.pool_count).toBe(2);
    expect(index.usd_per_tao).toBeCloseTo(195.5, 1);
  });

  it("rejects the real mispricing the survey found", () => {
    // The $55k wTAO/USDC pool quoted 197.17 against a 195.5 consensus —
    // +0.85%, which is inside the 2% threshold and therefore NOT rejected.
    // Recorded so the threshold's actual behaviour is pinned, not assumed.
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.49, 934_565),
        pool("0xb", 195.74, 54_459),
        pool("0xthin", 197.17, 54_877),
      ],
      ethUsd: ETH_USD,
    });
    expect(index.pools_excluded).not.toContain("0xthin");
    expect(index.pool_count).toBe(3);
  });

  it("keeps a pool exactly at the threshold", () => {
    const base = 195.5;
    const atEdge = base * (1 + OUTLIER_THRESHOLD);
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", base, 1_000_000),
        pool("0xb", base, 900_000),
        pool("0xedge", atEdge, 100_000),
      ],
      ethUsd: ETH_USD,
    });
    // Strictly greater than the threshold is rejected; exactly at it is not.
    expect(index.pools_excluded).not.toContain("0xedge");
  });

  it("never manufactures a quorum by rejecting", () => {
    // Three pools, two of which are mutually distant: rejection could leave
    // one survivor. ADR 0025 says publish nothing rather than fall back to the
    // pre-rejection set, which would publish the prices just rejected.
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 100, 1_000_000),
        pool("0xb", 195.5, 900_000),
        pool("0xc", 300, 800_000),
      ],
      ethUsd: ETH_USD,
    });
    expect(index.usd_per_tao).toBeNull();
    expect(index.price_basis).toBe("insufficient_pools");
    expect(index.pool_count).toBe(0);
    // Every pool is accounted for, none silently dropped.
    expect(index.pools_excluded.sort()).toEqual(["0xa", "0xb", "0xc"]);
  });

  it("locates outliers against the unweighted median", () => {
    // A single dominant pool must not get to define "normal" and evict the
    // pools that disagree with it.
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xhuge", 250, 100_000_000),
        pool("0xa", 195.5, 1_000),
        pool("0xb", 195.6, 1_000),
      ],
      ethUsd: ETH_USD,
    });
    // Unweighted median is 195.6, so the huge pool is the outlier — despite
    // holding 100,000x the liquidity of the two that evicted it.
    expect(index.pools_excluded).toContain("0xhuge");
    // The two survivors carry equal weight, so the weighted median is the
    // lower observed value. No interpolation, by design.
    expect(index.usd_per_tao).toBeCloseTo(195.5, 1);
  });
});

describe("weighting is by liquidity", () => {
  it("lets the deeper pool carry the median", () => {
    const deepLow = computeTaoUsdIndex({
      pools: [pool("0xdeep", 195.0, 10_000_000), pool("0xthin", 196.0, 1_000)],
      ethUsd: ETH_USD,
    });
    expect(deepLow.usd_per_tao).toBeCloseTo(195.0, 1);

    const deepHigh = computeTaoUsdIndex({
      pools: [pool("0xthin", 195.0, 1_000), pool("0xdeep", 196.0, 10_000_000)],
      ethUsd: ETH_USD,
    });
    expect(deepHigh.usd_per_tao).toBeCloseTo(196.0, 1);
  });

  it("returns an observed price, never an interpolated one", () => {
    // With a handful of pools, a real quote is more defensible than a number
    // invented between two of them.
    const index = computeTaoUsdIndex({
      pools: [pool("0xa", 195.0, 500_000), pool("0xb", 196.0, 500_000)],
      ethUsd: ETH_USD,
    });
    const observed = [195.0, 196.0];
    expect(observed.some((p) => Math.abs(index.usd_per_tao! - p) < 0.01)).toBe(
      true,
    );
  });

  it("is independent of input order", () => {
    const forward = computeTaoUsdIndex({ pools: LIVE_POOLS, ethUsd: ETH_USD });
    const reversed = computeTaoUsdIndex({
      pools: [...LIVE_POOLS].reverse(),
      ethUsd: ETH_USD,
    });
    expect(forward.usd_per_tao).toBe(reversed.usd_per_tao);
  });
});

describe("exclusions carry a reason", () => {
  // pools_excluded is the ADR's published shape; `exclusions` is what the
  // stored provenance row needs. They must never disagree about WHICH pools
  // dropped out — deriving one from the other downstream would mean
  // re-implementing the rejection rules to guess at them.
  const sameSet = (index: ReturnType<typeof computeTaoUsdIndex>) => {
    expect(index.exclusions.map((e) => e.address).sort()).toEqual(
      [...index.pools_excluded].sort(),
    );
  };

  it("names an outlier as an outlier", () => {
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.5, 1_000_000),
        pool("0xb", 195.6, 900_000),
        pool("0xwild", 260, 50_000),
      ],
      ethUsd: ETH_USD,
    });
    expect(index.exclusions).toEqual([
      { address: "0xwild", reason: "outlier" },
    ]);
    sameSet(index);
  });

  it("distinguishes an unusable reading from a rejected one", () => {
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.5, 1_000_000),
        pool("0xb", 195.6, 900_000),
        { address: "0xnan", eth_per_tao: NaN, liquidity_usd: 100 },
        pool("0xwild", 260, 50_000),
      ],
      ethUsd: ETH_USD,
    });
    const byAddress = new Map(
      index.exclusions.map((e) => [e.address, e.reason]),
    );
    expect(byAddress.get("0xnan")).toBe("unusable_reading");
    expect(byAddress.get("0xwild")).toBe("outlier");
    sameSet(index);
  });

  it("says below_quorum when rejection leaves too few", () => {
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 100, 1_000_000),
        pool("0xb", 195.5, 900_000),
        pool("0xc", 300, 800_000),
      ],
      ethUsd: ETH_USD,
    });
    // Two are outliers against the 195.5 median; the survivor is below the
    // floor on its own. Each is labelled for what actually happened to it.
    const byAddress = new Map(
      index.exclusions.map((e) => [e.address, e.reason]),
    );
    expect(byAddress.get("0xb")).toBe("below_quorum");
    expect(byAddress.get("0xa")).toBe("outlier");
    expect(byAddress.get("0xc")).toBe("outlier");
    sameSet(index);
  });

  it("keeps an unusable reading labelled as such below the floor", () => {
    // Two different reasons in one refusal: the NaN pool was never usable, the
    // other was fine and simply had nobody to be a quorum with. Collapsing
    // both into one label would lose the distinction the row exists to record.
    const index = computeTaoUsdIndex({
      pools: [
        pool("0xa", 195.5, 1_000_000),
        { address: "0xnan", eth_per_tao: NaN, liquidity_usd: 100 },
      ],
      ethUsd: ETH_USD,
    });
    expect(index.usd_per_tao).toBeNull();
    const byAddress = new Map(
      index.exclusions.map((e) => [e.address, e.reason]),
    );
    expect(byAddress.get("0xnan")).toBe("unusable_reading");
    expect(byAddress.get("0xa")).toBe("below_quorum");
    sameSet(index);
  });

  it("says anchor_unavailable when there is no ETH leg", () => {
    const index = computeTaoUsdIndex({
      pools: LIVE_POOLS,
      ethUsd: NaN,
    });
    expect(
      index.exclusions.every((e) => e.reason === "anchor_unavailable"),
    ).toBe(true);
    sameSet(index);
  });

  it("accounts for every pool it was given, on every path", () => {
    // The invariant the provenance row depends on: contributors plus
    // exclusions is exactly the input, with nothing counted twice.
    const inputs = [
      { pools: LIVE_POOLS, ethUsd: ETH_USD },
      { pools: LIVE_POOLS, ethUsd: 0 },
      { pools: [pool("0xa", 195.5, 1_000)], ethUsd: ETH_USD },
      {
        pools: [
          pool("0xa", 100, 1_000),
          pool("0xb", 195.5, 1_000),
          pool("0xc", 300, 1_000),
        ],
        ethUsd: ETH_USD,
      },
      {
        pools: [
          pool("0xa", 195.5, 1_000),
          pool("0xb", 195.6, 1_000),
          { address: "0xbad", eth_per_tao: 0, liquidity_usd: 1 },
        ],
        ethUsd: ETH_USD,
      },
    ];
    for (const input of inputs) {
      const index = computeTaoUsdIndex(input);
      expect(index.pool_count + index.exclusions.length).toBe(
        input.pools.length,
      );
      const addresses = new Set(index.exclusions.map((e) => e.address));
      expect(addresses.size).toBe(index.exclusions.length);
      sameSet(index);
    }
  });
});
