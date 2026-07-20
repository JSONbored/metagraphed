import { describe, expect, it } from "vitest";
import { normalizeDomainSummary, normalizeDomainsOverview } from "./queries";

describe("normalizeDomainSummary (#6996)", () => {
  it("normalizes a live-shaped domain rollup", () => {
    const row = normalizeDomainSummary({
      schema_version: 1,
      domain: "Inference",
      subnet_count: 2,
      netuids: [2, "6", 14.0],
      total_stake_tao: 42663451.4604,
      total_emission_share: 0.163342,
      emission_concentration: {
        holders: 15,
        total: 0.1633,
        gini: 0.531804,
        hhi: 0.173868,
        hhi_normalized: 0.114858,
        nakamoto_coefficient: 2,
        top_1pct_share: 0.335223,
        top_10pct_share: 0.535337,
      },
    });
    expect(row).toEqual({
      domain: "inference",
      subnet_count: 2,
      netuids: [2, 6, 14],
      total_stake_tao: 42663451.4604,
      total_emission_share: 0.163342,
      emission_concentration: expect.objectContaining({
        holders: 15,
        gini: 0.531804,
        nakamoto_coefficient: 2,
      }),
      schema_version: 1,
    });
  });

  it("returns null for malformed rows and nulls empty concentration", () => {
    expect(normalizeDomainSummary(null)).toBeNull();
    expect(normalizeDomainSummary({ subnet_count: 1 })).toBeNull();
    const emptyConc = normalizeDomainSummary({
      domain: "agents",
      subnet_count: 0,
      netuids: [],
      emission_concentration: { holders: 0, gini: null },
    });
    expect(emptyConc?.emission_concentration).toBeNull();
  });
});

describe("normalizeDomainsOverview (#6996)", () => {
  it("drops malformed members and backfills domain_count", () => {
    const overview = normalizeDomainsOverview({
      schema_version: 1,
      domains: [
        { domain: "agents", subnet_count: 1, netuids: [74] },
        { subnet_count: 9 },
        { domain: "storage", subnet_count: 3, netuids: [1, 2, 3], total_emission_share: 0.01 },
      ],
    });
    expect(overview.domain_count).toBe(2);
    expect(overview.domains.map((d) => d.domain)).toEqual(["agents", "storage"]);
    expect(overview.schema_version).toBe(1);
  });

  it("degrades a junk payload to an empty overview", () => {
    expect(normalizeDomainsOverview(null)).toEqual({
      domain_count: 0,
      domains: [],
      schema_version: 1,
    });
  });
});
