import { describe, it, expect } from "vitest";
import {
  coverageLabel,
  coverageNote,
  isHeadlineEligible,
  subsidyLabel,
  tierLabel,
  usdLabel,
} from "./revenue-panel-model";

// #10477: the single most likely way this feature does harm is rendering an
// unmeasured subnet as a measured zero. These tests exist for that one rule.

describe("a null ratio is never a zero", () => {
  it('renders null coverage as "Not observed", not 0%', () => {
    expect(coverageLabel(null)).toBe("Not observed");
    expect(coverageLabel(undefined)).toBe("Not observed");
    expect(coverageLabel(Number.NaN)).toBe("Not observed");
    expect(coverageLabel("0")).toBe("Not observed");
  });

  it("keeps an OBSERVED zero as a real 0%", () => {
    // A subnet measured at zero and a subnet nobody could measure are different
    // facts. Collapsing them is the whole defect.
    expect(coverageLabel(0)).toBe("0.0%");
  });

  it("applies the same rule to the subsidy multiple", () => {
    expect(subsidyLabel(null)).toBe("Not observed");
    expect(subsidyLabel(0)).toBe("0.0×");
    expect(subsidyLabel(8.2)).toBe("8.2×");
  });

  it("says 'no observable external revenue', never 'no revenue'", () => {
    const note = coverageNote(null);
    expect(note).toContain("No observable external revenue");
    expect(note).toContain("has not been judged");
    expect(note).not.toMatch(/\bearns nothing\b|\bno revenue\b/);
  });

  it("switches to the reading caveats once something IS observed", () => {
    const note = coverageNote(1234);
    expect(note).toContain("not an accusation");
    expect(note).not.toContain("No observable external revenue");
  });
});

describe("the provenance tier", () => {
  it("marks only chain-verified and probe-derived as headline-eligible", () => {
    expect(isHeadlineEligible("chain-verified")).toBe(true);
    expect(isHeadlineEligible("probe-derived")).toBe(true);
    for (const tier of [
      "operator-attested",
      "third-party-reported",
      "self-reported",
      "inferred",
      null,
      "",
    ]) {
      expect(isHeadlineEligible(tier)).toBe(false);
    }
  });

  it("labels an unknown tier by its own name rather than inventing one", () => {
    expect(tierLabel("probe-derived")).toBe("Probe-derived");
    expect(tierLabel("something-new")).toBe("something-new");
    expect(tierLabel(null)).toBe("Unrecorded");
    expect(tierLabel(42)).toBe("Unrecorded");
  });
});

describe("dollar figures", () => {
  it("formats an amount that is ALREADY dollars", () => {
    expect(usdLabel(1234.5)).toBe("$1.2k");
    expect(usdLabel(2_500_000)).toBe("$2.50M");
    expect(usdLabel(12.345)).toBe("$12.35");
  });

  it("returns null rather than $0 for an unread figure", () => {
    expect(usdLabel(null)).toBeNull();
    expect(usdLabel("1234")).toBeNull();
    expect(usdLabel(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
