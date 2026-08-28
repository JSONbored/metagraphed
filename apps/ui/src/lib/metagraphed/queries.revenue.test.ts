import { describe, expect, it } from "vitest";
import {
  chainRevenueCoverageQuery,
  normalizeChainRevenueCoverage,
  normalizeSubnetRevenueArtifact,
  subnetRevenueQuery,
} from "./queries";

describe("revenue query normalization", () => {
  it("keeps an unobserved revenue result null instead of converting it to zero", () => {
    const artifact = normalizeSubnetRevenueArtifact(
      {
        schema_version: 1,
        generated_at: "2026-08-27T05:42:32.351Z",
        netuid: 19,
        revenue: {
          netuid: 19,
          window_days: 1,
          emission: {
            basis: "tao_total",
            tao: 37.471356,
            usd: 8945.161259,
            alternates: {
              alpha_out_priced: { tao: 77.4410112, usd: 18486.716447 },
              owner_take: { tao: 6.744672547, usd: 1610.088078 },
            },
          },
          revenue_usd: null,
          coverage_ratio: null,
          subsidy_multiple: null,
          provenance: "none",
          searched_at: null,
          sources: [],
          verification: { verified: true, checks: [] },
        },
      },
      19,
    );

    expect(artifact.netuid).toBe(19);
    expect(artifact.revenue.revenue_usd).toBeNull();
    expect(artifact.revenue.coverage_ratio).toBeNull();
    expect(artifact.revenue.subsidy_multiple).toBeNull();
    expect(artifact.revenue.emission.tao).toBeCloseTo(37.471356);
  });

  it("preserves a genuine observed zero and refuses to invent an evidence state", () => {
    const artifact = normalizeSubnetRevenueArtifact(
      {
        netuid: 7,
        revenue: {
          netuid: 7,
          window_days: 1,
          revenue_usd: 0,
          coverage_ratio: 0,
          subsidy_multiple: null,
          sources: [{ surface_id: "sn-7-revenue" }],
        },
      },
      7,
    );

    expect(artifact.revenue.revenue_usd).toBe(0);
    expect(artifact.revenue.coverage_ratio).toBe(0);
    expect(artifact.revenue.subsidy_multiple).toBeNull();
    expect(artifact.revenue.sources[0]).toMatchObject({
      surface_id: "sn-7-revenue",
      provenance: null,
      contributes: null,
      amount_usd: null,
    });
  });

  it("keeps unobserved subnets in the network coverage list", () => {
    const coverage = normalizeChainRevenueCoverage({
      schema_version: 1,
      generated_at: "2026-08-27T05:42:32.351Z",
      window_days: 1,
      observed_count: 1,
      subnet_count: 2,
      subnets: [
        {
          netuid: 64,
          window_days: 1,
          revenue_usd: 2685.673993,
          coverage_ratio: 0.030315032,
          subsidy_multiple: 32.986935714,
          provenance: "chain-verified",
          emission: { basis: "tao_total", tao: 371.113286, usd: 88585.33, alternates: {} },
          sources: [],
          verification: { verified: true, checks: [] },
        },
        {
          netuid: 19,
          window_days: 1,
          revenue_usd: null,
          coverage_ratio: null,
          subsidy_multiple: null,
          provenance: "none",
          emission: { basis: "tao_total", tao: 37.471356, usd: 8945.16, alternates: {} },
          sources: [],
          verification: { verified: true, checks: [] },
        },
      ],
    });

    expect(coverage).toMatchObject({
      window_days: 1,
      observed_count: 1,
      subnet_count: 2,
    });
    expect(coverage.subnets.map((subnet) => subnet.netuid)).toEqual([64, 19]);
    expect(coverage.subnets[1]?.revenue_usd).toBeNull();
  });

  it("partitions the cache by the requested window", () => {
    expect(subnetRevenueQuery(19, "7d").queryKey).toContain("7d");
    expect(chainRevenueCoverageQuery("30d").queryKey).toContain("30d");
  });
});
