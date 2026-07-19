import { describe, expect, it } from "vitest";
import {
  buildSubnetBubblePoints,
  percentileRanks,
  type SubnetBubbleSource,
} from "./subnet-bubble-data";

describe("percentileRanks", () => {
  it("returns an empty array for no values", () => {
    expect(percentileRanks([])).toEqual([]);
  });

  it("places a single value at the 50 midpoint", () => {
    expect(percentileRanks([42])).toEqual([50]);
  });

  it("spreads distinct values evenly from 0 to 100, preserving input order", () => {
    expect(percentileRanks([30, 10, 20])).toEqual([100, 0, 50]);
  });

  it("places a tied pair at the mean rank of the tied group", () => {
    // sorted: 5(pos0), 5(pos1), 10(pos2) -> tie group avg position (0+1)/2=0.5
    // -> pct = 0.5/2*100 = 25; the distinct 10 is at position 2 -> pct 100.
    expect(percentileRanks([5, 5, 10])).toEqual([25, 25, 100]);
  });

  it("places every value at 50 when the whole set is tied", () => {
    expect(percentileRanks([7, 7, 7, 7])).toEqual([50, 50, 50, 50]);
  });

  it("handles a tie group in the middle of the range", () => {
    // sorted: 1(0), 5(1), 5(2), 5(3), 9(4) -> tie group avg position (1+3)/2=2
    // -> pct = 2/4*100 = 50.
    expect(percentileRanks([9, 1, 5, 5, 5])).toEqual([100, 0, 50, 50, 50]);
  });
});

describe("buildSubnetBubblePoints", () => {
  it("returns an empty array for no rows", () => {
    expect(buildSubnetBubblePoints([])).toEqual([]);
  });

  it("excludes rows missing emission_share", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, surfaces_count: 10 },
      { netuid: 2, emission_share: 0.01, surfaces_count: 10 },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out.map((p) => p.netuid)).toEqual([2]);
  });

  it("excludes rows missing surfaces_count", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01 },
      { netuid: 2, emission_share: 0.01, surfaces_count: 10 },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out.map((p) => p.netuid)).toEqual([2]);
  });

  it("returns an empty array when every row lacks a required axis metric", () => {
    const rows: SubnetBubbleSource[] = [{ netuid: 1 }, { netuid: 2, emission_share: 0.01 }];
    expect(buildSubnetBubblePoints(rows)).toEqual([]);
  });

  it("positions x by emission_share percentile rank and inverts y so more surfaces renders higher", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01, surfaces_count: 5 },
      { netuid: 2, emission_share: 0.05, surfaces_count: 20 },
    ];
    const out = buildSubnetBubblePoints(rows);
    const low = out.find((p) => p.netuid === 1)!;
    const high = out.find((p) => p.netuid === 2)!;
    expect(low.xPct).toBe(0);
    expect(high.xPct).toBe(100);
    // fewer surfaces -> lower rank -> inverted to a HIGHER yPct (nearer the bottom).
    expect(low.yPct).toBe(100);
    expect(high.yPct).toBe(0);
  });

  it("centers every row at 50/50 when every row shares the same emission_share and surfaces_count", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.02, surfaces_count: 10 },
      { netuid: 2, emission_share: 0.02, surfaces_count: 10 },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out.every((p) => p.xPct === 50 && p.yPct === 50)).toBe(true);
  });

  it("defaults a missing candidates_count to 0", () => {
    const rows: SubnetBubbleSource[] = [{ netuid: 1, emission_share: 0.01, surfaces_count: 5 }];
    const out = buildSubnetBubblePoints(rows);
    expect(out[0].candidatesCount).toBe(0);
  });

  it("sizes bubbles by sqrt-scaled candidates_count so area (not radius) is proportional", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01, surfaces_count: 5, candidates_count: 1 },
      { netuid: 2, emission_share: 0.02, surfaces_count: 6, candidates_count: 4 },
    ];
    const out = buildSubnetBubblePoints(rows);
    const small = out.find((p) => p.netuid === 1)!;
    const big = out.find((p) => p.netuid === 2)!;
    // sqrt(1/4) * 100 = 50, sqrt(4/4) * 100 = 100
    expect(small.sizePct).toBe(50);
    expect(big.sizePct).toBe(100);
  });

  it("falls back to sizePct 0 when every row's candidates_count is 0 (zero max)", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01, surfaces_count: 5, candidates_count: 0 },
      { netuid: 2, emission_share: 0.02, surfaces_count: 6 },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out.every((p) => p.sizePct === 0)).toBe(true);
  });

  it("defaults a missing health to unknown", () => {
    const rows: SubnetBubbleSource[] = [{ netuid: 1, emission_share: 0.01, surfaces_count: 5 }];
    const out = buildSubnetBubblePoints(rows);
    expect(out[0].health).toBe("unknown");
  });

  it("passes through a provided health value", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01, surfaces_count: 5, health: "ok" },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out[0].health).toBe("ok");
  });

  it("interpolates diameterPx between the default min/max bounds by sizePct", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01, surfaces_count: 5, candidates_count: 0 },
      { netuid: 2, emission_share: 0.02, surfaces_count: 6, candidates_count: 4 },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out.find((p) => p.netuid === 1)!.diameterPx).toBe(14);
    expect(out.find((p) => p.netuid === 2)!.diameterPx).toBe(48);
  });

  it("honors custom min/max diameter bounds", () => {
    const rows: SubnetBubbleSource[] = [
      { netuid: 1, emission_share: 0.01, surfaces_count: 5, candidates_count: 0 },
      { netuid: 2, emission_share: 0.02, surfaces_count: 6, candidates_count: 4 },
    ];
    const out = buildSubnetBubblePoints(rows, { minDiameterPx: 10, maxDiameterPx: 20 });
    expect(out.find((p) => p.netuid === 1)!.diameterPx).toBe(10);
    expect(out.find((p) => p.netuid === 2)!.diameterPx).toBe(20);
  });

  it("carries netuid/name/symbol through unchanged", () => {
    const rows: SubnetBubbleSource[] = [
      {
        netuid: 7,
        name: "Subnet Seven",
        symbol: "SEV",
        emission_share: 0.01,
        surfaces_count: 5,
      },
    ];
    const out = buildSubnetBubblePoints(rows);
    expect(out[0]).toMatchObject({ netuid: 7, name: "Subnet Seven", symbol: "SEV" });
  });
});
