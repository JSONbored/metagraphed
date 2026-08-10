// USD twins on the economics blob (#10381).
//
// The overlay sits where the live-KV and R2 tiers converge, so what matters is
// that a DECLINING index leaves the blob untouched-but-explained rather than
// half-decorated — a row carrying `alpha_price_usd: null` would be
// indistinguishable from a genuine $0 by the time it reached a chart.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  withAlphaVolumeUsd,
  withChainAlphaVolumeUsd,
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

// --- Volume (#10383) -------------------------------------------------------
//
// A 24h total converted at ONE rate. The tests that matter are the ones about
// what is NOT converted: a dimensionless ratio has no currency, and a shared
// distribution component must not sprout USD on a route that never publishes it.

const volume = () => ({
  schema_version: 1,
  netuid: 64,
  window: "24h",
  buy_volume_alpha: 1000,
  sell_volume_alpha: 400,
  total_volume_alpha: 1400,
  buy_volume_tao: 80,
  sell_volume_tao: 32,
  total_volume_tao: 112,
  buy_count: 12,
  sell_count: 5,
  net_volume_alpha: 600,
  sentiment_ratio: 0.714,
  sentiment: "bullish",
  vol_mcap_ratio: 0.02,
});

describe("volume in USD", () => {
  test("the TAO totals convert, at the rate the blob publishes", () => {
    const out = withAlphaVolumeUsd(volume(), reading, NOW) as Record<
      string,
      unknown
    >;
    const rate = reading.usd_per_tao as number;
    assert.equal(out.buy_volume_usd, 80 * rate);
    assert.equal(out.sell_volume_usd, 32 * rate);
    assert.equal(out.total_volume_usd, 112 * rate);
    assert.equal(
      (out.tao_usd as Record<string, unknown>).usd_per_tao,
      rate,
      "the rate rides along so the conversion is auditable",
    );
  });

  test("it SAYS how it was priced", () => {
    // Acceptance 1. "$4.1M of volume" reads identically whether it was summed
    // per trade or converted at the close, and only one of those is what we did.
    const out = withAlphaVolumeUsd(volume(), reading, NOW) as Record<
      string,
      unknown
    >;
    assert.equal(out.usd_pricing_basis, "window_close_rate");
  });

  test("DIMENSIONLESS fields never sprout a USD twin", () => {
    // Acceptance 3. sentiment_ratio is a ratio of two alpha figures and
    // sentiment is a label; neither has a currency to be expressed in.
    // vol_mcap_ratio is likewise a ratio, and the *_alpha totals are alpha --
    // their only available price is the window's own VWAP, which would return
    // total_volume_tao and publish a second name for a number already there.
    const out = withAlphaVolumeUsd(volume(), reading, NOW) as Record<
      string,
      unknown
    >;
    for (const k of [
      "sentiment_usd",
      "sentiment_ratio_usd",
      "vol_mcap_ratio_usd",
      "buy_volume_alpha_usd",
      "sell_volume_alpha_usd",
      "total_volume_alpha_usd",
      "net_volume_alpha_usd",
    ]) {
      assert.ok(!(k in out), `${k} must not exist`);
    }
    // And the originals are untouched.
    assert.equal(out.sentiment, "bullish");
    assert.equal(out.sentiment_ratio, 0.714);
  });

  test("a STALE index prices nothing and names why", () => {
    // Acceptance 2, in the form this route can express it: the 24h window is
    // always inside the index's depth when the index is working, so the failure
    // that actually reaches here is a rate that stopped moving.
    const stale = { ...reading, observed_at: iso(TAO_USD_MAX_AGE_MS + 1) };
    const out = withAlphaVolumeUsd(volume(), stale, NOW) as Record<
      string,
      unknown
    >;
    assert.ok(!("total_volume_usd" in out));
    assert.equal(out.tao_usd_unavailable, "index_stale");
    assert.ok(
      !("usd_pricing_basis" in out),
      "a basis with no priced fields to describe would be noise",
    );
    assert.ok(!("tao_usd" in out));
    // The TAO side is untouched.
    assert.equal(out.total_volume_tao, 112);
  });

  test("`insufficient_pools` is a decline, not a volume of $0", () => {
    const unpriced = {
      ...reading,
      usd_per_tao: null,
      price_basis: "insufficient_pools",
    };
    const out = withAlphaVolumeUsd(volume(), unpriced, NOW) as Record<
      string,
      unknown
    >;
    assert.equal(out.tao_usd_unavailable, "index_unpriced");
    assert.ok(!("total_volume_usd" in out));
  });

  test("USD is declared RECONSTRUCTED even when unavailable", () => {
    // The declaration describes the FIELDS, which exist in the contract whether
    // or not this response could fill them.
    for (const r of [reading, null]) {
      const out = withAlphaVolumeUsd(volume(), r, NOW) as Record<
        string,
        unknown
      >;
      const fs = out.field_sources as Record<string, unknown>;
      assert.deepEqual(fs.total_volume_usd, {
        kind: "reconstructed",
        storage: null,
      });
    }
  });

  test("a non-object payload passes through untouched", () => {
    for (const bad of [null, undefined, 42, "x"]) {
      assert.deepEqual(withAlphaVolumeUsd(bad as never, reading, NOW), bad);
    }
  });
});

