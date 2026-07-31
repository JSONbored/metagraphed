// Tests for the TAO/USD ingestion path (#8600): src/uniswap-v3.ts,
// src/tao-usd-observation.ts, src/tao-usd-ingest.ts.
//
// EVERY FIXTURE BELOW IS A REAL CAPTURE, not a hand-written approximation of
// one. LIVE_BATCH is the verbatim JSON-RPC response to the batch this code
// builds, taken from Ethereum mainnet at block 25,650,836 on 2026-07-31, and
// LIVE_HEADER is that block's real header. Typing plausible-looking words by
// hand would have tested the decoder against my belief about Uniswap's
// encoding rather than against Uniswap's encoding.

import { describe, expect, it } from "vitest";
import {
  decodeAddress,
  decodeFirstWord,
  encodeBalanceOf,
  priceToken1PerToken0,
  scaleBalance,
} from "../src/uniswap-v3.ts";
import {
  buildObservationCalls,
  decodeObservation,
  MIN_POOL_TVL_USD,
  TOKENS,
  WTAO_WETH_POOLS,
} from "../src/tao-usd-observation.ts";
import {
  buildIndexRow,
  buildObservationBatch,
  indexBatchResults,
  rowFromBatch,
} from "../src/tao-usd-ingest.ts";

/** Ethereum mainnet block 25,650,836, captured 2026-07-31T05:46:23Z. */
const LIVE_BLOCK_NUMBER = 25_650_836;
const LIVE_TIMESTAMP_SECONDS = 1_785_476_783;

const DEEP_POOL = "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc";
const SECOND_POOL = "0x2982d3295a0e1a99e6e88ece0e93ffdfc5c761ae";

/** The verbatim batch response at that height. Ids match the call plan. */
const LIVE_BATCH = [
  {
    jsonrpc: "2.0",
    id: 0,
    result:
      "0x000000000000000000000000000000000000599837c9d8bdfbdbc116a36146e60000000000000000000000000000000000000000000000000000000000031073000000000000000000000000000000000000000000000000000000000000023000000000000000000000000000000000000000000000000000000000000002d300000000000000000000000000000000000000000000000000000000000002d300000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    jsonrpc: "2.0",
    id: 1,
    result:
      "0x000000000000000000000000000000000000279de80f0b82f03e7bee2f0fc034000000000000000000000000000000000000000000000000000000000002d0b10000000000000000000000000000000000000000000000000000000000000037000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    jsonrpc: "2.0",
    id: 2,
    result:
      "0x000000000000000000000000000000000000000000000000000006abe01f11b4",
  },
  {
    jsonrpc: "2.0",
    id: 3,
    result:
      "0x000000000000000000000000000000000000000000000012ec16ce3057dd3239",
  },
  {
    jsonrpc: "2.0",
    id: 4,
    result:
      "0x00000000000000000000000000000000000027a9a2652abcf572ad1d4fb89843000000000000000000000000000000000000000000000000000000000002d0c800000000000000000000000000000000000000000000000000000000000000520000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    jsonrpc: "2.0",
    id: 5,
    result:
      "0x00000000000000000000000000000000000000000000000000000100484d6a46",
  },
  {
    jsonrpc: "2.0",
    id: 6,
    result:
      "0x0000000000000000000000000000000000000000000000025090174b3b0aa7c1",
  },
];

const liveResults = () => indexBatchResults(LIVE_BATCH);

