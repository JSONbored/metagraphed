import { describe, expect, it } from "vitest";
import { coverageMissingSummary } from "./coverage-summary";

describe("coverageMissingSummary", () => {
  it("reports 'all present' when nothing is missing", () => {
    expect(coverageMissingSummary(0)).toEqual({ label: "all present", complete: true });
  });

  it("reports the count when kinds are missing", () => {
    expect(coverageMissingSummary(1)).toEqual({ label: "1 missing", complete: false });
    expect(coverageMissingSummary(5)).toEqual({ label: "5 missing", complete: false });
  });

  it("clamps negative / fractional / non-finite counts", () => {
    expect(coverageMissingSummary(-3)).toEqual({ label: "all present", complete: true });
    expect(coverageMissingSummary(2.9)).toEqual({ label: "2 missing", complete: false });
    expect(coverageMissingSummary(Number.NaN)).toEqual({ label: "all present", complete: true });
  });
});
