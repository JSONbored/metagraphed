import { describe, expect, it } from "vitest";
import { normalizePortfolioConcentration, normalizePortfolioPosition } from "./queries";

describe("normalizePortfolioPosition", () => {
  it("coerces a well-formed position and passes yield through unchanged", () => {
    expect(
      normalizePortfolioPosition({
        netuid: 7,
        uid: 42,
        role: "validator",
        active: true,
        stake_tao: 1250.5,
        emission_tao: 3.2,
        rank: 0.9,
        trust: 0.8,
        incentive: 0.5,
        dividends: 0.4,
        yield: 0.00256,
      }),
    ).toEqual({
      netuid: 7,
      uid: 42,
      role: "validator",
      active: true,
      stake_tao: 1250.5,
      emission_tao: 3.2,
      rank: 0.9,
      trust: 0.8,
      incentive: 0.5,
      dividends: 0.4,
      yield: 0.00256,
    });
  });

  it("nulls object/string economic cells and rejects an unknown role", () => {
    // Numeric-looking strings are not finite numbers to the strict coercer — they
    // drop to null rather than render as `[object Object]` or NaN.
    expect(
      normalizePortfolioPosition({
        netuid: 3,
        uid: { attacker: true },
        role: "overlord",
        stake_tao: { attacker: true },
        emission_tao: "1.5",
        yield: null,
      }),
    ).toEqual({
      netuid: 3,
      uid: null,
      role: null,
      active: undefined,
      stake_tao: null,
      emission_tao: null,
      rank: null,
      trust: null,
      incentive: null,
      dividends: null,
      yield: null,
    });
  });

  it("keeps the miner role and a zero-stake null yield", () => {
    const position = normalizePortfolioPosition({
      netuid: 0,
      uid: 1,
      role: "miner",
      active: false,
      stake_tao: 0,
      emission_tao: 0,
      yield: null,
    });
    expect(position?.role).toBe("miner");
    expect(position?.active).toBe(false);
    expect(position?.yield).toBeNull();
  });

  it("drops a row with no numeric netuid or a non-object input", () => {
    expect(normalizePortfolioPosition({ netuid: "abc", uid: 1 })).toBeNull();
    expect(normalizePortfolioPosition(null)).toBeNull();
    expect(normalizePortfolioPosition("nope")).toBeNull();
  });
});

describe("normalizePortfolioConcentration", () => {
  it("keeps finite lenses, nulls a junk typed cell, and passes extra fields through", () => {
    expect(
      normalizePortfolioConcentration({
        holders: 5,
        gini: { attacker: true }, // junk in a typed cell → null (never rendered raw)
        hhi_normalized: 0.31,
        nakamoto_coefficient: 2,
        total: 1000, // an un-typed lens field passes through untouched
      }),
    ).toEqual({
      holders: 5,
      gini: null,
      hhi_normalized: 0.31,
      nakamoto_coefficient: 2,
      total: 1000,
    });
  });

  it("returns null for a null / non-object distribution (cold wallet)", () => {
    expect(normalizePortfolioConcentration(null)).toBeNull();
    expect(normalizePortfolioConcentration(undefined)).toBeNull();
    expect(normalizePortfolioConcentration(42)).toBeNull();
  });
});