describe("network-wide volume in USD", () => {
  const chain = () => ({
    schema_version: 1,
    window: "24h",
    observed_at: "2026-08-10T05:00:00.000Z",
    subnet_count: 2,
    network: {
      buy_volume_tao: 500,
      sell_volume_tao: 250,
      total_volume_tao: 750,
      sentiment_ratio: 0.66,
      sentiment: "bullish",
    },
    volume_distribution: { count: 2, mean: 375, min: 100, max: 650 },
    subnets: [volume(), { ...volume(), netuid: 7 }],
  });

  test("the rollup AND every per-subnet row convert", () => {
    const out = withChainAlphaVolumeUsd(chain(), reading, NOW) as Record<
      string,
      unknown
    >;
    const rate = reading.usd_per_tao as number;
    assert.equal(
      (out.network as Record<string, unknown>).total_volume_usd,
      750 * rate,
    );
    for (const s of out.subnets as Record<string, unknown>[]) {
      assert.equal(s.total_volume_usd, 112 * rate);
    }
  });

  test("volume_distribution is NOT converted", () => {
    // Its shape is IntensityDistribution, a REGISTERED component shared with
    // /chain/network-rollups. Adding _usd there would declare USD on a route
    // that never publishes it; forking it would trade a shared type for a
    // duplicate. A caller multiplies by the published usd_per_tao instead.
    const out = withChainAlphaVolumeUsd(chain(), reading, NOW) as Record<
      string,
      unknown
    >;
    assert.deepEqual(out.volume_distribution, {
      count: 2,
      mean: 375,
      min: 100,
      max: 650,
    });
  });

  test("an unusable index leaves every tier alone and names the reason once", () => {
    const out = withChainAlphaVolumeUsd(chain(), null, NOW) as Record<
      string,
      unknown
    >;
    assert.equal(out.tao_usd_unavailable, "no_index_reading");
    assert.ok(
      !("total_volume_usd" in (out.network as Record<string, unknown>)),
    );
    for (const s of out.subnets as Record<string, unknown>[]) {
      assert.ok(!("total_volume_usd" in s));
    }
  });

  test("a malformed blob degrades instead of throwing", () => {
    for (const bad of [null, undefined, 7]) {
      assert.deepEqual(
        withChainAlphaVolumeUsd(bad as never, reading, NOW),
        bad,
      );
    }
    // A blob whose parts are missing keeps its shape rather than inventing one.
    const out = withChainAlphaVolumeUsd(
      { schema_version: 1 },
      reading,
      NOW,
    ) as Record<string, unknown>;
    assert.equal(out.schema_version, 1);
    assert.equal(out.usd_pricing_basis, "window_close_rate");
  });
});

describe("volume USD, the partial cases", () => {
  test("a missing TAO total is skipped while its siblings price", () => {
    const partial = { ...volume(), buy_volume_tao: null };
    const out = withAlphaVolumeUsd(partial, reading, NOW) as Record<
      string,
      unknown
    >;
    assert.ok(!("buy_volume_usd" in out), "no total, no conversion");
    assert.equal(out.total_volume_usd, 112 * (reading.usd_per_tao as number));
  });

  test("a reading with no block or basis still prices, carrying nulls", () => {
    // The rate is what does the arithmetic; the provenance is what makes it
    // auditable. A thinner reading is less auditable, not unusable.
    const thin: TaoUsdReading = {
      usd_per_tao: reading.usd_per_tao,
      observed_at: reading.observed_at,
      block_number: null,
      price_basis: null,
    };
    const out = withAlphaVolumeUsd(volume(), thin, NOW) as Record<
      string,
      unknown
    >;
    const prov = out.tao_usd as Record<string, unknown>;
    assert.equal(prov.block_number, null);
    assert.equal(prov.price_basis, null);
    assert.equal(prov.observed_at, reading.observed_at);
    assert.equal(out.total_volume_usd, 112 * (reading.usd_per_tao as number));
  });

  test("an existing field_sources is MERGED, never replaced", () => {
    // Clobbering it would drop the measured/reconstructed labels the payload
    // already carried — losing provenance while adding provenance.
    const withSources = {
      ...volume(),
      field_sources: { total_volume_tao: { kind: "measured", storage: "x" } },
    };
    const out = withAlphaVolumeUsd(withSources, reading, NOW) as Record<
      string,
      unknown
    >;
    const fs = out.field_sources as Record<string, unknown>;
    assert.deepEqual(fs.total_volume_tao, { kind: "measured", storage: "x" });
    assert.deepEqual(fs.total_volume_usd, {
      kind: "reconstructed",
      storage: null,
    });
  });
});
