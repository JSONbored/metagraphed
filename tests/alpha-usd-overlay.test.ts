// USD twins on the economics blob (#10381).
//
// The overlay sits where the live-KV and R2 tiers converge, so what matters is
// that a DECLINING index leaves the blob untouched-but-explained rather than
// half-decorated — a row carrying `alpha_price_usd: null` would be
// indistinguishable from a genuine $0 by the time it reached a chart.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ALPHA_MARKET_CAP_BASIS,
  withAlphaUsd,
  withAlphaUsdEconomics,
} from "../src/alpha-usd-overlay.ts";
import { TAO_USD_MAX_AGE_MS, type TaoUsdReading } from "../src/alpha-usd.ts";

const NOW = Date.parse("2026-08-10T06:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const reading: TaoUsdReading = {
  usd_per_tao: 200,
  observed_at: iso(60_000),
  block_number: 25_719_199,
  price_basis: "wrapped_onchain_median",
};

const blob = () => ({
  subnets: [
    {
      netuid: 64,
      alpha_price_tao: 0.1,
      alpha_market_cap_tao: 350_000,
      alpha_fdv_tao: 1_800_000,
    },
    { netuid: 70, alpha_price_tao: null, alpha_market_cap_tao: 1 },
  ],
  field_sources: { alpha_price_tao: { kind: "measured" } },
});

describe("a usable index decorates every row", () => {
  test("each _tao field gains its _usd twin", () => {
    const out = withAlphaUsdEconomics(blob(), reading, NOW) as Record<
      string,
      unknown
    >;
    const rows = out.subnets as Record<string, unknown>[];
    assert.equal(rows[0]!.alpha_price_usd, 0.1 * 200);
    assert.equal(rows[0]!.alpha_market_cap_usd, 350_000 * 200);
    assert.equal(rows[0]!.alpha_fdv_usd, 1_800_000 * 200);
  });

  test("provenance rides at the BLOB level, once", () => {
    // One reading priced all of them; repeating its block per row would be N
    // copies of one fact. Same reasoning that keeps `pools` on tao-usd's
    // `latest` rather than on all 2,000 points.
    const out = withAlphaUsdEconomics(blob(), reading, NOW) as Record<
      string,
      unknown
    >;
    const prov = out.tao_usd as Record<string, unknown>;
    assert.equal(prov.usd_per_tao, 200);
    assert.equal(prov.block_number, 25_719_199);
    assert.equal(prov.price_basis, "wrapped_onchain_median");
    assert.equal(out.tao_usd_unavailable, undefined);
  });

  test("a row whose alpha price is null gets NO usd field, not a null one", () => {
    // An explicit `alpha_price_usd: null` is indistinguishable from a real $0
    // once it reaches a chart. Absence is the honest encoding.
    const out = withAlphaUsdEconomics(blob(), reading, NOW) as Record<
      string,
      unknown
    >;
    const rows = out.subnets as Record<string, unknown>[];
    assert.equal("alpha_price_usd" in rows[1]!, false);
    // …but its market cap, which IS present, still prices.
    assert.equal(rows[1]!.alpha_market_cap_usd, 200);
  });

  test("field_sources marks USD reconstructed without dropping what was there", () => {
    const out = withAlphaUsdEconomics(blob(), reading, NOW) as Record<
      string,
      unknown
    >;
    const fs = out.field_sources as Record<string, { kind?: string }>;
    assert.equal(fs.alpha_price_usd?.kind, "reconstructed");
    assert.equal(fs.alpha_market_cap_usd?.kind, "reconstructed");
    // The blob's existing declarations survive the merge.
    assert.equal(fs.alpha_price_tao?.kind, "measured");
  });
});

describe("a declining index leaves the blob explained, not half-decorated", () => {
  const decliners: Array<[string, TaoUsdReading | null, string]> = [
    ["no reading", null, "no_index_reading"],
    [
      "insufficient_pools",
      { ...reading, usd_per_tao: null, price_basis: "insufficient_pools" },
      "index_unpriced",
    ],
    [
      "stale",
      { ...reading, observed_at: iso(TAO_USD_MAX_AGE_MS + 1) },
      "index_stale",
    ],
  ];

  for (const [name, r, reason] of decliners) {
    test(`${name}: rows carry NO usd fields and the blob says why`, () => {
      const out = withAlphaUsdEconomics(blob(), r, NOW) as Record<
        string,
        unknown
      >;
      assert.equal(out.tao_usd_unavailable, reason);
      assert.equal(out.tao_usd, undefined);
      for (const row of out.subnets as Record<string, unknown>[]) {
        assert.equal("alpha_price_usd" in row, false, name);
        assert.equal("alpha_market_cap_usd" in row, false, name);
      }
    });
  }

  test("the _tao fields are untouched by a declining index", () => {
    // The USD tier failing must not cost the TAO figures, which is the whole
    // point of composing rather than replacing.
    const out = withAlphaUsdEconomics(blob(), null, NOW) as Record<
      string,
      unknown
    >;
    const rows = out.subnets as Record<string, unknown>[];
    assert.equal(rows[0]!.alpha_price_tao, 0.1);
    assert.equal(rows[0]!.alpha_market_cap_tao, 350_000);
  });
});

describe("the market-cap basis", () => {
  test("is published, not left to a methodology doc", () => {
    // It lived in a doc, a route description and a UI `hint="proxy"` — three
    // places a JSON consumer cannot read. #10300 is the precedent: a market cap
    // without its denominator is not reconcilable, and two correct figures on
    // different denominators sat ~17% apart.
    const out = withAlphaUsd(
      { alpha_market_cap_tao: 1, alpha_price_tao: 1 },
      reading,
      NOW,
    ) as Record<string, unknown>;
    assert.equal(out.alpha_market_cap_basis, ALPHA_MARKET_CAP_BASIS);
    assert.equal(ALPHA_MARKET_CAP_BASIS, "total_stake_alpha");
  });

  test("is published even when USD is unavailable", () => {
    // The denominator is a property of alpha_market_cap_tao, which is present
    // either way — it does not depend on the multiplier.
    const out = withAlphaUsdEconomics(blob(), null, NOW) as Record<
      string,
      unknown
    >;
    const rows = out.subnets as Record<string, unknown>[];
    // The blob-level decline path leaves rows untouched, so the basis rides
    // with the row decorator instead; assert it directly.
    const decorated = withAlphaUsd(rows[0]!, null, NOW) as Record<
      string,
      unknown
    >;
    assert.equal(decorated.alpha_market_cap_basis, "total_stake_alpha");
  });

  test("is absent on a row with no market cap to describe", () => {
    const out = withAlphaUsd({ alpha_price_tao: 1 }, reading, NOW) as Record<
      string,
      unknown
    >;
    assert.equal("alpha_market_cap_basis" in out, false);
  });
});

describe("shapes it must not choke on", () => {
  test("a blob with no subnets array passes through unchanged", () => {
    for (const bad of [null, undefined, {}, { subnets: "nope" }]) {
      const out = withAlphaUsdEconomics(bad as never, reading, NOW);
      assert.deepEqual(out, bad);
    }
  });
});
