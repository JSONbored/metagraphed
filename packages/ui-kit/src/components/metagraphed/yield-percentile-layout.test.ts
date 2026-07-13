import { describe, expect, it } from "vitest";
import {
  YIELD_PERCENTILE_FOUR_COL_MIN_WIDTH,
  YIELD_PERCENTILE_STRIP_GRID_CLASS,
  YIELD_PERCENTILE_VALUE_CLASS,
  buildYieldPercentileData,
  shouldUseYieldPercentileFourColumnLayout,
} from "./yield-percentile-layout";

describe("yield percentile layout tokens", () => {
  it("pins the four-column container threshold at 28rem (#3934)", () => {
    expect(YIELD_PERCENTILE_FOUR_COL_MIN_WIDTH).toBe("28rem");
  });

  it("scales percentile values down on narrow containers", () => {
    expect(YIELD_PERCENTILE_VALUE_CLASS).toContain("text-sm");
    expect(YIELD_PERCENTILE_VALUE_CLASS).toContain("truncate");
  });

  it("defaults to a 2-column grid and promotes to four columns via container query", () => {
    expect(YIELD_PERCENTILE_STRIP_GRID_CLASS).toContain("grid-cols-2");
    expect(YIELD_PERCENTILE_STRIP_GRID_CLASS).toContain(
      "@min-[28rem]:grid-cols-4",
    );
    expect(YIELD_PERCENTILE_STRIP_GRID_CLASS).not.toContain("sm:grid-cols-4");
  });
});

describe("shouldUseYieldPercentileFourColumnLayout", () => {
  it("returns false below the 28rem threshold (tablet half-width card)", () => {
    // 768px viewport, md two-up row → ~384px card interior minus padding.
    expect(shouldUseYieldPercentileFourColumnLayout(360)).toBe(false);
    expect(shouldUseYieldPercentileFourColumnLayout(447)).toBe(false);
  });

  it("returns true at and above the 28rem threshold", () => {
    expect(shouldUseYieldPercentileFourColumnLayout(448)).toBe(true);
    expect(shouldUseYieldPercentileFourColumnLayout(736)).toBe(true);
  });

  it("rejects non-finite widths", () => {
    expect(shouldUseYieldPercentileFourColumnLayout(Number.NaN)).toBe(false);
    expect(shouldUseYieldPercentileFourColumnLayout(-1)).toBe(false);
    expect(shouldUseYieldPercentileFourColumnLayout(0)).toBe(false);
  });
});

describe("buildYieldPercentileData", () => {
  const formatYield = (v?: number | null) =>
    v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toPrecision(5)}%`;

  it("emits four tiles in p25 → median → p75 → p90 order", () => {
    const tiles = buildYieldPercentileData({
      p25_yield: 0.000016,
      median_yield: 0.000016,
      p75_yield: 0.007467,
      p90_yield: 0.012,
      formatYield,
    });
    expect(tiles.map((t) => t.key)).toEqual(["p25", "median", "p75", "p90"]);
    expect(tiles.map((t) => t.label)).toEqual(["p25", "Median", "p75", "p90"]);
  });

  it("formats each percentile independently so adjacent strings stay distinct", () => {
    const tiles = buildYieldPercentileData({
      p25_yield: 0.000016,
      median_yield: 0.0000161,
      p75_yield: 0.007467,
      p90_yield: 0.007468,
      formatYield,
    });
    const values = tiles.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((v) => v.endsWith("%"))).toBe(true);
  });

  it("passes null yields through the formatter as em-dash fallbacks", () => {
    const tiles = buildYieldPercentileData({
      p25_yield: null,
      median_yield: undefined,
      p75_yield: 0.01,
      p90_yield: null,
      formatYield,
    });
    expect(tiles[0]?.value).toBe("—");
    expect(tiles[1]?.value).toBe("—");
    expect(tiles[2]?.value).toBe("1.0000%");
    expect(tiles[3]?.value).toBe("—");
  });
});
