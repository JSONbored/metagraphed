import { describe, expect, it } from "vitest";
import { fmtYield } from "./yield-format";

describe("fmtYield (yield-format)", () => {
  it("returns the em-dash fallback for nullish / non-finite input", () => {
    expect(fmtYield(null)).toBe("—");
    expect(fmtYield(undefined)).toBe("—");
    expect(fmtYield(Number.NaN)).toBe("—");
    expect(fmtYield(Infinity)).toBe("—");
  });

  it("renders exactly zero as a plain 0%", () => {
    expect(fmtYield(0)).toBe("0%");
  });

  it("uses 2 decimal places once the percentage reaches 1%", () => {
    expect(fmtYield(0.5)).toBe("50.00%");
    expect(fmtYield(0.01)).toBe("1.00%");
  });

  it("preserves distinct strings for clustered validator-scale yields (#3946)", () => {
    const raw = [
      4.1721e-5, 4.1529e-5, 4.1496e-5, 4.1425e-5, 4.1359e-5, 4.1306e-5, 4.1225e-5, 4.1128e-5,
      4.0711e-5, 4.056e-5,
    ];
    const formatted = raw.map((v) => fmtYield(v));
    expect(new Set(formatted).size).toBe(formatted.length);
  });

  it("formats issue #3934 collision values with visible separation when split across cells", () => {
    const p25 = fmtYield(0.000016);
    const median = fmtYield(0.0000161);
    const p75 = fmtYield(0.007467);
    const p90 = fmtYield(0.007468);
    expect(p25).not.toBe(median);
    expect(p75).not.toBe(p90);
    expect(`${p25}${median}${p75}${p90}`).not.toBe("0.0016%0.0016%0.7467%");
  });

  it("falls back to exponential notation below the 0.001% precision floor", () => {
    expect(fmtYield(0.0000001)).toBe("1.00e-5%");
  });
});
