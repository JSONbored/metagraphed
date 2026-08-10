// #10447: which sources reach the headline, and which are reported without
// reaching it. Getting this wrong is silent — the response looks identical.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSubnetRevenue } from "../src/revenue-serving.ts";

const BASE = {
  netuid: 64,
  window_days: 1,
  tao_total_per_block: 0.063615264,
  usd_per_tao: 204.03,
  sources: [],
};

function src(over: Record<string, unknown> = {}) {
  return {
    surface_id: "s",
    provenance: "probe-derived",
    currency: "USD",
    grain: "daily",
    amount_usd: 11668,
    ...over,
  } as never;
}

describe("only readable tiers reach the headline", () => {
  test("probe-derived and chain-verified are summed", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [
        src({ surface_id: "a", amount_usd: 1000 }),
        src({ surface_id: "b", provenance: "chain-verified", amount_usd: 500 }),
      ],
    });
    assert.equal(r.revenue_usd, 1500);
    assert.ok((r.coverage_ratio as number) > 0);
  });

  test("operator-attested is REPORTED but never summed", () => {
    // The endpoint is real and declared; the figure is unverifiable. Adding it
    // would put an unverifiable number in the headline.
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src({ provenance: "operator-attested", amount_usd: 999999 })],
    });
    assert.equal(r.revenue_usd, null, "must not be summed");
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.sources.length, 1, "but it is still reported");
    assert.equal(r.provenance, "operator-attested");
  });

  test("third-party-reported is likewise carried, not counted", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [
        src({ provenance: "third-party-reported", amount_usd: 4260000 }),
      ],
    });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.sources.length, 1);
  });

  test("a readable source with no figure yet does not fabricate one", () => {
    // Declared probe-derived, but the lane has not run. Null, not zero.
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src({ amount_usd: null })],
    });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.subsidy_multiple, null);
  });

  test("mixing a readable figure with an attested one counts only the readable", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [
        src({ surface_id: "readable", amount_usd: 100 }),
        src({
          surface_id: "attested",
          provenance: "operator-attested",
          amount_usd: 900000,
        }),
      ],
    });
    assert.equal(r.revenue_usd, 100);
    assert.equal(r.sources.length, 2);
  });
});

describe("the reported provenance", () => {
  test("the strongest evidence class present wins", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [
        src({ provenance: "operator-attested" }),
        src({ provenance: "chain-verified" }),
        src({ provenance: "probe-derived" }),
      ],
    });
    assert.equal(r.provenance, "chain-verified");
  });

  test("a subnet with no sources reports none, with its search date", () => {
    // 127 of 129 subnets. This is a dated answer, not a gap.
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [],
      searched_at: "2026-08-10T00:00:00Z",
    });
    assert.equal(r.provenance, "none");
    assert.equal(r.revenue_usd, null);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.searched_at, "2026-08-10T00:00:00Z");
    // The emission side is still real and served.
    assert.ok(r.emission.tao > 0);
    assert.equal(r.verification.verified, true);
  });

  test("searched_at defaults to null rather than undefined", () => {
    const r = buildSubnetRevenue({ ...BASE, sources: [] });
    assert.equal(r.searched_at, null);
  });
});

describe("the SN64 shape end to end", () => {
  test("reproduces the published ratio through the serving layer", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      alpha_out_per_block: 1,
      alpha_price_tao: 0.086933658,
      sources: [src()],
    });
    assert.ok(Math.abs((r.subsidy_multiple as number) - 8.0) < 0.05);
    assert.ok(Math.abs((r.coverage_ratio as number) - 0.125) < 0.001);
    assert.equal(r.provenance, "probe-derived");
    assert.equal(r.netuid, 64);
    assert.ok(r.emission.alternates.alpha_out_priced);
  });
});
