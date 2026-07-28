import { describe, expect, it } from "vitest";
import { layoutStackedArea, type StackedAreaSeries } from "./stacked-area-mini";

const s = (id: string, values: number[]): StackedAreaSeries => ({
  id,
  label: id,
  values,
  color: "var(--chart-1)",
});

describe("layoutStackedArea (#8370)", () => {
  it("stacks series bottom-up in the order given", () => {
    const { bands, totals, max, slots } = layoutStackedArea([
      s("a", [1, 2, 3]),
      s("b", [10, 10, 10]),
    ]);
    expect(slots).toBe(3);
    expect(bands[0]!.lower).toEqual([0, 0, 0]);
    expect(bands[0]!.upper).toEqual([1, 2, 3]);
    expect(bands[1]!.lower).toEqual([1, 2, 3]);
    expect(bands[1]!.upper).toEqual([11, 12, 13]);
    expect(totals).toEqual([11, 12, 13]);
    expect(max).toBe(13);
  });

  it("clamps negative and non-finite values to 0 instead of tearing the stack", () => {
    const { bands, totals } = layoutStackedArea([
      s("a", [5, -3, Number.NaN]),
      s("b", [1, 1, 1]),
    ]);
    expect(bands[0]!.upper).toEqual([5, 0, 0]);
    expect(totals).toEqual([6, 1, 1]);
  });

  it("right-aligns shorter series against the longest one", () => {
    // A 2-point series stacked with a 4-point one contributes only to the
    // final two slots -- history that begins later must not shift left.
    const { bands, slots } = layoutStackedArea([
      s("long", [1, 1, 1, 1]),
      s("short", [7, 7]),
    ]);
    expect(slots).toBe(4);
    expect(bands[1]!.upper).toEqual([1, 1, 8, 8]);
  });

  it("returns an empty layout for no series", () => {
    const { bands, totals, max, slots } = layoutStackedArea([]);
    expect(bands).toEqual([]);
    expect(totals).toEqual([]);
    expect(max).toBe(0);
    expect(slots).toBe(0);
  });

  it("caps the slot count at 500", () => {
    const { slots } = layoutStackedArea([s("a", new Array(1200).fill(1))]);
    expect(slots).toBe(500);
  });
});
