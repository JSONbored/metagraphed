// The alpha-in-USD composition primitive (#10380).
//
// The multiply is one line. Everything worth testing is the unhappy paths,
// because that is where the failure is SILENT: a helper that multiplies
// whatever rate it last saw keeps serving a number, and a stale dollar figure
// looks exactly like a fresh one. #9704 is the same shape — a read with no live
// writer behind it, at 200 OK — and it cost two days of a frozen snapshot.
//
// So the declining cases come first here, and the happy path is one test.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { TABLE_FRESHNESS } from "../src/table-freshness-watchdog.ts";
import {
  ALPHA_USD_FIELD_SOURCE,
  TAO_USD_MAX_AGE_MS,
  alphaUsd,
  taoUsdUsable,
  type TaoUsdReading,
} from "../src/alpha-usd.ts";

const NOW = Date.parse("2026-08-10T06:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const healthy: TaoUsdReading = {
  usd_per_tao: 204.125,
  observed_at: iso(60_000),
  block_number: 25_719_199,
  price_basis: "wrapped_onchain_median",
};

describe("the index must be usable before anything is priced", () => {
  test("no reading at all is refused, not treated as zero", () => {
    for (const empty of [null, undefined]) {
      assert.deepEqual(taoUsdUsable(empty, NOW), {
        ok: false,
        reason: "no_index_reading",
      });
    }
  });

  test("`insufficient_pools` is a DECLINE, never a price of zero", () => {
    // ADR 0025: below the pool quorum the index publishes nothing, and the
    // CHECK constraint pairs that null with this basis. Reading it as 0 would
    // make every alpha figure worth $0 — a confident, wrong, plausible number.
    const unpriced: TaoUsdReading = {
      usd_per_tao: null,
      observed_at: iso(60_000),
      block_number: 25_719_199,
      price_basis: "insufficient_pools",
    };
    assert.deepEqual(taoUsdUsable(unpriced, NOW), {
      ok: false,
      reason: "index_unpriced",
    });
  });

  test("a non-positive rate is refused too", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = { ...healthy, usd_per_tao: bad };
      assert.equal(taoUsdUsable(r, NOW).ok, false, String(bad));
    }
  });

  test("a reading older than the bound is stale", () => {
    const old = { ...healthy, observed_at: iso(TAO_USD_MAX_AGE_MS + 1000) };
    assert.deepEqual(taoUsdUsable(old, NOW), {
      ok: false,
      reason: "index_stale",
    });
  });

  test("one millisecond inside the bound is still usable", () => {
    // Pins the boundary, so a later change to the comparison is deliberate
    // rather than an off-by-one nobody notices until a rate freezes.
    const edge = { ...healthy, observed_at: iso(TAO_USD_MAX_AGE_MS - 1) };
    assert.equal(taoUsdUsable(edge, NOW).ok, true);
  });

  test("a reading that cannot say WHEN is stale, not fresh", () => {
    // Defaulting the unknown direction to "usable" is how a frozen rate
    // survives a staleness check forever.
    for (const stamp of [null, "", "not-a-date"]) {
      const r = { ...healthy, observed_at: stamp };
      assert.deepEqual(taoUsdUsable(r, NOW), {
        ok: false,
        reason: "index_stale",
      });
    }
  });

  test("the bound IS the table's own freshness bound, not a copy of it", () => {
    // Compared against the DECLARATION rather than against a literal. Writing
    // `assert.equal(TAO_USD_MAX_AGE_MS, 2 * 60 * 60 * 1000)` would restate this
    // module's own constant and pass forever while the watchdog moved
    // underneath it -- the one-directional-parity trap. If these two ever
    // disagree, this module and the watchdog disagree about whether the index
    // is working, and an operator gets two answers with no way to choose.
    const declared = TABLE_FRESHNESS.tao_usd_index?.maxAgeMs;
    assert.ok(
      typeof declared === "number",
      "tao_usd_index has no declared freshness bound to agree with",
    );
    assert.equal(TAO_USD_MAX_AGE_MS, declared);
  });
});

describe("pricing alpha", () => {
  test("a healthy reading yields the product WITH its provenance", () => {
    const out = alphaUsd(0.088370705, healthy, NOW);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.value.usd, 0.088370705 * 204.125);
    assert.equal(out.value.usd_per_tao, 204.125);
    assert.equal(out.value.tao_usd_block, 25_719_199);
    assert.equal(out.value.tao_usd_basis, "wrapped_onchain_median");
  });

  test("ZERO IS A PRICE, and prices to $0", () => {
    // `alpha_price_tao: 0` is a real reading — a pool with no TAO in it — and
    // 0 x rate is a legitimate $0. Refusing it would turn a measured zero into
    // "unavailable", which is the opposite error to the one above and just as
    // wrong. Same line src/subnet-deregistration-ranking.ts draws for
    // moving_price.
    const out = alphaUsd(0, healthy, NOW);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.value.usd, 0);
  });

  test("a missing alpha price is refused, not zeroed", () => {
    for (const missing of [null, undefined, Number.NaN]) {
      const out = alphaUsd(missing as number | null, healthy, NOW);
      assert.deepEqual(out, { ok: false, reason: "no_alpha_price" });
    }
  });

  test("the INDEX reason wins when both sides are missing", () => {
    // The index problem affects every row in the response; the alpha one
    // affects this row. Reporting the row-level cause would send an operator
    // looking at one subnet when the whole surface is unpriced.
    const out = alphaUsd(null, null, NOW);
    assert.deepEqual(out, { ok: false, reason: "no_index_reading" });
  });

  test("a stale index refuses even a perfectly good alpha price", () => {
    const old = { ...healthy, observed_at: iso(TAO_USD_MAX_AGE_MS + 1) };
    assert.deepEqual(alphaUsd(0.5, old, NOW), {
      ok: false,
      reason: "index_stale",
    });
  });

  test("does NOT round — that is the caller's decision", () => {
    // A per-alpha price needs eight places, a market cap needs none. Rounding
    // here would cap the precision every downstream surface could ever have.
    const out = alphaUsd(1 / 3, { ...healthy, usd_per_tao: 3 }, NOW);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.value.usd, (1 / 3) * 3);
  });

  test("every unavailability is a named reason, never a null value", () => {
    // The shape guarantee: a caller can never receive `{ok: true}` carrying an
    // absent number, so it cannot serialise a USD field with nothing in it.
    const cases: Array<[number | null, TaoUsdReading | null]> = [
      [null, healthy],
      [1, null],
      [1, { ...healthy, usd_per_tao: null }],
      [1, { ...healthy, observed_at: iso(TAO_USD_MAX_AGE_MS + 1) }],
    ];
    for (const [tao, r] of cases) {
      const out = alphaUsd(tao, r, NOW);
      assert.equal(out.ok, false);
      if (out.ok) continue;
      assert.ok(out.reason.length > 0);
    }
  });
});

describe("the field-source declaration", () => {
  test("USD is RECONSTRUCTED, never measured", () => {
    // The product of two measurements is our arithmetic. Labelling it
    // `measured` would attribute the multiplication to the chain — the same
    // reason comparison_price is reconstructed in #10285.
    assert.equal(ALPHA_USD_FIELD_SOURCE.kind, "reconstructed");
    assert.equal(ALPHA_USD_FIELD_SOURCE.storage, null);
  });
});
