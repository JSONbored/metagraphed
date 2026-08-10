// The fiat companion to price_at_tx (#8602).
//
// The whole issue is one distinction: `price_at_tx` is EXACT -- it comes from
// the row's own two legs -- while `usd_at_tx` is a LOOKUP against an index that
// did not exist for most of the chain's history. A reader who cannot tell those
// apart will read one confidence off the other, so the tests here are mostly
// about the second one refusing to answer.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  resolveUsdAtTx,
  withUsdAtTx,
  type UsdAtTx,
} from "../src/price-at-tx.ts";
import { USD_AT_TX_BASIS } from "../src/alpha-usd-history.ts";

const RATE = 204.125;

describe("resolving one event's fiat leg", () => {
  test("the product carries a basis that is NOT the trade's", () => {
    // price_basis says the alpha price came from this row's own legs;
    // usd_basis says the dollar leg is an index lookup. Reading one off the
    // other is the misunderstanding the field exists to prevent.
    const out = resolveUsdAtTx(0.088, RATE);
    assert.equal(out.usd_at_tx, 0.088 * RATE);
    assert.equal(out.usd_basis, "index_at_or_before");
    assert.equal(
      out.usd_basis,
      USD_AT_TX_BASIS,
      "single-sourced from the module that resolves it",
    );
  });

  test("NO RATE means null, never the oldest rate carried backwards", () => {
    // The case #8602 is most explicit about: the index starts when we started
    // collecting, and an event older than that has no dollar price. Reaching
    // for the earliest reading would be fabrication dressed as data.
    for (const missing of [null, undefined]) {
      assert.deepEqual(resolveUsdAtTx(0.088, missing), {
        usd_at_tx: null,
        usd_basis: null,
      } satisfies UsdAtTx);
    }
  });

  test("a non-positive rate is refused, because the index publishes null not zero", () => {
    // ADR 0025 publishes `usd_per_tao: null` with an insufficient_pools basis
    // when it cannot price. A zero arriving here is a corrupt reading, not a
    // free trade, and multiplying by it would report every event as worth $0.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(resolveUsdAtTx(0.088, bad).usd_at_tx, null, String(bad));
    }
  });

  test("no alpha price means no dollar price", () => {
    // Root events (root_no_pool) and non-trade events (a Transfer carries no
    // alpha leg) both land here.
    for (const missing of [null, Number.NaN]) {
      assert.deepEqual(resolveUsdAtTx(missing as number | null, RATE), {
        usd_at_tx: null,
        usd_basis: null,
      });
    }
  });

  test("ZERO IS A PRICE on the alpha side, and converts to $0", () => {
    // A pool with no TAO in it has a real price of 0, and 0 x rate is a
    // legitimate $0 -- the same line src/alpha-usd.ts draws.
    assert.equal(resolveUsdAtTx(0, RATE).usd_at_tx, 0);
    assert.equal(resolveUsdAtTx(0, RATE).usd_basis, "index_at_or_before");
  });

  test("NOT rounded -- that is a presentation decision", () => {
    const out = resolveUsdAtTx(1 / 3, 3);
    assert.equal(out.usd_at_tx, (1 / 3) * 3);
  });
});

describe("decorating a page of events", () => {
  const at = (iso: string) => Date.parse(iso);
  const ev = (iso: string, price: number | null) => ({
    block_number: 1,
    observed_at: iso,
    price_at_tx: price,
    price_basis: price === null ? null : "trade_exact",
  });

  test("each event is priced at ITS OWN instant, not the page's", () => {
    // Two events an hour apart get different rates. Pricing a page at one rate
    // would be the retroactive-rate error in miniature.
    const a = "2026-08-10T09:00:00.000Z";
    const b = "2026-08-10T10:00:00.000Z";
    const out = withUsdAtTx(
      [ev(a, 0.1), ev(b, 0.1)],
      new Map([
        [at(a), { usd_per_tao: 200 }],
        [at(b), { usd_per_tao: 210 }],
      ]),
    );
    assert.equal(out[0].usd_at_tx, 0.1 * 200);
    assert.equal(out[1].usd_at_tx, 0.1 * 210);
  });

  test("an event with no entry in the map keeps its TAO figures and gets nulls", () => {
    const old = "2025-01-01T00:00:00.000Z";
    const out = withUsdAtTx([ev(old, 0.1)], new Map());
    assert.equal(out[0].usd_at_tx, null);
    assert.equal(out[0].usd_basis, null);
    // The exact side is untouched -- a missing rate says nothing about it.
    assert.equal(out[0].price_at_tx, 0.1);
    assert.equal(out[0].price_basis, "trade_exact");
  });

  test("a failed lookup leaves every event alone rather than nulling them", () => {
    // A null map means the index could not be READ. That is not the same as
    // "no rate existed for these events", so the fields are absent rather
    // than present-and-null -- the caller has not been told anything false.
    const out = withUsdAtTx([ev("2026-08-10T09:00:00.000Z", 0.1)], null);
    assert.ok(!("usd_at_tx" in out[0]));
    assert.equal(out[0].price_at_tx, 0.1);
  });

  test("an unparseable observed_at is refused, not priced at epoch", () => {
    const broken = {
      ...ev("2026-08-10T09:00:00.000Z", 0.1),
      observed_at: "nope",
    };
    const out = withUsdAtTx([broken], new Map([[0, { usd_per_tao: 200 }]]));
    assert.equal(out[0].usd_at_tx, null);
  });

  test("a missing or empty page is survivable", () => {
    for (const empty of [null, undefined, []]) {
      assert.deepEqual(withUsdAtTx(empty as never, new Map()), []);
    }
  });

  test("an event with no observed_at at all, and one with no price field", () => {
    // Both come off real rows: a malformed/absent timestamp, and an event kind
    // that carries no alpha leg so the formatter never set price_at_tx. Neither
    // may be coerced -- Number(undefined) is NaN but `undefined` reaching the
    // multiply would be worse, and a missing timestamp must not resolve to
    // epoch and pick up whatever rate happens to sit at the start of the map.
    const noStamp = { block_number: 1, price_at_tx: 0.1 };
    const noPrice = {
      block_number: 1,
      observed_at: "2026-08-10T09:00:00.000Z",
    };
    const map = new Map([
      [0, { usd_per_tao: 999 }],
      [Date.parse("2026-08-10T09:00:00.000Z"), { usd_per_tao: 200 }],
    ]);
    const out = withUsdAtTx([noStamp, noPrice], map);
    assert.equal(
      out[0].usd_at_tx,
      null,
      "no timestamp -> no rate, not epoch's",
    );
    assert.equal(out[1].usd_at_tx, null, "no alpha price -> no dollar price");
  });

  test("the input array is never mutated", () => {
    // These events are shared with other formatters; decorating in place would
    // leak fiat fields into surfaces that never asked for them.
    const input = [ev("2026-08-10T09:00:00.000Z", 0.1)];
    withUsdAtTx(
      input,
      new Map([[at("2026-08-10T09:00:00.000Z"), { usd_per_tao: 200 }]]),
    );
    assert.ok(!("usd_at_tx" in input[0]));
  });
});
