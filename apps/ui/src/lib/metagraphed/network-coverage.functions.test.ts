// Coverage arithmetic for the network-wide panels (#10300).
//
// The claim under test is one this repo keeps re-learning: an aggregate over a
// partial read is an answer about a subset. These helpers exist so all four
// panels say that the same way, and so the unknown direction always resolves to
// "we cannot claim coverage" rather than to "we covered everything".
import { describe, expect, it } from "vitest";
import {
  unmeasuredCount,
  coverageNote,
  spansBuilderVersions,
  capturesDiverge,
} from "./network-coverage.functions";

describe("unmeasuredCount", () => {
  it("is the difference when both counts are known", () => {
    expect(unmeasuredCount(129, 120)).toBe(9);
  });

  it("is NULL when either count is missing", () => {
    // Not 0. A missing count means we do not know the coverage, and 0 would
    // claim complete coverage — the exact assertion we cannot make.
    expect(unmeasuredCount(null, 120)).toBeNull();
    expect(unmeasuredCount(129, null)).toBeNull();
    expect(unmeasuredCount(undefined, undefined)).toBeNull();
  });

  it("never goes negative", () => {
    // A measured count above the total means the two came from different
    // reads; "-3 unmeasured" is worse than saying nothing.
    expect(unmeasuredCount(120, 129)).toBe(0);
  });

  it("treats a non-finite count as unknown", () => {
    expect(unmeasuredCount(Number.NaN, 10)).toBeNull();
    expect(unmeasuredCount(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("coverageNote", () => {
  it("states the subset when something went unmeasured", () => {
    const note = coverageNote(129, 120);
    expect(note).toContain("120 of 129");
    expect(note).toContain("9 subnets");
    expect(note).toContain("not the network");
  });

  it("says NOTHING when coverage is complete", () => {
    // A caveat printed unconditionally is one readers stop seeing.
    expect(coverageNote(129, 129)).toBeNull();
  });

  it("says nothing when coverage is unknown", () => {
    expect(coverageNote(null, 120)).toBeNull();
  });

  it("singularises one missing item", () => {
    expect(coverageNote(10, 9)).toContain("1 subnet had no reading");
  });
});

describe("spansBuilderVersions", () => {
  it("one version is not a span", () => {
    expect(spansBuilderVersions([1])).toBe(false);
    expect(spansBuilderVersions([1, 1, 1])).toBe(false);
  });

  it("two versions in a window IS a span", () => {
    // Points from different builders are different computations, so a trend
    // across them compares definitions rather than measuring a movement.
    expect(spansBuilderVersions([1, 2])).toBe(true);
  });

  it("an empty list is not a span", () => {
    expect(spansBuilderVersions([])).toBe(false);
  });
});

describe("capturesDiverge", () => {
  const t = (iso: string) => iso;

  it("minutes apart is noise", () => {
    expect(
      capturesDiverge(t("2026-08-10T09:00:00Z"), t("2026-08-10T09:05:00Z")),
    ).toBe(false);
  });

  it("past the threshold the two halves describe different moments", () => {
    expect(
      capturesDiverge(t("2026-08-10T09:00:00Z"), t("2026-08-10T11:00:00Z")),
    ).toBe(true);
  });

  it("is symmetric — order does not decide", () => {
    const a = t("2026-08-10T11:00:00Z");
    const b = t("2026-08-10T09:00:00Z");
    expect(capturesDiverge(a, b)).toBe(capturesDiverge(b, a));
  });

  it("a missing stamp is not a divergence", () => {
    expect(capturesDiverge(null, t("2026-08-10T09:00:00Z"))).toBe(false);
    expect(capturesDiverge(undefined, undefined)).toBe(false);
  });

  it("an UNPARSEABLE stamp is not a divergence either", () => {
    // Date.parse returns NaN, and NaN comparisons are false — but relying on
    // that would have reported "these disagree" for a formatting bug. Unknown
    // is unknown, not a discrepancy.
    expect(capturesDiverge("not-a-date", t("2026-08-10T09:00:00Z"))).toBe(false);
  });
});
