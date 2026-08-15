// The read-tolerant economics contract (#11339, closing #10789).
//
// `subnetEconomicsRow` and `withSpotPrice` used to reach their typed row via
// `rows as SubnetEconomicsRow[]` and `withSpotPrice(row as never)`. `as never`
// is the worst of the two: it makes ANY value satisfy the parameter, so a
// producer that renamed `alpha_in_pool` would have gone on computing spot price
// from `undefined` and publishing the result.
//
// Replacing an assertion with a parse is only safe if the parse is the RIGHT
// one. The strict schema is the PRODUCER's contract, where an undeclared key is
// genuine drift. Reading through it would make every read fail the day a
// producer adds a field -- turning a schema into an availability risk. So the
// read path gets partial+catchall, the same contract every lakehouse row schema
// is declared with, and these pin that the tolerance goes exactly one way.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SubnetEconomicsReadSchema,
  SubnetEconomicsSchema,
} from "../schemas-src/shared.ts";

/** One subnet exactly as api.metagraphed.com served it, 2026-08-15T12:27Z. */
const SERVED = {
  netuid: 64,
  slug: "sn-64",
  name: "Chutes",
  alpha_in_pool: 2582597.356934225,
  alpha_out_pool: 3362984.870231824,
  alpha_price_tao: 0.085211829,
  tao_in_pool_tao: 219140.449957903,
  registration_allowed: true,
  emission_enabled: true,
};

describe("SubnetEconomicsReadSchema", () => {
  test("A NEW PRODUCER FIELD DOES NOT EMPTY THE ROUTE", () => {
    // The failure this schema exists to prevent. Under the strict schema every
    // row would fail together, and a leaderboard that answers nothing is
    // indistinguishable from one whose data is gone.
    const row = { ...SERVED, A_FIELD_SHIPPED_BEFORE_THIS_FILE_KNEW: "x" };
    assert.equal(SubnetEconomicsSchema.safeParse(row).success, false);
    assert.equal(SubnetEconomicsReadSchema.safeParse(row).success, true);
  });

  test("and the new field SURVIVES the parse", () => {
    // Dropping it would be a quieter version of the same bug: the route keeps
    // answering, minus a column its own producer publishes.
    const parsed = SubnetEconomicsReadSchema.parse({
      ...SERVED,
      brand_new: 1,
    });
    assert.equal((parsed as Record<string, unknown>).brand_new, 1);
  });

  test("a PROJECTION carrying a subset of columns still parses", () => {
    // `fields=netuid,name` is a supported query, and its rows are missing
    // almost everything the schema declares as required.
    assert.equal(
      SubnetEconomicsReadSchema.safeParse({ netuid: 64, name: "Chutes" })
        .success,
      true,
    );
  });

  test("THE TYPE STAYS PINNED -- this is the half that catches a defect", () => {
    // The whole point of parsing rather than asserting. A renamed or retyped
    // column is exactly what `as never` let through.
    const wrong = { ...SERVED, alpha_in_pool: "not-a-number" };
    const result = SubnetEconomicsReadSchema.safeParse(wrong);
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0]?.path.join("."), "alpha_in_pool");
  });

  test("a live served row parses clean under BOTH schemas", () => {
    // Verified against production before the assertion was replaced: the
    // served row carries zero fields the strict schema does not declare, so
    // the read schema is loosening a contract that already held rather than
    // papering over a drift that already existed.
    assert.equal(SubnetEconomicsReadSchema.safeParse(SERVED).success, true);
  });

  test("a non-object is rejected by the read schema too", () => {
    for (const v of [null, [], "x", 7]) {
      assert.equal(
        SubnetEconomicsReadSchema.safeParse(v).success,
        false,
        JSON.stringify(v),
      );
    }
  });
});
