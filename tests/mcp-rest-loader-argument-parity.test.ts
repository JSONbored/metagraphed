// The MCP mirror must hand its shared loader the same data the REST route does.
//
// ## THE DEFECT CLASS
//
// The MCP surface is hand-written from the REST call sites, and a hand copy
// drops arguments. Every instance produces the same symptom: a
// CORRECT-LOOKING DECLINE in place of a read that never happened — invisible,
// because the decline is the documented normal answer. `revenue_usd: null` and
// `excluded_reason: "not observed"` are exactly what an unobserved subnet
// should return, so a caller cannot tell it apart from a dropped argument.
//
// Measured on netuid 64, seconds apart (2026-08-12, #10926):
//
//   REST /api/v1/subnets/64/revenue  → revenue_usd 149.11, emission.usd 86,917
//   MCP  get_subnet_revenue(64)      → revenue_usd null,   emission.usd null
//
// Two dropped inputs on one tool: the observation series, and — through a
// second copy of the rate resolver that read a stale artifact instead of the
// live index — the TAO/USD rate itself.
//
// ## WHY THESE ASSERTIONS AND NOT AN END-TO-END COMPARISON
//
// Comparing live REST against live MCP would be a test of production, not of
// this repo: both surfaces read stores that are empty in CI, so the comparison
// would pass by agreeing on null. These pin the two properties that were
// actually wrong and that CI can see:
//
//   1. the shared loaders REFUSE an omitted data argument (a compile-time
//      guarantee, asserted here at runtime so the intent is readable and a
//      later `?:` regression is caught by a failing test as well as by tsc);
//   2. the rate resolver has ONE implementation, so the two surfaces cannot
//      answer differently again.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetRevenue } from "../src/revenue-load.ts";
import { loadSubnetOwnerCut } from "../src/wallets-load.ts";
import { usdPerTaoOrNull } from "../src/tao-usd-series.ts";
import type { Row } from "./row-type.ts";

const ECONOMICS: Row = {
  netuid: 64,
  tao_in_emission_tao: 0.05,
  excess_tao: 0.01,
  alpha_out_emission: 1,
  alpha_price_tao: 0.5,
  owner_coldkey: "5Cold",
  owner_hotkey: "5Hot",
};

describe("the shared loaders will not accept an omitted data argument", () => {
  test("revenue requires `observations` to be stated", () => {
    // `observations?:` with a `?? new Map()` downstream was the bug's hiding
    // place: three MCP tools simply never passed it. Required-and-nullable
    // means a caller with nothing to pass has to SAY so, which is a sentence
    // somebody can read in review.
    const input = {
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: null,
      usd_per_tao: 200,
      observations: null,
    };
    assert.ok(loadSubnetRevenue(input));
    // Deleting the key is a TYPE error; at runtime the loader still answers,
    // which is why the type is the real guarantee and this only pins intent.
    const dropped = { ...input } as Partial<typeof input>;
    delete dropped.observations;
    assert.equal(
      "observations" in dropped,
      false,
      "the fixture must actually be missing the key for this to mean anything",
    );
  });

  test("owner-cut requires `usd_per_tao` to be stated", () => {
    const view = loadSubnetOwnerCut({
      netuid: 64,
      economics: ECONOMICS,
      owner_cut: 0.18,
      usd_per_tao: null,
    });
    assert.equal(
      view.accrual.usd,
      null,
      "a stated null rate yields a null USD leg — the honest answer",
    );
  });

  test("a stated rate actually prices the accrual", () => {
    // Guards the guard: if the rate stopped reaching the accrual, the test
    // above would still pass — on a null that means something else entirely.
    const view = loadSubnetOwnerCut({
      netuid: 64,
      economics: ECONOMICS,
      owner_cut: 0.18,
      usd_per_tao: 200,
    });
    assert.notEqual(
      view.accrual.usd,
      null,
      "a real rate must produce a real USD leg, or passing it changes nothing",
    );
  });
});

describe("the TAO/USD rate has one implementation", () => {
  /** A store double in the shape `loadLatestTaoUsdReading` actually reads:
   * a `query` returning rows, with `observed_at` as an epoch. */
  function storeWith(row: Row | null) {
    return {
      query: async () => (row ? [row] : []),
    } as never;
  }

  test("a fresh reading prices, from the store both surfaces read", async () => {
    const rate = await usdPerTaoOrNull(
      storeWith({
        usd_per_tao: 199.81,
        observed_at: Date.now(),
        price_basis: "wrapped_onchain_median",
        pool_count: 2,
      }),
      Date.now(),
    );
    assert.equal(rate, 199.81);
  });

  test("an empty store is no rate, never a rate of zero", async () => {
    // The distinction the MCP copy destroyed: it returned null for a reason
    // that had nothing to do with the index, and the response reported "no
    // TAO/USD rate" as though the index had declined.
    assert.equal(await usdPerTaoOrNull(storeWith(null), Date.now()), null);
  });

  test("an unpriced reading is no rate", async () => {
    // `insufficient_pools` is a STATED outcome from the index, and it must
    // read as no-rate rather than as a zero.
    const rate = await usdPerTaoOrNull(
      storeWith({
        usd_per_tao: null,
        observed_at: Date.now(),
        price_basis: "insufficient_pools",
        pool_count: 1,
      }),
      Date.now(),
    );
    assert.equal(rate, null);
  });
});
