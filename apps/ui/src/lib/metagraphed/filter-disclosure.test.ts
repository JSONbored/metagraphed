import { describe, expect, it } from "vitest";
import { activeFilterCount, filterToggleLabel } from "./filter-disclosure";

describe("activeFilterCount (#5323)", () => {
  it("counts only non-empty string filters", () => {
    expect(activeFilterCount(["5F3s", "", "42", ""])).toBe(2);
    expect(activeFilterCount(["", "", ""])).toBe(0);
  });

  it("ignores whitespace-only values", () => {
    expect(activeFilterCount(["   ", "\t", "x"])).toBe(1);
  });

  it("ignores non-string values (unset numeric params arrive as undefined)", () => {
    expect(activeFilterCount([undefined, null, 0, "set"])).toBe(1);
  });

  it("handles an empty filter set", () => {
    expect(activeFilterCount([])).toBe(0);
  });
});

describe("filterToggleLabel (#5323)", () => {
  it("stays bare when nothing is filtered", () => {
    expect(filterToggleLabel(0)).toBe("Filters");
  });

  it("surfaces the count so a collapsed bar still shows the list is narrowed", () => {
    expect(filterToggleLabel(1)).toBe("Filters (1)");
    expect(filterToggleLabel(6)).toBe("Filters (6)");
  });

  it("clamps negative / fractional / non-finite counts", () => {
    expect(filterToggleLabel(-2)).toBe("Filters");
    expect(filterToggleLabel(2.7)).toBe("Filters (2)");
    expect(filterToggleLabel(Number.NaN)).toBe("Filters");
  });
});
