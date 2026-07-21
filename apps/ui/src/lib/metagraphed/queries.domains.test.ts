import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./queries";

// #6996: normalizeDomain shapes one /api/v1/domains rollup entry (or a
// /api/v1/domains/{tag}/summary object — same shape) into the Domain render
// type, dropping malformed payloads and non-numeric netuids.
describe("normalizeDomain (#6996)", () => {
  const live = {
    schema_version: 1,
    domain: "agents",
    subnet_count: 11,
    netuids: [1, 6, 11, 15],
    total_stake_tao: 30400330.8314,
    total_emission_share: 0.071288,
    emission_concentration: {
      holders: 11,
      gini: 0.338088,
      hhi: 0.129248,
      nakamoto_coefficient: 3,
      top_1pct_share: 0.234275,
      entropy: 3.191075,
    },
  };

  it("maps a live rollup entry field-for-field", () => {
    const d = normalizeDomain(live);
    expect(d).not.toBeNull();
    expect(d?.domain).toBe("agents");
    expect(d?.subnet_count).toBe(11);
    expect(d?.netuids).toEqual([1, 6, 11, 15]);
    expect(d?.total_stake_tao).toBeCloseTo(30400330.8314);
    expect(d?.total_emission_share).toBeCloseTo(0.071288);
    expect(d?.emission_concentration?.gini).toBeCloseTo(0.338088);
    expect(d?.emission_concentration?.nakamoto_coefficient).toBe(3);
  });

  it("returns null when the payload has no domain tag", () => {
    expect(normalizeDomain({ subnet_count: 3 })).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain("agents")).toBeNull();
  });

  it("defaults netuids to an empty array and drops non-numeric entries", () => {
    expect(normalizeDomain({ domain: "compute" })?.netuids).toEqual([]);
    expect(normalizeDomain({ domain: "compute", netuids: [12, "x", null, 27] })?.netuids).toEqual([
      12, 27,
    ]);
  });

  it("tolerates a missing concentration block", () => {
    const d = normalizeDomain({ domain: "data", netuids: [13] });
    expect(d?.emission_concentration).toBeUndefined();
  });

  it("coerces absent numeric fields to undefined rather than 0", () => {
    const d = normalizeDomain({ domain: "storage", netuids: [21] });
    expect(d?.subnet_count).toBeUndefined();
    expect(d?.total_stake_tao).toBeUndefined();
    expect(d?.total_emission_share).toBeUndefined();
  });
});
