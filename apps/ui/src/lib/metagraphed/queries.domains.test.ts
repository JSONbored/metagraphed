import { describe, expect, it } from "vitest";
import { normalizeDomains } from "./queries";

// Shape mirrors GET /api/v1/domains (live-verified 2026-07-21).
const AGENTS = {
  schema_version: 1,
  domain: "agents",
  subnet_count: 11,
  netuids: [1, 6, 11, 15, 62, 66, 74, 98, 115, 118, 121],
  total_stake_tao: 30400330.8314,
  total_emission_share: 0.071288,
  emission_concentration: {
    holders: 11,
    gini: 0.338088,
    hhi: 0.129248,
    hhi_normalized: 0.042172,
    nakamoto_coefficient: 3,
    top_1pct_share: 0.234275,
    top_10pct_share: 0.398272,
    top_20pct_share: 0.523244,
    entropy: 3.191075,
    entropy_normalized: 0.922427,
  },
};

describe("normalizeDomains (#6996)", () => {
  it("passes a well-formed domain through, including nested concentration", () => {
    const [d] = normalizeDomains([AGENTS]);
    expect(d).toMatchObject({
      domain: "agents",
      subnet_count: 11,
      netuids: [1, 6, 11, 15, 62, 66, 74, 98, 115, 118, 121],
      total_stake_tao: 30400330.8314,
      total_emission_share: 0.071288,
    });
    expect(d.emission_concentration).toMatchObject({
      gini: 0.338088,
      nakamoto_coefficient: 3,
      top_10pct_share: 0.398272,
      entropy_normalized: 0.922427,
    });
  });

  it("accepts both a bare array and a { domains: [...] } envelope", () => {
    expect(normalizeDomains([AGENTS])).toHaveLength(1);
    expect(normalizeDomains({ domains: [AGENTS] })).toHaveLength(1);
    expect(normalizeDomains(null)).toEqual([]);
  });

  it("falls back subnet_count to netuids length and filters non-numeric netuids", () => {
    const [d] = normalizeDomains([{ domain: "storage", netuids: [3, "x", 9, null] }]);
    expect(d.netuids).toEqual([3, 9]);
    expect(d.subnet_count).toBe(2);
  });

  it("drops rows without a string domain and coerces junk numbers to undefined", () => {
    const out = normalizeDomains([
      { subnet_count: 5 },
      { domain: "compute", total_stake_tao: "nope", netuids: [1] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("compute");
    expect(out[0].total_stake_tao).toBeUndefined();
  });
});
