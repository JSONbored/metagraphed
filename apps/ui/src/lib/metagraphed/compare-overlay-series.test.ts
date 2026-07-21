import { describe, expect, it } from "vitest";
import { buildOverlaySeries, OVERLAY_METRICS } from "./compare-overlay-series";
import type { SubnetHistoryPoint } from "./types";

const COLORS = ["c1", "c2", "c3", "c4"];

function point(date: string, extra: Partial<SubnetHistoryPoint>): SubnetHistoryPoint {
  return { snapshot_date: date, ...extra };
}

describe("buildOverlaySeries", () => {
  it("aligns subnets onto the shared sorted union of dates, nulling missing days", () => {
    const chart = buildOverlaySeries(
      [
        {
          netuid: 7,
          points: [
            point("2026-01-01", { total_stake_tao: 100 }),
            point("2026-01-03", { total_stake_tao: 120 }),
          ],
        },
        {
          netuid: 9,
          points: [
            point("2026-01-02", { total_stake_tao: 50 }),
            point("2026-01-03", { total_stake_tao: 60 }),
          ],
        },
      ],
      "stake",
      COLORS,
    );
    // Union of dates, ascending.
    expect(chart.dates).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    // SN7 has no 2026-01-02 → null in the middle; SN9 has no 2026-01-01 → null first.
    expect(chart.series[0]).toMatchObject({
      netuid: 7,
      color: "c1",
      values: [100, null, 120],
      hasData: true,
      lastValue: 120,
    });
    expect(chart.series[1]).toMatchObject({
      netuid: 9,
      color: "c2",
      values: [null, 50, 60],
      hasData: true,
      lastValue: 60,
    });
    // Shared min/max span every finite value across both subnets.
    expect(chart.min).toBe(50);
    expect(chart.max).toBe(120);
    expect(chart.empty).toBe(false);
  });

  it("reads the field for the selected metric and ignores non-finite values", () => {
    const histories = [
      {
        netuid: 1,
        points: [
          point("2026-02-01", {
            total_stake_tao: 10,
            total_emission_tao: 3,
            neuron_count: 256,
          }),
          point("2026-02-02", {
            total_stake_tao: Number.NaN,
            total_emission_tao: 4,
            neuron_count: 256,
          }),
        ],
      },
    ];
    const stake = buildOverlaySeries(histories, "stake", COLORS);
    // The NaN stake day is dropped (null), not coerced.
    expect(stake.series[0].values).toEqual([10, null]);

    const emission = buildOverlaySeries(histories, "emission", COLORS);
    expect(emission.series[0].values).toEqual([3, 4]);

    const neurons = buildOverlaySeries(histories, "neurons", COLORS);
    expect(neurons.series[0].values).toEqual([256, 256]);
  });

  it("marks a cold selection with no finite values as empty and zeroes the scale", () => {
    const chart = buildOverlaySeries(
      [
        { netuid: 3, points: [] },
        { netuid: 4, points: [point("2026-03-01", { neuron_count: 5 })] },
      ],
      "stake", // neither subnet carries stake
      COLORS,
    );
    expect(chart.empty).toBe(true);
    expect(chart.min).toBe(0);
    expect(chart.max).toBe(0);
    expect(chart.series.every((s) => !s.hasData)).toBe(true);
    expect(chart.series.every((s) => s.lastValue === null)).toBe(true);
  });

  it("cycles the colour palette by series index", () => {
    const chart = buildOverlaySeries(
      [1, 2, 3, 4, 5].map((netuid) => ({
        netuid,
        points: [point("2026-04-01", { total_stake_tao: netuid })],
      })),
      "stake",
      COLORS,
    );
    expect(chart.series.map((s) => s.color)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c1", // wraps
    ]);
  });

  it("exposes the four subnet-history metrics", () => {
    expect(OVERLAY_METRICS.map((m) => m.key)).toEqual([
      "stake",
      "emission",
      "neurons",
      "validators",
    ]);
    expect(OVERLAY_METRICS.find((m) => m.key === "stake")?.tao).toBe(true);
    expect(OVERLAY_METRICS.find((m) => m.key === "neurons")?.tao).toBe(false);
  });
});
