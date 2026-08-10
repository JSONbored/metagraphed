// #10444: the extractor's two rules, tested against the real payloads it was
// written for.
//
// A failure is never a zero, and `excludes` is subtracted. Both are silent when
// wrong -- the output is a plausible number either way -- so every failure path
// asserts the REASON, not just that something was refused.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { extractRevenue } from "../src/revenue-observation.ts";

// Real shapes, observed 2026-08-10.
const CHUTES = {
  shape: "flat-array" as const,
  currency: "USD",
  fields: { date: "date", amount: "total_revenue" },
  excludes: ["sponsored_inference", "pending_instance_revenue"],
};
const CHUTES_ROW = {
  date: "2026-08-08",
  new_subscriber_revenue: 1536,
  paygo_revenue: 7629.245674214532,
  pending_instance_revenue: 610.8139253575,
  sponsored_inference: 0,
  total_revenue: 9776.059599572032,
};
const LIUM = { shape: "keyed-map" as const, currency: "USD" };
const TAO_TOTALS = {
  shape: "scalar" as const,
  currency: "USD",
  fields: { amount: "total" },
};

// Derived from the row rather than pinned: a hardcoded float both loses
// precision and hides which subtraction it is asserting.
const CHUTES_NET =
  CHUTES_ROW.total_revenue -
  CHUTES_ROW.sponsored_inference -
  CHUTES_ROW.pending_instance_revenue;

function ok(r: ReturnType<typeof extractRevenue>) {
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return r.ok ? r.observations : [];
}
function reason(r: ReturnType<typeof extractRevenue>): string {
  assert.equal(r.ok, false, "expected a refusal");
  return r.ok ? "" : r.reason;
}

describe("flat-array (SN64 Chutes)", () => {
  test("subtracts the exclusions rather than reporting gross", () => {
    const [obs] = ok(extractRevenue(CHUTES, [CHUTES_ROW]));
    // 9776.059599572032 - 0 - 610.8139253575
    assert.equal(obs.period, "2026-08-08");
    assert.ok(Math.abs(obs.amount - CHUTES_NET) < 1e-9, `${obs.amount}`);
    assert.equal(obs.currency, "USD");
    // The whole point: the net is materially below the headline field.
    assert.ok(obs.amount < CHUTES_ROW.total_revenue);
  });

  test("a missing exclusion is fine; a present non-numeric one is not", () => {
    // A feed that stops emitting sponsored_inference on a day it sponsored
    // nothing is behaving correctly.
    const { sponsored_inference: _drop, ...withoutOne } = CHUTES_ROW;
    const [obs] = ok(extractRevenue(CHUTES, [withoutOne]));
    assert.ok(Math.abs(obs.amount - CHUTES_NET) < 1e-9);

    const bad = { ...CHUTES_ROW, sponsored_inference: "0" };
    assert.match(reason(extractRevenue(CHUTES, [bad])), /sponsored_inference/);
  });

  test("a real zero is a measurement and survives", () => {
    const zero = {
      ...CHUTES_ROW,
      total_revenue: 0,
      pending_instance_revenue: 0,
    };
    const [obs] = ok(extractRevenue(CHUTES, [zero]));
    assert.equal(obs.amount, 0);
  });

  test("a broken payload refuses instead of yielding zero", () => {
    // Each of these would produce a plausible 0 under a lenient extractor, and
    // a 0 is indistinguishable from "earned nothing" once stored.
    assert.match(reason(extractRevenue(CHUTES, {})), /expected an array/);
    assert.match(reason(extractRevenue(CHUTES, [null])), /not an object/);
    assert.match(
      reason(
        extractRevenue(CHUTES, [{ ...CHUTES_ROW, total_revenue: undefined }]),
      ),
      /total_revenue/,
    );
    assert.match(
      reason(
        extractRevenue(CHUTES, [{ ...CHUTES_ROW, total_revenue: "9776" }]),
      ),
      /total_revenue/,
    );
    assert.match(
      reason(extractRevenue(CHUTES, [{ ...CHUTES_ROW, date: 20260808 }])),
      /"date" is not a string/,
    );
  });

  test("NaN and Infinity are refused, not stored", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.match(
        reason(extractRevenue(CHUTES, [{ ...CHUTES_ROW, total_revenue: v }])),
        /total_revenue/,
      );
    }
  });

  test("flat-array without both field names is refused", () => {
    assert.match(
      reason(
        extractRevenue({ ...CHUTES, fields: { amount: "total_revenue" } }, []),
      ),
      /fields\.date/,
    );
  });
});

