import { describe, expect, it } from "vitest";
import {
  SUBNET_HISTORY_METRICS,
  SUBNET_HISTORY_WINDOWS,
  SUBNET_SERIES_COLORS,
  buildOverlayGeometry,
  pickMetricValues,
  subnetSeriesColor,
} from "./subnet-history-metrics";
import type { SubnetHistoryPoint } from "./types";

const point = (date: string, extra: Partial<SubnetHistoryPoint> = {}): SubnetHistoryPoint => ({
  snapshot_date: date,
  ...extra,
});

describe("subnet history metric vocabulary (#6885)", () => {
  it("exposes the same four metrics the single-subnet chart renders", () => {
    expect(SUBNET_HISTORY_METRICS.map((m) => m.key)).toEqual([
      "neurons",
      "validators",
      "stake",
      "emission",
    ]);
  });

  it("formats only the tao-denominated metrics, leaving counts on the default", () => {
    const byKey = Object.fromEntries(SUBNET_HISTORY_METRICS.map((m) => [m.key, m]));
    expect(byKey.neurons!.format).toBeUndefined();
    expect(byKey.validators!.format).toBeUndefined();
    expect(byKey.stake!.format?.(1500)).toBe("1.5k τ");
    expect(byKey.emission!.format?.(1500)).toBe("1.5k τ");
  });

  it("gives every metric a compact picker label that fits a 375px control", () => {
    // The overlay's segmented control wraps (orphaning its last option) once the
    // combined labels exceed the drawer's width at 375px. Budget derived from
    // the measured control: ~7px per uppercase mono char + 20px padding each.
    const width = SUBNET_HISTORY_METRICS.reduce((sum, m) => sum + m.shortLabel.length * 7 + 20, 0);
    expect(width).toBeLessThan(351);
    for (const m of SUBNET_HISTORY_METRICS) {
      expect(m.shortLabel.length).toBeLessThanOrEqual(m.label.length);
      expect(m.shortLabel).not.toHaveLength(0);
    }
  });

  it("keeps the full label for the single-subnet chart's wider rows", () => {
    const byKey = Object.fromEntries(SUBNET_HISTORY_METRICS.map((m) => [m.key, m]));
    expect(byKey.stake!.label).toBe("Total stake");
    expect(byKey.stake!.shortLabel).toBe("Stake");
    expect(byKey.emission!.label).toBe("Total emission");
    expect(byKey.emission!.shortLabel).toBe("Emission");
  });

  it("offers the windows the /history API supports", () => {
    expect(SUBNET_HISTORY_WINDOWS).toEqual(["7d", "30d", "90d", "1y", "all"]);
  });

  it("cycles series colours so a selection larger than the palette still resolves", () => {
    expect(subnetSeriesColor(0)).toBe(SUBNET_SERIES_COLORS[0]);
    expect(subnetSeriesColor(SUBNET_SERIES_COLORS.length)).toBe(SUBNET_SERIES_COLORS[0]);
    expect(subnetSeriesColor(SUBNET_SERIES_COLORS.length + 2)).toBe(SUBNET_SERIES_COLORS[2]);
  });
});

describe("pickMetricValues", () => {
  it("keeps only finite numbers", () => {
    const points = [
      point("2026-01-01", { neuron_count: 10 }),
      point("2026-01-02", { neuron_count: undefined }),
      point("2026-01-03", { neuron_count: Number.NaN }),
      point("2026-01-04", { neuron_count: 12 }),
    ];
    expect(pickMetricValues(points, "neuron_count")).toEqual([10, 12]);
  });

  it("returns an empty array when the metric is absent throughout", () => {
    expect(pickMetricValues([point("2026-01-01")], "total_stake_tao")).toEqual([]);
  });
});

