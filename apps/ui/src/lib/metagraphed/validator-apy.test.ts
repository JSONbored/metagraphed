import { describe, expect, it } from "vitest";

import {
  annualizedDelegatorApyPct,
  APY_IMPLAUSIBLE_PCT,
  apyFromRewardsPer1000,
  formatApyPct,
  formatTakePct,
  isImplausibleApyPct,
  netDailyYield,
} from "./validator-apy";

describe("validator-apy", () => {
  it("annualizes emission÷stake net of take", () => {
    // 1 τ emission / 1000 τ stake per day, 18% take → 0.00082 daily net → ~29.9% APY
    expect(annualizedDelegatorApyPct(1, 1000, 0.18)).toBeCloseTo(29.93, 1);
  });

  it("returns null for zero stake", () => {
    expect(annualizedDelegatorApyPct(1, 0, 0.1)).toBeNull();
    expect(netDailyYield(1, 0, 0.1)).toBeNull();
  });

  it("derives APY from rewards_per_1000_tao", () => {
    expect(apyFromRewardsPer1000(0.5, 0)).toBeCloseTo(18.25, 2);
    expect(apyFromRewardsPer1000(null, 0)).toBeNull();
  });

  it("formats take and APY for display", () => {
    expect(formatTakePct(0.185)).toBe("18.5%");
    expect(formatTakePct(null)).toBe("—");
    expect(formatApyPct(12.456)).toBe("12.5%");
    expect(formatApyPct(null)).toBe("—");
  });

  describe("implausible estimates (#8242)", () => {
    it("buckets tiny-stake outliers instead of printing them", () => {
      // The live validators index showed 242% and 180% for small validators
      // next to the majors' 1-2%, which made the whole column look wrong.
      expect(formatApyPct(242)).toBe(">100%");
      expect(formatApyPct(180.4)).toBe(">100%");
      expect(isImplausibleApyPct(242)).toBe(true);
    });

    it("leaves plausible estimates — including the boundary — untouched", () => {
      expect(formatApyPct(APY_IMPLAUSIBLE_PCT)).toBe("100%");
      expect(isImplausibleApyPct(APY_IMPLAUSIBLE_PCT)).toBe(false);
      expect(formatApyPct(99.4)).toBe("99.4%");
      expect(formatApyPct(2.26)).toBe("2.26%");
    });

    it("treats absent and non-finite values as unknown, not implausible", () => {
      expect(isImplausibleApyPct(null)).toBe(false);
      expect(isImplausibleApyPct(undefined)).toBe(false);
      expect(isImplausibleApyPct(Number.POSITIVE_INFINITY)).toBe(false);
      expect(formatApyPct(Number.POSITIVE_INFINITY)).toBe("—");
    });
  });
});
