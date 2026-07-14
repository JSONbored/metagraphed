import { describe, expect, it } from "vitest";

import {
  annualizedDelegatorApyPct,
  apyFromRewardsPer1000,
  formatApyPct,
  formatTakePct,
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
});
