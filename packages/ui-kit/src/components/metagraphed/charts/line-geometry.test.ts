import { describe, expect, it } from "vitest";
import {
  monthTicks,
  placePoints,
  smoothPath,
  windowDelta,
  windowPoints,
  LINE_VIEWBOX,
  PLOT_RIGHT,
} from "./line-geometry";

const DAY = 86_400_000;
const series = Array.from({ length: 10 }, (_, i) => ({
  t: Date.UTC(2026, 5, 1) + i * DAY,
  v: 10 + i * 5,
}));

describe("placePoints", () => {
  it("maps time to x across the viewBox and value to y with the max at the top", () => {
    const placed = placePoints(series);
    expect(placed[0]!.x).toBe(0);
    expect(placed[placed.length - 1]!.x).toBe(LINE_VIEWBOX.width * PLOT_RIGHT);
    expect(placed[placed.length - 1]!.y).toBeLessThan(placed[0]!.y);
    expect(placed[0]!.y).toBeLessThanOrEqual(LINE_VIEWBOX.height);
  });
  it("does not assume equal spacing", () => {
    const placed = placePoints([
      { t: 0, v: 1 },
      { t: 10, v: 1 },
      { t: 100, v: 1 },
    ]);
    expect(placed.map((p) => Math.round(p.x))).toEqual([0, 113, 1128]);
  });
  it("centres a single point and survives a flat series", () => {
    expect(placePoints([{ t: 5, v: 3 }])[0]!.x).toBe(564);
    const flat = placePoints([
      { t: 0, v: 2 },
      { t: 1, v: 2 },
    ]);
    expect(flat[0]!.y).toBe(flat[1]!.y);
  });
  it("can anchor non-negative count series to zero without exaggerating tiny variance", () => {
    const placed = placePoints(
      [
        { t: 0, v: 7192 },
        { t: 1, v: 7200 },
      ],
      LINE_VIEWBOX,
      { zeroBaseline: true },
    );
    expect(Math.abs(placed[0]!.y - placed[1]!.y)).toBeLessThan(1);
    expect(placed[1]!.y).toBe(20);
  });
});

describe("smoothPath", () => {
  it("starts with a move and uses cubic segments between points", () => {
    const d = smoothPath(placePoints(series));
    expect(d.startsWith("M0 ")).toBe(true);
    expect((d.match(/ C/g) ?? []).length).toBe(series.length - 1);
  });
  it("is a bare move for one point and empty for none", () => {
    expect(smoothPath(placePoints([{ t: 1, v: 1 }]))).toMatch(/^M564 /);
    expect(smoothPath([])).toBe("");
  });
});

describe("windowDelta", () => {
  it("reports the change from the first to the last point inside the window", () => {
    const w = { from: series[4]!.t, to: series[9]!.t };
    expect(windowPoints(series, w)).toHaveLength(6);
    const d = windowDelta(series, w);
    expect(d.start).toBe(30);
    expect(d.end).toBe(55);
    expect(d.label).toBe("+83%");
    expect(d.state).toBe("positive");
  });
  it("signs a fall with a real minus and flags an empty window", () => {
    const falling = [
      { t: 0, v: 100 },
      { t: 1, v: 40 },
    ];
    expect(windowDelta(falling, { from: 0, to: 1 })).toMatchObject({
      label: "−60%",
      state: "negative",
    });
    expect(windowDelta(falling, { from: 5, to: 9 })).toMatchObject({
      label: "—",
      state: "empty",
      ratio: null,
    });
  });
  it("has no ratio when the window starts at zero", () => {
    expect(
      windowDelta(
        [
          { t: 0, v: 0 },
          { t: 1, v: 3 },
        ],
        { from: 0, to: 1 },
      ),
    ).toMatchObject({ ratio: null, label: "—", state: "positive" });
  });
});

describe("monthTicks", () => {
  it("emits one upper-case month label per boundary inside the span, positioned by time", () => {
    const pts = [
      { t: Date.UTC(2026, 4, 20), v: 1 },
      { t: Date.UTC(2026, 7, 22), v: 1 },
    ];
    const ticks = monthTicks(pts);
    expect(ticks.map((t) => t.label)).toEqual(["JUN", "JUL", "AUG"]);
    expect(ticks[0]!.pct).toBeGreaterThan(0);
    expect(ticks[2]!.pct).toBeLessThan(100);
  });
});
