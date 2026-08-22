import { describe, expect, it } from "vitest";
import { markAriaLabel, momentumAriaLabel } from "./chart-aria";

describe("markAriaLabel", () => {
  it("is the domain label, with the total when the mark carries one", () => {
    expect(markAriaLabel("AUG 22", "7.4T")).toBe("AUG 22 · 7.4T total");
    expect(markAriaLabel("AUG 22", 12)).toBe("AUG 22 · 12 total");
    expect(markAriaLabel("AUG 22")).toBe("AUG 22");
    expect(markAriaLabel("AUG 22", null)).toBe("AUG 22");
    expect(markAriaLabel("AUG 22", "")).toBe("AUG 22");
  });
});

describe("momentumAriaLabel", () => {
  it("reads the unit, the end value, the delta and the range", () => {
    expect(momentumAriaLabel("tokens", "254T", "+89%", "JUN 28 → AUG 22")).toBe(
      "Tokens: 254T, +89% over JUN 28 → AUG 22",
    );
    expect(momentumAriaLabel("tokens", null, "—", "")).toBe(
      "Tokens: no data in the window",
    );
  });
});