describe("buildOverlayGeometry", () => {
  it("returns null when no subnet has a finite value", () => {
    expect(
      buildOverlayGeometry([{ netuid: 1, points: [point("2026-01-01")] }], "neuron_count", 100, 50),
    ).toBeNull();
  });

  it("aligns subnets on a shared date axis rather than their own indices", () => {
    // SN2 starts a day later; its first point must land at x of 2026-01-02,
    // not at x=0 where naive per-series indexing would put it.
    const geo = buildOverlayGeometry(
      [
        {
          netuid: 1,
          points: [
            point("2026-01-01", { neuron_count: 0 }),
            point("2026-01-02", { neuron_count: 0 }),
            point("2026-01-03", { neuron_count: 0 }),
          ],
        },
        {
          netuid: 2,
          points: [
            point("2026-01-02", { neuron_count: 10 }),
            point("2026-01-03", { neuron_count: 10 }),
          ],
        },
      ],
      "neuron_count",
      100,
      50,
    );

    expect(geo).not.toBeNull();
    expect(geo!.dates).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(geo!.series[1]!.path.startsWith("M50 ")).toBe(true);
  });

  it("shares one y domain across every series", () => {
    const geo = buildOverlayGeometry(
      [
        { netuid: 1, points: [point("2026-01-01", { total_stake_tao: 5 })] },
        { netuid: 2, points: [point("2026-01-01", { total_stake_tao: 95 })] },
      ],
      "total_stake_tao",
      100,
      50,
    );
    expect(geo!.min).toBe(5);
    expect(geo!.max).toBe(95);
  });

  it("breaks the path at a gap instead of interpolating across it", () => {
    // The axis only carries dates some subnet reported, so a hole exists only
    // relative to the union: SN2 supplies 01-02, which SN1 is missing.
    const geo = buildOverlayGeometry(
      [
        {
          netuid: 1,
          points: [
            point("2026-01-01", { neuron_count: 1 }),
            point("2026-01-03", { neuron_count: 3 }),
          ],
        },
        {
          netuid: 2,
          points: [
            point("2026-01-01", { neuron_count: 1 }),
            point("2026-01-02", { neuron_count: 2 }),
            point("2026-01-03", { neuron_count: 3 }),
          ],
        },
      ],
      "neuron_count",
      100,
      50,
    );
    expect(geo!.dates).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    // Two subpaths => two movetos, so nothing is drawn through the missing day.
    expect(geo!.series[0]!.path.match(/M/g)).toHaveLength(2);
    // The subnet with full coverage stays a single unbroken subpath.
    expect(geo!.series[1]!.path.match(/M/g)).toHaveLength(1);
  });

  it("renders an isolated point as a zero-length line so it shows as a dot", () => {
    const geo = buildOverlayGeometry(
      [{ netuid: 7, points: [point("2026-01-01", { neuron_count: 4 })] }],
      "neuron_count",
      100,
      50,
    );
    expect(geo!.series[0]!.path).toBe("M50 25L50 25");
  });

  it("centres a flat series vertically instead of pinning it to an edge", () => {
    const geo = buildOverlayGeometry(
      [
        {
          netuid: 1,
          points: [
            point("2026-01-01", { neuron_count: 8 }),
            point("2026-01-02", { neuron_count: 8 }),
          ],
        },
      ],
      "neuron_count",
      100,
      50,
    );
    expect(geo!.series[0]!.path).toBe("M0 25L100 25");
  });

  it("maps the domain extremes to the padded top and bottom", () => {
    const geo = buildOverlayGeometry(
      [
        {
          netuid: 1,
          points: [
            point("2026-01-01", { neuron_count: 0 }),
            point("2026-01-02", { neuron_count: 100 }),
          ],
        },
      ],
      "neuron_count",
      100,
      50,
    );
    // height 50, pad 2 => min at y=48, max at y=2.
    expect(geo!.series[0]!.path).toBe("M0 48L100 2");
  });

  it("reports the latest finite value per subnet and keeps empty subnets listed", () => {
    const geo = buildOverlayGeometry(
      [
        {
          netuid: 1,
          points: [
            point("2026-01-01", { neuron_count: 1 }),
            point("2026-01-02", { neuron_count: 9 }),
          ],
        },
        { netuid: 2, points: [point("2026-01-01")] },
      ],
      "neuron_count",
      100,
      50,
    );
    expect(geo!.series[0]!.last).toBe(9);
    expect(geo!.series[1]!.last).toBeNull();
    expect(geo!.series[1]!.path).toBe("");
    expect(geo!.series.map((s) => s.netuid)).toEqual([1, 2]);
  });

  it("assigns each subnet a distinct series colour", () => {
    const geo = buildOverlayGeometry(
      [
        { netuid: 1, points: [point("2026-01-01", { neuron_count: 1 })] },
        { netuid: 2, points: [point("2026-01-01", { neuron_count: 2 })] },
      ],
      "neuron_count",
      100,
      50,
    );
    expect(geo!.series[0]!.color).toBe(SUBNET_SERIES_COLORS[0]);
    expect(geo!.series[1]!.color).toBe(SUBNET_SERIES_COLORS[1]);
  });
});
