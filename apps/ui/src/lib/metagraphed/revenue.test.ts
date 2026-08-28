import { describe, expect, it } from "vitest";
import {
  directoryEvidenceCoverage,
  hasObservedRevenue,
  revenueHeadlineState,
  revenueEvidenceFootnote,
  revenueProvenanceLabel,
  revenueSourcePeriods,
  revenueSourceStatus,
  subsidyMultipleLabel,
} from "./revenue";
import type { SubnetRevenue } from "./types";

const revenue = (overrides: Partial<SubnetRevenue> = {}): SubnetRevenue => ({
  netuid: 64,
  window_days: 1,
  emission: {
    basis: "tao_total",
    tao: 371.113286,
    usd: 88585.33,
    alternates: { alpha_out_priced: null, owner_take: null },
  },
  revenue_usd: 2685.673993,
  provenance: "chain-verified",
  searched_at: null,
  coverage_ratio: 0.030315032,
  subsidy_multiple: 32.986935714,
  sources: [],
  verification: { verified: true, checks: [] },
  ...overrides,
});

describe("revenue display logic", () => {
  it("keeps an observed zero separate from a missing revenue result", () => {
    expect(hasObservedRevenue(revenue({ revenue_usd: 0 }))).toBe(true);
    expect(hasObservedRevenue(revenue({ revenue_usd: null }))).toBe(false);
    expect(revenueHeadlineState(revenue({ revenue_usd: null, provenance: "none" }))).toBe(
      "not-observed",
    );
    expect(revenueHeadlineState(revenue({ revenue_usd: null }))).toBe("unavailable");
    expect(revenueHeadlineState(revenue({ verification: { verified: false, checks: [] } }))).toBe(
      "not-verified",
    );
    expect(revenueHeadlineState(revenue())).toBe("verified");
  });

  it("labels evidence provenance without inventing a confidence score", () => {
    expect(revenueProvenanceLabel("chain-verified")).toBe("Chain verified");
    expect(revenueProvenanceLabel("none")).toBe("Not observed");
    expect(revenueProvenanceLabel(null)).toBe("Evidence unavailable");
  });

  it("keeps source inclusion and period coverage explicit", () => {
    expect(revenueSourceStatus({ contributes: true })).toBe("Included");
    expect(revenueSourceStatus({ contributes: false })).toBe("Excluded");
    expect(revenueSourceStatus({ contributes: null })).toBe("Unknown");
    expect(revenueSourcePeriods({ periods_observed: 1, periods_expected: 7 })).toBe("1 / 7");
    expect(revenueSourcePeriods({ periods_observed: 1 })).toBe("1 observed");
    expect(revenueSourcePeriods({ periods_expected: 7 })).toBe("7 expected");
    expect(revenueSourcePeriods({})).toBe("—");
  });

  it("only computes directory evidence coverage when both counts are real", () => {
    expect(directoryEvidenceCoverage(1, 129)).toBe("0.8%");
    expect(directoryEvidenceCoverage(0, 129)).toBe("0.0%");
    expect(directoryEvidenceCoverage(null, 129)).toBe("—");
    expect(directoryEvidenceCoverage(1, 0)).toBe("—");
  });

  it("treats an unavailable multiple as not applicable, never infinity", () => {
    expect(subsidyMultipleLabel(32.986935714)).toBe("33.0×");
    expect(subsidyMultipleLabel(null)).toBe("Not applicable");
  });

  it("states absence and included sources directly in the section footnote", () => {
    expect(
      revenueEvidenceFootnote(revenue({ revenue_usd: null, provenance: "none" }), "1d"),
    ).toContain("no readable external revenue observed");
    expect(
      revenueEvidenceFootnote(revenue({ verification: { verified: false, checks: [] } }), "1d"),
    ).toContain("has not passed response validation");
    expect(
      revenueEvidenceFootnote(
        revenue({
          sources: [
            {
              surface_id: "daily",
              provenance: "chain-verified",
              currency: "USD",
              grain: "daily",
              amount_usd: 2685.673993,
              contributes: true,
              excluded_reason: null,
            },
          ],
        }),
        "1d",
      ),
    ).toBe("1d · 1 included source · Chain verified");
  });
});
