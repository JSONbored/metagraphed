import { describe, it, expect } from "vitest";
import {
  OVERLAY_COLORS,
  OVERLAY_METRICS,
  OVERLAY_METRIC_LABEL,
  buildOverlayModel,
  formatOverlayValue,
  overlayColor,
  overlayTotalPoints,
  type OverlayInputSeries,
} from "./overlay-history";
import type { SubnetHistoryPoint } from "./types";

const p = (date: string, extra: Partial<SubnetHistoryPoint> = {}): SubnetHistoryPoint => ({
  snapshot_date: date,
  ...extra,
});

describe("OVERLAY constants", () => {
  it("exposes the four metrics with matching labels", () => {
    expect(OVERLAY_METRICS).toEqual(["neurons", "validators", "stake", "emission"]);
    for (const m of OVERLAY_METRICS) {
      expect(typeof OVERLAY_METRIC_LABEL[m]).toBe("string");
    }
  });

  it("provides six chart color tokens keyed to --chart-N", () => {
    expect(OVERLAY_COLORS).toHaveLength(6);
    OVERLAY_COLORS.forEach((c, i) => expect(c).toBe(`var(--chart-${i + 1})`));
  });
});

describe("overlayColor", () => {
  it("wraps by modulo for any positive index", () => {
    expect(overlayColor(0)).toBe(OVERLAY_COLORS[0]);
    expect(overlayColor(5)).toBe(OVERLAY_COLORS[5]);
    expect(overlayColor(6)).toBe(OVERLAY_COLORS[0]);
    expect(overlayColor(13)).toBe(OVERLAY_COLORS[1]);
  });

  it("normalises negative indices", () => {
    expect(overlayColor(-1)).toBe(OVERLAY_COLORS[1]);
    expect(overlayColor(-6)).toBe(OVERLAY_COLORS[0]);
  });
});

describe("buildOverlayModel", () => {
  it("returns empty ranges when no inputs are given", () => {
    const model = buildOverlayModel([], "stake");
    expect(model.series).toEqual([]);
    expect(model.tMin).toBe(0);
    expect(model.tMax).toBe(0);
    expect(model.vMin).toBe(0);
    expect(model.vMax).toBe(0);
  });

  it("returns empty ranges when inputs carry no finite values", () => {
    const inputs: OverlayInputSeries[] = [
      {
        netuid: 1,
        points: [p("2026-06-01"), p("2026-06-02", { total_stake_tao: Number.NaN })],
      },
    ];
    const model = buildOverlayModel(inputs, "stake");
    expect(model.series[0]!.points).toEqual([]);
    expect(model.tMin).toBe(0);
    expect(model.tMax).toBe(0);
    expect(model.vMin).toBe(0);
    expect(model.vMax).toBe(0);
  });

  it("picks the metric key, drops NaN / undefined, and sorts chronologically", () => {
    const inputs: OverlayInputSeries[] = [
      {
        netuid: 7,
        points: [
          p("2026-06-03", { total_stake_tao: 30 }),
          p("2026-06-01", { total_stake_tao: 10 }),
          p("2026-06-02", { total_stake_tao: Number.NaN }),
          p("2026-06-04", { total_stake_tao: 40 }),
        ],
      },
    ];
    const model = buildOverlayModel(inputs, "stake");
    expect(model.series[0]!.netuid).toBe(7);
    expect(model.series[0]!.points.map((q) => q.v)).toEqual([10, 30, 40]);
    expect(model.vMin).toBe(10);
    expect(model.vMax).toBe(40);
    expect(model.tMin).toBe(Date.parse("2026-06-01"));
    expect(model.tMax).toBe(Date.parse("2026-06-04"));
  });

  it("computes a shared range across multiple subnets", () => {
    const inputs: OverlayInputSeries[] = [
      {
        netuid: 1,
        points: [p("2026-06-01", { neuron_count: 5 }), p("2026-06-05", { neuron_count: 8 })],
      },
      {
        netuid: 2,
        points: [p("2026-06-02", { neuron_count: 2 }), p("2026-06-06", { neuron_count: 20 })],
      },
    ];
    const model = buildOverlayModel(inputs, "neurons");
    expect(model.tMin).toBe(Date.parse("2026-06-01"));
    expect(model.tMax).toBe(Date.parse("2026-06-06"));
    expect(model.vMin).toBe(2);
    expect(model.vMax).toBe(20);
    expect(model.series.map((s) => s.netuid)).toEqual([1, 2]);
  });

  it("skips points with malformed snapshot dates", () => {
    const inputs: OverlayInputSeries[] = [
      {
        netuid: 1,
        points: [p("not-a-date", { validator_count: 5 }), p("2026-06-02", { validator_count: 7 })],
      },
    ];
    const model = buildOverlayModel(inputs, "validators");
    expect(model.series[0]!.points).toEqual([{ t: Date.parse("2026-06-02"), v: 7 }]);
  });

  it("keeps subnets with no finite points but empty series", () => {
    const inputs: OverlayInputSeries[] = [
      { netuid: 1, points: [p("2026-06-01", { total_stake_tao: 10 })] },
      { netuid: 2, points: [] },
    ];
    const model = buildOverlayModel(inputs, "stake");
    expect(model.series).toHaveLength(2);
    expect(model.series[1]!.points).toEqual([]);
  });

  it("picks emission when asked for it", () => {
    const inputs: OverlayInputSeries[] = [
      {
        netuid: 1,
        points: [
          p("2026-06-01", { total_stake_tao: 999, total_emission_tao: 4 }),
          p("2026-06-02", { total_emission_tao: 6 }),
        ],
      },
    ];
    const model = buildOverlayModel(inputs, "emission");
    expect(model.series[0]!.points.map((q) => q.v)).toEqual([4, 6]);
  });
});

describe("formatOverlayValue", () => {
  it("uses formatTao for stake and emission", () => {
    expect(formatOverlayValue("stake", 1234)).toMatch(/τ|TAO|1[,.]/);
    expect(formatOverlayValue("emission", 0)).toMatch(/τ|TAO|0/);
  });

  it("uses formatNumber for counts", () => {
    expect(formatOverlayValue("neurons", 1500)).toContain("1,500");
    expect(formatOverlayValue("validators", 2)).toBe("2");
  });
});

describe("overlayTotalPoints", () => {
  it("sums points across every series", () => {
    const model = buildOverlayModel(
      [
        { netuid: 1, points: [p("2026-06-01", { neuron_count: 1 })] },
        {
          netuid: 2,
          points: [p("2026-06-01", { neuron_count: 2 }), p("2026-06-02", { neuron_count: 3 })],
        },
      ],
      "neurons",
    );
    expect(overlayTotalPoints(model)).toBe(3);
  });

  it("returns 0 for an empty model", () => {
    expect(overlayTotalPoints(buildOverlayModel([], "stake"))).toBe(0);
  });
});
