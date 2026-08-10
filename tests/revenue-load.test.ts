// #10447: what the route does when a piece is missing, which is the normal
// case rather than the edge case.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadSubnetRevenue,
  revenueSourcesFor,
  taoTotalPerBlock,
} from "../src/revenue-load.ts";

const ECONOMICS = {
  netuid: 64,
  tao_in_emission_tao: 0.012416161,
  excess_tao: 0.051199103,
  alpha_out_emission: 1,
  alpha_price_tao: 0.086933658,
};

const SURFACES = [
  {
    id: "sn-64-chutes-daily-revenue-summary",
    revenue: {
      role: "external-revenue",
      provenance: "probe-derived",
      currency: "USD",
      grain: "daily",
    },
  },
  {
    id: "sn-64-chutes-invocations-usage",
    revenue: { role: "usage-proxy", provenance: "probe-derived" },
  },
  {
    id: "sn-4-targon-miner-stats-api",
    revenue: { role: "miner-payout", provenance: "probe-derived" },
  },
  { id: "sn-64-chutes-models", name: "no revenue block" },
];

describe("taoTotalPerBlock", () => {
  test("sums the two emission channels", () => {
    assert.ok(Math.abs(taoTotalPerBlock(ECONOMICS) - 0.063615264) < 1e-9);
  });

  test("a missing channel contributes zero, not NaN", () => {
    assert.equal(taoTotalPerBlock({ tao_in_emission_tao: 1 }), 1);
    assert.equal(taoTotalPerBlock({ excess_tao: 2 }), 2);
    assert.equal(taoTotalPerBlock({}), 0);
    assert.equal(taoTotalPerBlock(null), 0);
    assert.equal(taoTotalPerBlock({ tao_in_emission_tao: "0.5" }), 0);
  });
});

describe("revenueSourcesFor", () => {
  test("only external-revenue declarations become sources", () => {
    // A response listing SN4's `payout` among its "sources" invites exactly the
    // reading the role vocabulary exists to prevent.
    const sources = revenueSourcesFor(SURFACES);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].surface_id, "sn-64-chutes-daily-revenue-summary");
  });

  test("a declaration carries no figure of its own", () => {
    // #10565: this used to stamp one scalar amount per surface, which is the
    // shape that made a window unrepresentable — one number cannot answer
    // "the last 7 days" for a daily feed. Resolving a declaration against its
    // observation series belongs to revenue-serving.ts, where the grain and
    // supersedes rules live.
    const [s] = revenueSourcesFor(SURFACES);
    assert.equal(s.amount_usd, null);
    assert.equal(s.contributes, false);
  });

  test("supersedes is carried through, not dropped", () => {
    // The registry has declared this since #10441 and the composition layer
    // never read it; summing the subsets put SN64's headline 200x over.
    const [s] = revenueSourcesFor([
      {
        id: "daily-summary",
        revenue: {
          role: "external-revenue",
          provenance: "probe-derived",
          grain: "daily",
          supersedes: ["payments-list", "tao-totals"],
        },
      },
    ]);
    assert.deepEqual(s.supersedes, ["payments-list", "tao-totals"]);
  });

  test("a declaration with no supersedes leaves it undefined, not empty", () => {
    const [s] = revenueSourcesFor(SURFACES);
    assert.equal(s.supersedes, undefined);
  });

  test("a half-built declaration falls back rather than emitting undefined", () => {
    // The schema requires role and provenance, but this function reads whatever
    // reached it. "undefined" rendered into a provenance field would be read by
    // a client as a value.
    const [s] = revenueSourcesFor([
      { id: "bare", revenue: { role: "external-revenue" } },
    ]);
    assert.equal(s.provenance, "none");
    assert.equal(s.currency, "USD");
    assert.equal(s.grain, "cumulative");
  });

  test("junk input yields no sources rather than throwing", () => {
    assert.deepEqual(revenueSourcesFor(null), []);
    assert.deepEqual(revenueSourcesFor(undefined), []);
    assert.deepEqual(revenueSourcesFor([{ id: "x" }]), []);
  });
});

describe("loadSubnetRevenue never throws on a missing piece", () => {
  test("the normal case: declared, not yet observed", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: 204.03,
      searched_at: "2026-08-10T00:00:00Z",
    });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.provenance, "probe-derived");
    // The emission side is fully real even with no revenue.
    assert.ok(Math.abs(r.emission.tao - 458.03) < 0.01);
    assert.ok(r.emission.usd > 0);
  });

  test("with an observation it produces the published ratio", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: 204.03,
      observations: new Map([
        [
          "sn-64-chutes-daily-revenue-summary",
          [
            {
              surface_id: "sn-64-chutes-daily-revenue-summary",
              period: "2026-08-10",
              amount_usd: 11668,
            },
          ],
        ],
      ]),
    });
    assert.ok(Math.abs((r.subsidy_multiple as number) - 8.0) < 0.05);
    assert.ok(Math.abs((r.coverage_ratio as number) - 0.125) < 0.001);
  });

  test("no economics at all still answers, with a zero denominator", () => {
    // An emission-gated or unknown subnet. computeCoverage turns the zero
    // denominator into null ratios rather than Infinity, so "no data" and
    // "gated" converge on the same honest output.
    const r = loadSubnetRevenue({
      netuid: 999,
      window_days: 1,
      economics: null,
      surfaces: null,
      usd_per_tao: 204.03,
    });
    assert.equal(r.emission.tao, 0);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.provenance, "none");
    assert.equal(r.verification.verified, false);
  });

  test("no TAO price yields null ratios rather than a bogus USD figure", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: null,
      observations: new Map([
        [
          "sn-64-chutes-daily-revenue-summary",
          [
            {
              surface_id: "sn-64-chutes-daily-revenue-summary",
              period: "2026-08-10",
              amount_usd: 11668,
            },
          ],
        ],
      ]),
    });
    assert.equal(r.emission.usd, 0);
    assert.equal(r.coverage_ratio, null, "no rate means no USD comparison");
    assert.ok(r.emission.tao > 0, "the TAO denominator is still real");
  });
});
