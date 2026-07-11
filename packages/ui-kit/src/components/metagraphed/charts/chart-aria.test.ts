import { describe, expect, it } from "vitest";

import {
  chartSegmentsAriaLabel,
  synthesizeBarMiniAriaLabel,
  synthesizeDonutAriaLabel,
} from "./chart-aria";

describe("chartSegmentsAriaLabel", () => {
  it("joins label/value pairs", () => {
    expect(
      chartSegmentsAriaLabel([
        { label: "stake", value: 3 },
        { label: "serving", value: 1 },
      ]),
    ).toBe("stake 3, serving 1");
  });
});

describe("synthesizeBarMiniAriaLabel", () => {
  it("returns a stable empty-state label", () => {
    expect(synthesizeBarMiniAriaLabel([])).toBe("Bar chart with no data");
  });

  it("summarizes non-empty data", () => {
    expect(synthesizeBarMiniAriaLabel([{ label: "high", value: 2 }])).toBe(
      "high 2",
    );
  });
});

describe("synthesizeDonutAriaLabel", () => {
  it("returns a stable empty-state label", () => {
    expect(synthesizeDonutAriaLabel([])).toBe("Donut chart with no data");
  });

  it("returns a stable zero-total label", () => {
    expect(
      synthesizeDonutAriaLabel([
        { label: "a", value: 0 },
        { label: "b", value: -1 },
      ]),
    ).toBe("Donut chart with no data");
  });

  it("summarizes segments with positive total", () => {
    expect(
      synthesizeDonutAriaLabel([
        { label: "ok", value: 4 },
        { label: "warn", value: 1 },
      ]),
    ).toBe("ok 4, warn 1");
  });
});
