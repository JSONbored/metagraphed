import { describe, expect, it } from "vitest";

import {
  buildOverlaySeries,
  overlayDomain,
  overlaySeriesColor,
  OVERLAY_SERIES_COLORS,
  type SubnetHistory,
} from "./compare-overlay";

const hist = (netuid: number, ...stakes: (number | undefined)[]): SubnetHistory => ({
  netuid,
  points: stakes.map((v, i) => ({
    snapshot_date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    total_stake_tao: v,
  })),
});

describe("overlaySeriesColor", () => {
  it("assigns distinct colors by index and cycles past the palette length", () => {
    expect(overlaySeriesColor(0)).toBe(OVERLAY_SERIES_COLORS[0]);
    expect(overlaySeriesColor(1)).toBe(OVERLAY_SERIES_COLORS[1]);
    const n = OVERLAY_SERIES_COLORS.length;
    expect(overlaySeriesColor(n)).toBe(OVERLAY_SERIES_COLORS[0]); // wraps
    expect(overlaySeriesColor(n + 2)).toBe(OVERLAY_SERIES_COLORS[2]);
  });
});

describe("buildOverlaySeries", () => {
  it("builds one series per subnet with finite values, in input order", () => {
    const series = buildOverlaySeries([hist(1, 10, 20, 30), hist(7, 5, 6)], "total_stake_tao");
    expect(series.map((s) => s.netuid)).toEqual([1, 7]);
    expect(series[0]!.values).toEqual([10, 20, 30]);
    expect(series[0]!.last).toBe(30);
    expect(series[1]!.last).toBe(6);
    // stable colors by position
    expect(series[0]!.color).toBe(OVERLAY_SERIES_COLORS[0]);
    expect(series[1]!.color).toBe(OVERLAY_SERIES_COLORS[1]);
  });

  it("filters out non-finite values but keeps the finite ones", () => {
    const series = buildOverlaySeries([hist(1, 10, undefined, 30)], "total_stake_tao");
    expect(series[0]!.values).toEqual([10, 30]);
    expect(series[0]!.last).toBe(30);
  });

  it("drops a subnet entirely when it has no finite values for the metric", () => {
    const series = buildOverlaySeries(
      [hist(1, 10, 20), hist(7, undefined, undefined)],
      "total_stake_tao",
    );
    expect(series.map((s) => s.netuid)).toEqual([1]);
  });

  it("returns an empty array for no histories", () => {
    expect(buildOverlaySeries([], "total_stake_tao")).toEqual([]);
  });

  it("reads the requested metric key, not a fixed one", () => {
    const h: SubnetHistory = {
      netuid: 1,
      points: [
        { snapshot_date: "2026-07-01", neuron_count: 100, total_stake_tao: 5 },
        { snapshot_date: "2026-07-02", neuron_count: 110, total_stake_tao: 6 },
      ],
    };
    expect(buildOverlaySeries([h], "neuron_count")[0]!.values).toEqual([100, 110]);
    expect(buildOverlaySeries([h], "total_stake_tao")[0]!.values).toEqual([5, 6]);
  });
});

describe("overlayDomain", () => {
  it("spans the min and max across every series", () => {
    const series = buildOverlaySeries([hist(1, 10, 40), hist(7, 5, 25)], "total_stake_tao");
    expect(overlayDomain(series)).toEqual({ min: 5, max: 40 });
  });

  it("returns null when there is nothing to plot", () => {
    expect(overlayDomain([])).toBeNull();
    expect(overlayDomain(buildOverlaySeries([hist(1)], "total_stake_tao"))).toBeNull();
  });
});