describe("keyed-map (SN51 Lium)", () => {
  test("sums a period across its subkeys", () => {
    const payload = {
      "2026-07": { "5Csv…": 600000.5, "5E1n…": 4678.33 },
      "2026-06": { "5Csv…": 1000 },
    };
    const obs = ok(extractRevenue(LIUM, payload));
    assert.equal(obs.length, 2);
    assert.ok(
      Math.abs(obs[0].amount - (600000.5 + 4678.33)) < 1e-9,
      `${obs[0].amount}`,
    );
    assert.equal(obs[0].period, "2026-07");
    assert.equal(obs[1].amount, 1000);
  });

  test("a flat {period: number} map also works", () => {
    const obs = ok(extractRevenue(LIUM, { "2026-07": 42 }));
    assert.deepEqual(obs, [{ period: "2026-07", amount: 42, currency: "USD" }]);
  });

  test("an empty map is an empty result, not a failure", () => {
    // A subnet with no recorded months has nothing to report; that is not the
    // same as a broken feed, and conflating them would fire a false alarm.
    assert.deepEqual(ok(extractRevenue(LIUM, {})), []);
  });

  test("a non-numeric leaf refuses and names its path", () => {
    assert.match(
      reason(extractRevenue(LIUM, { "2026-07": { "5Csv…": "600000" } })),
      /2026-07\.5Csv/,
    );
    assert.match(
      reason(extractRevenue(LIUM, { "2026-07": [1, 2] })),
      /2026-07/,
    );
    assert.match(reason(extractRevenue(LIUM, [])), /expected an object/);
  });
});

describe("scalar (SN64 payments/summary/tao)", () => {
  test("reads the single total and carries no period", () => {
    const obs = ok(
      extractRevenue(TAO_TOTALS, {
        today: 1563.61,
        this_month: 15543.76,
        total: 2322291.89,
      }),
    );
    assert.deepEqual(obs, [
      { period: null, amount: 2322291.89, currency: "USD" },
    ]);
  });

  test("refuses without fields.amount, and on a missing total", () => {
    assert.match(
      reason(extractRevenue({ ...TAO_TOTALS, fields: {} }, { total: 1 })),
      /fields\.amount/,
    );
    assert.match(reason(extractRevenue(TAO_TOTALS, { today: 1 })), /"total"/);
    assert.match(reason(extractRevenue(TAO_TOTALS, [])), /expected an object/);
  });
});

describe("the declaration itself", () => {
  test("no shape and no currency are both refused", () => {
    assert.match(reason(extractRevenue({ currency: "USD" }, [])), /no shape/);
    // An amount with no unit is the exact trap the schema exists to close, so
    // it is refused here too rather than defaulted to USD.
    assert.match(
      reason(extractRevenue({ shape: "flat-array" }, [])),
      /no currency/,
    );
  });

  test("an unknown shape is refused, not read as keyed-map", () => {
    // keyed-map is the fallthrough branch, so a typo would otherwise be read as
    // one and produce plausible numbers from the wrong reading of the payload.
    const r = extractRevenue(
      { shape: "flat_array" as never, currency: "USD" },
      [],
    );
    assert.match(reason(r), /unknown shape "flat_array"/);
  });

  test("currency is carried through verbatim", () => {
    const obs = ok(
      extractRevenue({ ...LIUM, currency: "TAO" }, { "2026-07": 5 }),
    );
    assert.equal(obs[0].currency, "TAO");
  });
});