describe("Uniswap v3 word decoding", () => {
  it("reads sqrtPriceX96 out of a real slot0 return", () => {
    // slot0 returns seven values; sqrtPriceX96 is the first word.
    const word = decodeFirstWord(LIVE_BATCH[1].result);
    expect(word).toBe(BigInt("803524614767681913262939889975348"));
  });

  it("returns null rather than throwing for unreadable results", () => {
    // A reverted call returns "0x"; an unreachable node can return nothing.
    for (const bad of ["0x", "", "0xzz", null, undefined, 42, {}]) {
      expect(decodeFirstWord(bad)).toBeNull();
    }
  });

  it("recovers a price from the real wTAO/WETH pool", () => {
    const word = decodeFirstWord(LIVE_BATCH[1].result)!;
    const price = priceToken1PerToken0(
      word,
      TOKENS.wtao.decimals,
      TOKENS.weth.decimals,
    );
    // wTAO is token0 (0x77e0… sorts below WETH's 0xc02a…), so this is ETH per
    // wTAO directly.
    expect(price).toBeCloseTo(0.10285826704, 10);
  });

  it("recovers the anchor leg from the real WETH/USDC pool", () => {
    const word = decodeFirstWord(LIVE_BATCH[0].result)!;
    const wethPerUsdc = priceToken1PerToken0(
      word,
      TOKENS.usdc.decimals,
      TOKENS.weth.decimals,
    )!;
    // USDC is token0 here, so the leg we want is the reciprocal.
    expect(1 / wethPerUsdc).toBeCloseTo(1900.887, 2);
  });

  it("keeps precision a float square would have lost", () => {
    // The naive form -- (Number(sqrt) / 2 ** 96) ** 2 -- discards low bits of
    // both the value and its square. The bigint path must not agree with it
    // to full double precision, or there was nothing to protect against.
    const sqrt = decodeFirstWord(LIVE_BATCH[0].result)!;
    const naive = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (6 - 18);
    const exact = priceToken1PerToken0(sqrt, 6, 18)!;
    expect(exact).toBeCloseTo(naive, 12);
    expect(exact).not.toBe(naive);
  });

  it("refuses an uninitialised pool instead of returning zero", () => {
    // Zero would survive a naive `>= 0` check and then quietly drag a median.
    expect(priceToken1PerToken0(0n, 18, 18)).toBeNull();
    expect(priceToken1PerToken0(-1n, 18, 18)).toBeNull();
  });

  it("refuses decimals outside the ERC-20 range", () => {
    const sqrt = decodeFirstWord(LIVE_BATCH[1].result)!;
    for (const bad of [-1, 37, 1.5, NaN]) {
      expect(priceToken1PerToken0(sqrt, bad, 18)).toBeNull();
      expect(priceToken1PerToken0(sqrt, 9, bad)).toBeNull();
    }
  });

  it("returns null when the ratio underflows the retained precision", () => {
    // 36 decimals against 0 puts the price below 1e-18, past what the single
    // integer division keeps -- reported as no reading, not as zero.
    expect(priceToken1PerToken0(1n, 0, 36)).toBeNull();
  });

  it("scales real balances without losing the integer part", () => {
    // 350-odd WETH at 18 decimals is ~3.5e20 raw: the exact place a float
    // divide would start shedding digits.
    const weth = scaleBalance(decodeFirstWord(LIVE_BATCH[3].result), 18);
    expect(weth).toBeCloseTo(349.0534046762384, 10);
    const wtao = scaleBalance(decodeFirstWord(LIVE_BATCH[2].result), 9);
    expect(wtao).toBeCloseTo(7335.269306804, 8);
  });

  it("rejects a word that is the right length but not hex", () => {
    // The length check alone would let this through and BigInt() would throw
    // on it — which is exactly the "never throws" promise being kept.
    expect(decodeFirstWord("0x" + "z".repeat(64))).toBeNull();
    expect(decodeFirstWord("0x" + "g".repeat(64))).toBeNull();
  });

  it("returns null rather than Infinity when a balance overflows a double", () => {
    // A balance past ~1e308 makes the float conversion non-finite. Reported as
    // no reading: an Infinity weight would take over the weighted median
    // outright, which is the worst possible way for a bad read to land.
    // The ceiling is ~1e290, not ~1e308: the retained-precision scaling
    // multiplies by 1e18 before the conversion, so the overflow arrives 18
    // orders of magnitude sooner than a bare Number(raw) would suggest.
    expect(scaleBalance(10n ** 291n, 0)).toBeNull();
    expect(scaleBalance(10n ** 280n, 0)).toBeGreaterThan(0);
  });

  it("returns null for unusable balances or decimals", () => {
    expect(scaleBalance(null, 18)).toBeNull();
    expect(scaleBalance(-1n, 18)).toBeNull();
    expect(scaleBalance(1n, -1)).toBeNull();
    expect(scaleBalance(1n, 37)).toBeNull();
    expect(scaleBalance(1n, 1.5)).toBeNull();
    expect(scaleBalance(0n, 18)).toBe(0);
  });

  it("encodes balanceOf calldata lower-cased and left-padded", () => {
    // A checksummed address is valid input everywhere else in this codebase
    // and would produce calldata a node reads as a different account.
    const encoded = encodeBalanceOf(
      "0x433A00819C771b33FA7223a5B3499b24FBCd1bBC",
    );
    expect(encoded).toBe(
      "0x70a08231" +
        "000000000000000000000000433a00819c771b33fa7223a5b3499b24fbcd1bbc",
    );
    expect(encodeBalanceOf("433a00819c771b33fa7223a5b3499b24fbcd1bbc")).toBe(
      encoded,
    );
  });

  it("reads an address out of the low 20 bytes", () => {
    expect(
      decodeAddress(
        "0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      ),
    ).toBe(TOKENS.weth.address);
    expect(decodeAddress("0x")).toBeNull();
  });
});

describe("the call plan", () => {
  it("asks for a price and both balances per TAO pool, plus the anchor", () => {
    const calls = buildObservationCalls();
    expect(calls).toHaveLength(1 + WTAO_WETH_POOLS.length * 3);
    expect(calls[0].id).toBe("anchor:slot0");
    for (const pool of WTAO_WETH_POOLS) {
      expect(calls.some((c) => c.id === `${pool.address}:slot0`)).toBe(true);
      expect(calls.some((c) => c.id === `${pool.address}:wtao`)).toBe(true);
      expect(calls.some((c) => c.id === `${pool.address}:weth`)).toBe(true);
    }
  });

  it("pins every call in the batch to one height", () => {
    // Seven separate `latest` calls straddle block boundaries, and an index
    // composed from two heights is reproducible at neither.
    const batch = buildObservationBatch("0x1876694");
    expect(batch).toHaveLength(buildObservationCalls().length);
    for (const entry of batch) {
      expect(entry.method).toBe("eth_call");
      expect(entry.params[1]).toBe("0x1876694");
    }
  });

  it("matches results by id, not by array position", () => {
    // JSON-RPC permits a batch response in any order. Position-trust here
    // would price wTAO with a USDC balance after one reordering proxy.
    const shuffled = [...LIVE_BATCH].reverse();
    expect(indexBatchResults(shuffled)).toEqual(indexBatchResults(LIVE_BATCH));
  });

  it("drops entries carrying an error rather than binding undefined", () => {
    const withError = LIVE_BATCH.map((entry) =>
      entry.id === 2
        ? { jsonrpc: "2.0", id: 2, error: { code: -32000 } }
        : entry,
    );
    const results = indexBatchResults(withError);
    expect(results.has(`${DEEP_POOL}:wtao`)).toBe(false);
    expect(results.has(`${DEEP_POOL}:slot0`)).toBe(true);
  });

  it("ignores malformed or out-of-range entries", () => {
    expect(indexBatchResults(null).size).toBe(0);
    expect(indexBatchResults({ error: "boom" }).size).toBe(0);
    expect(
      indexBatchResults([{ id: "x" }, { id: 1.5 }, { id: 99 }, null]).size,
    ).toBe(0);
  });
});

describe("decoding a real observation", () => {
  it("reproduces the live reading at block 25,650,836", () => {
    const observation = decodeObservation(liveResults());
    expect(observation.ethUsd).toBeCloseTo(1900.887, 2);
    expect(observation.rejected).toEqual([]);
    expect(observation.pools).toHaveLength(2);
    const [deep, second] = observation.pools;
    expect(deep.address).toBe(DEEP_POOL);
    expect(deep.eth_per_tao * observation.ethUsd!).toBeCloseTo(195.52, 1);
    expect(Math.round(deep.liquidity_usd)).toBe(2_097_718);
    expect(Math.round(second.liquidity_usd)).toBe(296_879);
    // Both clear ADR 0025 criterion 2b at this height.
    expect(deep.liquidity_usd).toBeGreaterThan(MIN_POOL_TVL_USD);
    expect(second.liquidity_usd).toBeGreaterThan(MIN_POOL_TVL_USD);
  });

  it("costs only its own pool when one price does not read", () => {
    const results = liveResults();
    results.delete(`${DEEP_POOL}:slot0`);
    const observation = decodeObservation(results);
    expect(observation.pools.map((p) => p.address)).toEqual([SECOND_POOL]);
    expect(observation.rejected).toEqual([
      { address: DEEP_POOL, reason: "price_unreadable" },
    ]);
    // The anchor and the other pool are untouched.
    expect(observation.ethUsd).toBeCloseTo(1900.887, 2);
  });

  it("rejects a pool whose balances do not read", () => {
    const results = liveResults();
    results.delete(`${DEEP_POOL}:weth`);
    const observation = decodeObservation(results);
    expect(observation.rejected).toEqual([
      { address: DEEP_POOL, reason: "balance_unreadable" },
    ]);
  });

  it("rejects every pool when the anchor leg is missing", () => {
    // Without USD there is nothing to compare against the TVL floor, so a
    // pool is rejected on that basis rather than admitted on an unchecked one.
    const results = liveResults();
    results.delete("anchor:slot0");
    const observation = decodeObservation(results);
    expect(observation.ethUsd).toBeNull();
    expect(observation.pools).toEqual([]);
    expect(observation.rejected.map((r) => r.reason)).toEqual([
      "anchor_unavailable",
      "anchor_unavailable",
    ]);
  });

  it("rejects a pool below the TVL floor and names why", () => {
    // Replace the deep pool's wTAO balance with a dust amount: its price is
    // unchanged, its TVL collapses below ADR 0025 criterion 2b.
    const results = liveResults();
    results.set(`${DEEP_POOL}:wtao`, "0x" + 1n.toString(16).padStart(64, "0"));
    results.set(`${DEEP_POOL}:weth`, "0x" + 1n.toString(16).padStart(64, "0"));
    const observation = decodeObservation(results);
    expect(observation.rejected).toEqual([
      { address: DEEP_POOL, reason: "below_tvl_floor" },
    ]);
  });

  it("returns a defined result for a wholly empty batch", () => {
    const observation = decodeObservation(new Map());
    expect(observation.ethUsd).toBeNull();
    expect(observation.pools).toEqual([]);
    expect(observation.rejected).toHaveLength(WTAO_WETH_POOLS.length);
  });

  it("treats a zero anchor price as no anchor", () => {
    const results = liveResults();
    results.set("anchor:slot0", "0x" + "0".repeat(64));
    expect(decodeObservation(results).ethUsd).toBeNull();
  });
});

describe("the stored row", () => {
  it("is built end to end from the real batch", () => {
    const row = rowFromBatch({
      blockNumber: LIVE_BLOCK_NUMBER,
      blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
      response: LIVE_BATCH,
    })!;
    expect(row.block_number).toBe(LIVE_BLOCK_NUMBER);
    expect(row.usd_per_tao).toBeCloseTo(195.52, 2);
    expect(row.price_basis).toBe("wrapped_onchain_median");
    expect(row.pool_count).toBe(2);
    expect(row.eth_usd).toBeCloseTo(1900.887, 2);
    expect(row.pools.every((p) => p.included)).toBe(true);
  });

  it("times the row by the block, never by the wall clock", () => {
    // This is what makes a re-run collide on the primary key instead of
    // inserting a near-duplicate the constraint cannot see. Asserted against a
    // deliberately OLD height: a live block's timestamp is within seconds of
    // `now`, so a test using the real one would pass either way and prove
    // nothing about which of the two the code actually read.
    const backfill = rowFromBatch({
      blockNumber: 20_000_000,
      blockTimestampSeconds: 1_500_000_000,
      response: LIVE_BATCH,
    })!;
    expect(backfill.observed_at).toBe(1_500_000_000_000);
    expect(backfill.observed_at).toBeLessThan(Date.now() - 86_400_000);
  });

  it("is byte-identical when the same height is ingested twice", () => {
    const once = rowFromBatch({
      blockNumber: LIVE_BLOCK_NUMBER,
      blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
      response: LIVE_BATCH,
    });
    const twice = rowFromBatch({
      blockNumber: LIVE_BLOCK_NUMBER,
      blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
      response: [...LIVE_BATCH].reverse(),
    });
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("records every pool it looked at, with a reason for each absence", () => {
    const results = liveResults();
    results.delete(`${DEEP_POOL}:slot0`);
    const row = buildIndexRow({
      observation: decodeObservation(results),
      blockNumber: LIVE_BLOCK_NUMBER,
      blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
    })!;
    // One pool left, which is below the two-pool floor: nothing publishes,
    // and both pools are still accounted for in the provenance.
    expect(row.usd_per_tao).toBeNull();
    expect(row.price_basis).toBe("insufficient_pools");
    expect(row.pools).toHaveLength(2);
    const byAddress = new Map(row.pools.map((p) => [p.address, p]));
    expect(byAddress.get(DEEP_POOL)).toEqual({
      address: DEEP_POOL,
      included: false,
      reason: "price_unreadable",
    });
    const survivor = byAddress.get(SECOND_POOL)!;
    expect(survivor.included).toBe(false);
    expect(survivor.reason).toBe("below_quorum");
    // It still carries the numbers it was read with — the row has to explain
    // the refusal, not just assert it.
    expect(survivor.eth_per_tao).toBeGreaterThan(0);
    expect(survivor.liquidity_usd).toBeGreaterThan(0);
  });

  it("records a pool once when a caller reports it twice", () => {
    // decodeObservation never puts an address in both lists, but buildIndexRow
    // takes an Observation from anywhere. A pool named in both must appear
    // once, keeping the reading rather than the bare rejection — otherwise the
    // provenance would show two conflicting entries for one pool.
    const observation = decodeObservation(liveResults());
    const withOverlap = {
      ...observation,
      rejected: [{ address: DEEP_POOL, reason: "price_unreadable" }],
    };
    const row = buildIndexRow({
      observation: withOverlap,
      blockNumber: LIVE_BLOCK_NUMBER,
      blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
    })!;
    expect(row.pools.filter((p) => p.address === DEEP_POOL)).toHaveLength(1);
    expect(row.pools.find((p) => p.address === DEEP_POOL)).toMatchObject({
      included: true,
      eth_per_tao: expect.any(Number),
    });
  });

  it("refuses to build a row without a usable height or timestamp", () => {
    const observation = decodeObservation(liveResults());
    for (const blockNumber of [0, -1, 1.5, NaN]) {
      expect(
        buildIndexRow({
          observation,
          blockNumber,
          blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
        }),
      ).toBeNull();
    }
    for (const seconds of [0, -1, 1.5, NaN, Infinity]) {
      expect(
        buildIndexRow({
          observation,
          blockNumber: LIVE_BLOCK_NUMBER,
          blockTimestampSeconds: seconds,
        }),
      ).toBeNull();
    }
  });

  it("still writes a row when the anchor is gone", () => {
    // A null-with-a-reason row is the record that the tick ran and found
    // nothing publishable — strictly more useful than a gap in the series.
    const results = liveResults();
    results.delete("anchor:slot0");
    const row = buildIndexRow({
      observation: decodeObservation(results),
      blockNumber: LIVE_BLOCK_NUMBER,
      blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
    })!;
    expect(row.usd_per_tao).toBeNull();
    expect(row.eth_usd).toBeNull();
    expect(row.price_basis).toBe("insufficient_pools");
    expect(row.pool_count).toBe(0);
    expect(row.pools).toHaveLength(2);
    expect(row.pools.every((p) => p.reason === "anchor_unavailable")).toBe(
      true,
    );
  });

  it("holds the invariant the table's CHECK constraint enforces", () => {
    // "null iff insufficient_pools" — the DB refuses anything else, so the
    // builder must never produce it.
    for (const response of [LIVE_BATCH, [], LIVE_BATCH.slice(0, 1)]) {
      const row = rowFromBatch({
        blockNumber: LIVE_BLOCK_NUMBER,
        blockTimestampSeconds: LIVE_TIMESTAMP_SECONDS,
        response,
      })!;
      expect(row.usd_per_tao === null).toBe(
        row.price_basis === "insufficient_pools",
      );
    }
  });
});
