import { describe, expect, it } from "vitest";
import type { SubnetHistoryPoint } from "./types";
import {
  OVERLAY_COLORS,
  OVERLAY_METRICS,
  OVERLAY_METRIC_LABEL,
  buildOverlayModel,
  formatOverlayValue,
  overlayColor,
  overlayTotalPoints,
} from "./overlay-history";

// One helper that produces a point with just the fields we need — everything
// else on SubnetHistoryPoint is optional so this stays valid.
function point(date: string, fields: Partial<SubnetHistoryPoint> = {}): SubnetHistoryPoint {
  return { snapshot_date: date, ...fields };
}

describe("OVERLAY_METRICS / labels", () => {
  it("labels every declared metric", () => {
    for (const m of OVERLAY_METRICS) {
      expect(OVERLAY_METRIC_LABEL[m]).toBeTruthy();
    }
  });
  it("exposes at least four distinct chart color tokens", () => {
    expect(new Set(OVERLAY_COLORS).size).toBe(OVERLAY_COLORS.length);
    expect(OVERLAY_COLORS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("overlayColor", () => {
  it("cycles through the palette by index", () => {
    for (let i = 0; i < OVERLAY_COLORS.length * 2 + 3; i++) {
      expect(overlayColor(i)).toBe(OVERLAY_COLORS[i % OVERLAY_COLORS.length]);
    }
  });
  it("handles negative indices without a runtime error", () => {
    expect(overlayColor(-1)).toBe(OVERLAY_COLORS[1 % OVERLAY_COLORS.length]);
  });
});

describe("buildOverlayModel", () => {
  it("returns an empty-range zero model when there are no inputs", () => {
    const m = buildOverlayModel([], "stake");
    expect(m.series).toEqual([]);
    expect(m.tMin).toBe(0);
    expect(m.tMax).toBe(0);
    expect(m.vMin).toBe(0);
    expect(m.vMax).toBe(0);
  });

  it("returns an empty-range zero model when every input is empty", () => {
    const m = buildOverlayModel([{ netuid: 1, points: [] }], "stake");
    expect(m.series).toEqual([{ netuid: 1, points: [] }]);
    expect(m.tMin).toBe(0);
    expect(m.vMax).toBe(0);
  });

  it("keeps the caller's netuid order so the legend matches the input", () => {
    const inputs = [
      { netuid: 43, points: [] },
      { netuid: 1, points: [] },
      { netuid: 7, points: [] },
    ];
    const m = buildOverlayModel(inputs, "neurons");
    expect(m.series.map((s) => s.netuid)).toEqual([43, 1, 7]);
  });

  it("picks the requested metric and coerces bad values away", () => {
    const inputs = [
      {
        netuid: 1,
        points: [
          point("2026-01-01", { neuron_count: 10, total_stake_tao: 5 }),
          point("2026-01-02", { neuron_count: 12 }),
          point("2026-01-03", { neuron_count: Number.NaN }),
          point("2026-01-04", { neuron_count: 14 }),
        ],
      },
    ];
    const m = buildOverlayModel(inputs, "neurons");
    expect(m.series[0]!.points.map((p) => p.v)).toEqual([10, 12, 14]);
  });

  it("skips a point whose snapshot_date does not parse", () => {
    const inputs = [
      {
        netuid: 1,
        points: [
          point("not-a-date", { total_stake_tao: 5 }),
          point("2026-01-02", { total_stake_tao: 7 }),
        ],
      },
    ];
    const m = buildOverlayModel(inputs, "stake");
    expect(m.series[0]!.points.map((p) => p.v)).toEqual([7]);
  });

  it("sorts each series ascending by timestamp", () => {
    const inputs = [
      {
        netuid: 1,
        points: [
          point("2026-01-03", { total_emission_tao: 3 }),
          point("2026-01-01", { total_emission_tao: 1 }),
          point("2026-01-02", { total_emission_tao: 2 }),
        ],
      },
    ];
    const m = buildOverlayModel(inputs, "emission");
    expect(m.series[0]!.points.map((p) => p.v)).toEqual([1, 2, 3]);
  });

  it("computes shared min/max across every series", () => {
    const inputs = [
      {
        netuid: 1,
        points: [
          point("2026-01-01", { validator_count: 10 }),
          point("2026-01-02", { validator_count: 20 }),
        ],
      },
      {
        netuid: 2,
        points: [
          point("2026-01-02", { validator_count: 5 }),
          point("2026-01-04", { validator_count: 40 }),
        ],
      },
    ];
    const m = buildOverlayModel(inputs, "validators");
    expect(m.vMin).toBe(5);
    expect(m.vMax).toBe(40);
    expect(m.tMin).toBe(Date.parse("2026-01-01"));
    expect(m.tMax).toBe(Date.parse("2026-01-04"));
  });

  it("ignores non-numeric metric values (string, null, undefined)", () => {
    const inputs = [
      {
        netuid: 1,
        points: [
          point("2026-01-01", { neuron_count: undefined }),
          // exercise the "not a number" branch — untyped extra keys via `[key: string]: unknown`
          { snapshot_date: "2026-01-02", neuron_count: "bad" } as unknown as SubnetHistoryPoint,
          point("2026-01-03", { neuron_count: 5 }),
        ],
      },
    ];
    const m = buildOverlayModel(inputs, "neurons");
    expect(m.series[0]!.points.map((p) => p.v)).toEqual([5]);
  });
});

describe("formatOverlayValue", () => {
  it("formats stake/emission through formatTao (τ suffix)", () => {
    const s = formatOverlayValue("stake", 1000);
    const e = formatOverlayValue("emission", 1000);
    expect(s).toContain("τ");
    expect(e).toContain("τ");
  });
  it("formats counts through formatNumber (no τ suffix)", () => {
    const n = formatOverlayValue("neurons", 1234);
    const v = formatOverlayValue("validators", 42);
    expect(n).not.toContain("τ");
    expect(v).not.toContain("τ");
  });
});

describe("overlayTotalPoints", () => {
  it("sums points across every series", () => {
    const inputs = [
      {
        netuid: 1,
        points: [
          point("2026-01-01", { neuron_count: 1 }),
          point("2026-01-02", { neuron_count: 2 }),
        ],
      },
      {
        netuid: 2,
        points: [point("2026-01-01", { neuron_count: 3 })],
      },
    ];
    const m = buildOverlayModel(inputs, "neurons");
    expect(overlayTotalPoints(m)).toBe(3);
  });
  it("returns 0 on an empty model", () => {
    expect(overlayTotalPoints(buildOverlayModel([], "stake"))).toBe(0);
  });
});
