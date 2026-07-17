import { describe, expect, it } from "vitest";
import { totalStakeTrendFromDays } from "./subnets-total-stake-trend";
import type { EconomicsTrendsDay } from "./types";

function day(
  snapshot_date: string,
  total_stake_tao: number | null,
): EconomicsTrendsDay {
  return {
    snapshot_date,
    subnet_count: 1,
    total_stake_tao,
    alpha_price_tao_weighted: null,
    alpha_price_tao_median: null,
    mean_emission_share: null,
    validator_count: null,
    miner_count: null,
  };
}

describe("totalStakeTrendFromDays", () => {
  it("uses newest-first days[0] as the tile value and chronological sparkline points", () => {
    const series = totalStakeTrendFromDays([
      day("2026-07-16", 200),
      day("2026-07-15", 150),
      day("2026-07-14", 100),
    ]);
    expect(series.latestTao).toBe(200);
    expect(series.values).toEqual([100, 150, 200]);
    expect(series.points.map((p) => p.t)).toEqual([
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
    ]);
  });

  it("returns a null latest and empty sparkline series for an empty window", () => {
    const series = totalStakeTrendFromDays([]);
    expect(series.latestTao).toBeNull();
    expect(series.values).toEqual([]);
    expect(series.points).toEqual([]);
  });

  it("coerces null stake samples to 0 on the sparkline while preserving a null latest", () => {
    const series = totalStakeTrendFromDays([day("2026-07-16", null)]);
    expect(series.latestTao).toBeNull();
    expect(series.values).toEqual([0]);
    expect(series.points).toEqual([{ t: "2026-07-16", v: 0 }]);
  });
});
