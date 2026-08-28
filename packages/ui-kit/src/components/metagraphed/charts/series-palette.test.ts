import { describe, expect, it } from "vitest";
import {
  CHART_RAMP_SIZE,
  OTHER_KEY,
  SeriesPaletteRegistry,
  collapseOther,
} from "./series-palette";

describe("SeriesPaletteRegistry", () => {
  it("hands out ramp indices in first-seen order and keeps them across re-assignment", () => {
    const r = new SeriesPaletteRegistry();
    r.assign(["a", "b", "c"]);
    expect(r.palette().colorOf("a")).toBe("var(--chart-1)");
    expect(r.palette().colorOf("c")).toBe("var(--chart-3)");
    // A refetch that re-orders the series must not recolour anything.
    r.assign(["c", "a", "d", "b"]);
    expect(r.palette().colorOf("c")).toBe("var(--chart-3)");
    expect(r.palette().colorOf("d")).toBe("var(--chart-4)");
    expect(r.keys()).toEqual(["a", "b", "c", "d"]);
  });

  it(`collapses everything past ${CHART_RAMP_SIZE} into Other, drawn in the neutral residual colour`, () => {
    const r = new SeriesPaletteRegistry();
    const keys = Array.from({ length: 14 }, (_, i) => `s${i + 1}`);
    r.assign(keys);
    const p = r.palette();
    expect(p.colorOf("s11")).toBe("var(--chart-residual)");
    expect(p.colorOf("s12")).toBe("var(--chart-residual)");
    expect(p.isOther("s13")).toBe(true);
    expect(p.isOther("s3")).toBe(false);
    expect(p.indexOf("s14")).toBeNull();
    expect(p.isOther(OTHER_KEY)).toBe(true);
  });

  it("never spends a swatch on the Other key itself", () => {
    const r = new SeriesPaletteRegistry();
    r.assign([OTHER_KEY, "x"]);
    expect(r.palette().colorOf("x")).toBe("var(--chart-1)");
    expect(r.palette().colorOf(OTHER_KEY)).toBe("var(--chart-residual)");
  });
});

describe("collapseOther", () => {
  it("sums the collapsed series into one trailing Other segment and keeps the rest", () => {
    const r = new SeriesPaletteRegistry();
    r.assign(Array.from({ length: 11 }, (_, i) => `s${i + 1}`));
    const segments = [
      { key: "s1", label: "One", value: 5 },
      { key: "s12", label: "Twelve", value: 2 },
      { key: "s13", label: "Thirteen", value: 3 },
    ];
    expect(collapseOther(segments, r)).toEqual([
      { key: "s1", label: "One", value: 5 },
      { key: OTHER_KEY, label: OTHER_KEY, value: 5 },
    ]);
  });

  it("adds no Other segment when nothing collapsed", () => {
    const r = new SeriesPaletteRegistry();
    r.assign(["a"]);
    expect(collapseOther([{ key: "a", label: "A", value: 1 }], r)).toEqual([
      { key: "a", label: "A", value: 1 },
    ]);
  });
});
