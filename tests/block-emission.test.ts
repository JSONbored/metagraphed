// Tests for src/block-emission.ts (#8747).
//
// The anchor case is a real live reading, not a constructed one: TotalIssuance
// = 11,180,113,340,423,226 rao at the time #8740 did the reconstruction, which
// the chain independently confirms yields 0.5 TAO/block via
// Sum(SubnetTaoInEmission + SubnetExcessTao) = 0.500000 across all subnets.

import { describe, expect, it } from "vitest";
import {
  blockEmissionForIssuance,
  DEFAULT_BLOCK_EMISSION_RAO,
  HALVING_SUPPLY_DENOMINATOR_RAO,
} from "../src/block-emission.ts";

/** TotalIssuance as read from finney, 2026-07-30. */
const LIVE_ISSUANCE_RAO = 11_180_113_340_423_226n;

describe("the live chain reading", () => {
  it("derives 0.5 TAO/block after one halving", () => {
    const result = blockEmissionForIssuance(LIVE_ISSUANCE_RAO);
    expect(result).toEqual({
      tao_per_block: 0.5,
      halvings: 1,
      rao_per_block: 500_000_000n,
    });
  });

  it("disagrees with the stale BlockEmission storage item by exactly 2x", () => {
    // The item reads 0x00ca9a3b00000000 = 1_000_000_000 rao = 1 TAO. This
    // assertion is the point of the module: anything reading that storage key
    // is wrong by this factor.
    const result = blockEmissionForIssuance(LIVE_ISSUANCE_RAO);
    expect(DEFAULT_BLOCK_EMISSION_RAO / result!.rao_per_block).toBe(2n);
  });
});

describe("the halving curve", () => {
  it("emits the full rate before the first halving", () => {
    // Below 50% issued, residual < 1, so no halving has occurred.
    const result = blockEmissionForIssuance(
      HALVING_SUPPLY_DENOMINATOR_RAO / 4n,
    );
    expect(result).toEqual({
      tao_per_block: 1,
      halvings: 0,
      rao_per_block: DEFAULT_BLOCK_EMISSION_RAO,
    });
  });

  it("treats a halving as a step, never a ramp", () => {
    // The boundary is exactly half the supply: residual = log2(1/(1-0.5)) = 1.
    const half = HALVING_SUPPLY_DENOMINATOR_RAO / 2n;
    const justBefore = blockEmissionForIssuance(half - 1_000_000_000n);
    const atBoundary = blockEmissionForIssuance(half);

    expect(justBefore!.halvings).toBe(0);
    expect(justBefore!.tao_per_block).toBe(1);
    expect(atBoundary!.halvings).toBe(1);
    expect(atBoundary!.tao_per_block).toBe(0.5);
    // Nothing between them — a step, not an interpolation.
    expect(justBefore!.tao_per_block / atBoundary!.tao_per_block).toBe(2);
  });

  it("halves again at three quarters issued", () => {
    // residual = log2(1/(1-0.75)) = 2.
    const result = blockEmissionForIssuance(
      (HALVING_SUPPLY_DENOMINATOR_RAO * 3n) / 4n,
    );
    expect(result!.halvings).toBe(2);
    expect(result!.tao_per_block).toBe(0.25);
  });

  it("emits the full rate at zero issuance", () => {
    const result = blockEmissionForIssuance(0n);
    expect(result).toEqual({
      tao_per_block: 1,
      halvings: 0,
      rao_per_block: DEFAULT_BLOCK_EMISSION_RAO,
    });
  });
});

describe("precision", () => {
  it("does not lose the low digits of an issuance past 2^53", () => {
    // The #2921 trap: issuance is ~1.1e16 rao, well past Number's exact
    // integer range, and the halving boundary is a step — so a ratio computed
    // through Number() can land on the wrong side of it. Two issuances that
    // straddle the boundary by a single rao must still be distinguished.
    const half = HALVING_SUPPLY_DENOMINATOR_RAO / 2n;
    expect(half > 9_007_199_254_740_992n).toBe(true);
    expect(blockEmissionForIssuance(half - 1n)!.halvings).toBe(0);
    expect(blockEmissionForIssuance(half)!.halvings).toBe(1);
  });
});

describe("refusals", () => {
  it("returns null rather than a guess for unusable issuance", () => {
    expect(blockEmissionForIssuance(null)).toBeNull();
    expect(blockEmissionForIssuance(undefined)).toBeNull();
    expect(blockEmissionForIssuance(-1n)).toBeNull();
    // At or past the denominator, 1 - ratio is zero or negative and log2 of
    // its reciprocal is Infinity or NaN. Unreachable on a live chain; the
    // caller should say "unknown", not invent a number.
    expect(blockEmissionForIssuance(HALVING_SUPPLY_DENOMINATOR_RAO)).toBeNull();
    expect(
      blockEmissionForIssuance(HALVING_SUPPLY_DENOMINATOR_RAO + 1n),
    ).toBeNull();
  });

  it("rejects a non-bigint issuance", () => {
    expect(blockEmissionForIssuance(1_000_000 as unknown as bigint)).toBeNull();
  });
});
