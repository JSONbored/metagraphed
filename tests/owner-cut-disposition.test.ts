// #10485: where the owner cut went.
//
// The test that matters most is the first one: with no flow evidence, the
// answer is `unresolved`, NOT `held-as-stake`. The cut is paid as stake, so a
// classifier watching liquid transfers alone sees nothing move and reports
// "still held" for every subnet on the network -- a well-formed, complete
// looking, wrong answer. Every other assertion here is downstream of keeping
// that one honest.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyOwnerCutDisposition,
  DISPOSITION_BUCKETS,
  DISPOSITION_TOLERANCE_ALPHA,
  ownerCutFlowLegs,
} from "../src/owner-cut-disposition.ts";

const BASE = { netuid: 64, accrued_alpha: 1000, flows_observed: true };

describe("silence is unresolved, never held", () => {
  test("no flow evidence resolves the whole accrual to unresolved", () => {
    for (const flows_observed of [false, undefined]) {
      const r = classifyOwnerCutDisposition({ ...BASE, flows_observed });
      assert.equal(r.buckets.unresolved, 1000);
      assert.equal(
        r.buckets["held-as-stake"],
        null,
        "held is a CLAIM and needs a balance to support it",
      );
      assert.equal(r.reconciles, false);
      assert.match(r.notes.join(" "), /unresolved, not held/);
    }
  });

  test("an unmeasured accrual attributes nothing at all", () => {
    for (const accrued_alpha of [null, undefined, Number.NaN, -5]) {
      const r = classifyOwnerCutDisposition({ ...BASE, accrued_alpha });
      assert.equal(r.accrued_alpha, null);
      for (const bucket of DISPOSITION_BUCKETS) {
        assert.equal(r.buckets[bucket], null, bucket);
      }
      assert.equal(r.residual_alpha, null);
    }
  });

  test("flows observed but no standing balance leaves held unresolved", () => {
    // The balance is a separate read from the flows. Having one is not having
    // the other, and assuming held from its absence is the same error.
    const r = classifyOwnerCutDisposition({
      ...BASE,
      unstaked_alpha: 200,
      held_alpha: null,
    });
    assert.equal(r.buckets["held-as-stake"], null);
    assert.equal(r.buckets.unstaked, 200);
    assert.match(r.notes.join(" "), /no standing stake balance/);
  });
});

describe("the buckets", () => {
  test("account for a fully-explained accrual and reconcile", () => {
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 600,
      unstaked_alpha: 300,
      transferred_alpha: 100,
    });
    assert.equal(r.buckets["held-as-stake"], 600);
    assert.equal(r.buckets.unstaked, 300);
    assert.equal(r.buckets["transferred-out"], 100);
    assert.equal(r.buckets.unresolved, 0);
    assert.equal(r.residual_alpha, 0);
    assert.equal(r.reconciles, true);
  });

  test("an unexplained remainder is unresolved, not assigned", () => {
    // Balancing to a residual would turn "we cannot account for this" into a
    // number that looks derived.
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 100,
      unstaked_alpha: 100,
    });
    assert.equal(r.buckets.unresolved, 800);
    assert.equal(r.residual_alpha, 800);
    assert.equal(r.reconciles, false);
    assert.match(r.notes.join(" "), /unresolved rather than assigned/);
  });

  test("parts exceeding the whole are REPORTED, never clamped", () => {
    // A negative residual means double counting, or a flow carrying capital
    // this accrual never contained. Clamping would hide the contradiction.
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 900,
      unstaked_alpha: 900,
    });
    assert.ok((r.residual_alpha as number) < 0);
    assert.equal(r.reconciles, false);
    assert.match(r.notes.join(" "), /EXCEED the accrual/);
  });

  test("standing stake above the accrual is capped, with the reason", () => {
    // A validator hotkey also holds self-bonded capital, and `holders: 1`
    // proves owner control rather than origin -- a balance cannot say which
    // part is accrued cut.
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 50_000,
    });
    assert.equal(r.buckets["held-as-stake"], 1000, "capped at what accrued");
    assert.match(r.notes.join(" "), /self-bonded/);
  });

  test("a burn bucket is populated only from a proven-unspendable move", () => {
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 0,
      burned_alpha: 1000,
    });
    assert.equal(r.buckets.burned, 1000);
    assert.equal(r.reconciles, true);
  });

  test("rounding noise does not read as a gap", () => {
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 1000 - DISPOSITION_TOLERANCE_ALPHA / 2,
    });
    assert.equal(r.reconciles, true);
    assert.equal(r.buckets.unresolved, 0);
  });
});

describe("five buckets, not six", () => {
  test("there is no `sold` bucket, because the chain cannot evidence one", () => {
    // On dTAO, StakeRemoved takes alpha out of the AMM pool and returns TAO --
    // removing stake IS the disposal. A separate `sold` bucket would be a
    // distinction we cannot observe, and an always-empty one would read as
    // "we checked and found none".
    assert.ok(!(DISPOSITION_BUCKETS as readonly string[]).includes("sold"));
    assert.deepEqual(
      [...DISPOSITION_BUCKETS],
      ["held-as-stake", "unstaked", "transferred-out", "burned", "unresolved"],
    );
  });

  test("unstaked carries the disposal, so it is never silently zero", () => {
    const r = classifyOwnerCutDisposition({
      ...BASE,
      held_alpha: 0,
      unstaked_alpha: 1000,
    });
    assert.equal(r.buckets.unstaked, 1000);
    assert.equal(r.buckets["held-as-stake"], 0);
    assert.equal(r.reconciles, true);
  });
});

// ── #10930: the flow legs, and what a populated disposition may not say ─────
describe("ownerCutFlowLegs", () => {
  const rows = [
    { netuid: 64, event_kind: "StakeAdded", total_alpha: 100, total_tao: 9 },
    { netuid: 64, event_kind: "StakeRemoved", total_alpha: 40, total_tao: 3.5 },
    { netuid: 7, event_kind: "StakeRemoved", total_alpha: 999, total_tao: 80 },
  ];

  test("picks ONE subnet's alpha legs out of the grouped rows", () => {
    const legs = ownerCutFlowLegs(rows, 64);
    assert.equal(legs.observed, true);
    assert.equal(legs.staked_alpha, 100);
    assert.equal(legs.unstaked_alpha, 40);
  });

  test("READS ALPHA, NOT TAO", () => {
    // The buckets are alpha-denominated. Pricing the TAO column into them
    // would make the residual an artefact of the price rather than a
    // statement about the owner -- and the two columns differ by ~11x here,
    // so a mix-up is not subtle once you look for it.
    const legs = ownerCutFlowLegs(rows, 64);
    assert.notEqual(legs.unstaked_alpha, 3.5, "that is the TAO column");
    assert.equal(legs.unstaked_alpha, 40);
  });

  test("another subnet's rows never leak in", () => {
    // netuid 7 unstaked 999 alpha in the same read. Attributing that to 64
    // would report a sale the owner did not make on this subnet.
    assert.equal(ownerCutFlowLegs(rows, 64).unstaked_alpha, 40);
    assert.equal(ownerCutFlowLegs(rows, 7).unstaked_alpha, 999);
  });

  test("AN EMPTY READ IS OBSERVED; A FAILED READ IS NOT", () => {
    // The distinction the whole surface turns on. An owner who moved nothing
    // is a MEASUREMENT and must reach a 0 bucket; a read that did not happen
    // must reach `unresolved`. Both look like "no rows for this subnet".
    assert.deepEqual(ownerCutFlowLegs([], 64), {
      observed: true,
      staked_alpha: 0,
      unstaked_alpha: 0,
    });
    assert.equal(ownerCutFlowLegs(null, 64).observed, false);
    assert.equal(ownerCutFlowLegs(undefined, 64).observed, false);
  });

  test("unusable amounts are skipped rather than read as zero", () => {
    const legs = ownerCutFlowLegs(
      [
        { netuid: 64, event_kind: "StakeRemoved", total_alpha: null },
        { netuid: 64, event_kind: "StakeRemoved", total_alpha: -5 },
        { netuid: 64, event_kind: "StakeRemoved", total_alpha: "nope" },
        { netuid: 64, event_kind: "StakeRemoved", total_alpha: 10 },
        { netuid: 64, event_kind: "SomethingElse", total_alpha: 500 },
      ],
      64,
    );
    assert.equal(legs.unstaked_alpha, 10);
  });
});

describe("a populated disposition (#10930)", () => {
  const observed = (over = {}) =>
    classifyOwnerCutDisposition({
      netuid: 64,
      window_days: 30,
      accrued_alpha: 100,
      flows_observed: true,
      unstaked_alpha: 40,
      held_alpha: 60,
      ...over,
    });

  test("reconciles when the buckets cover the accrual", () => {
    const out = observed();
    assert.equal(out.buckets.unstaked, 40);
    assert.equal(out.buckets["held-as-stake"], 60);
    assert.equal(out.buckets.unresolved, 0);
    assert.equal(out.residual_alpha, 0);
    assert.equal(out.reconciles, true);
  });

  test("A PARTIAL ATTRIBUTION LEAVES THE REMAINDER UNRESOLVED", () => {
    // Requirement 3: `unresolved` is not a bucket of last resort to minimise,
    // and the remainder is never redistributed to make the row look complete.
    const out = observed({ held_alpha: null });
    assert.equal(out.buckets.unstaked, 40);
    assert.equal(out.buckets["held-as-stake"], null);
    assert.equal(out.buckets.unresolved, 60);
    assert.equal(out.reconciles, false);
    // ...and it is NOT proportionally spread across the other buckets.
    assert.equal(out.buckets["transferred-out"], 0);
    assert.equal(out.buckets.burned, 0);
  });

  test("A ZERO-MOVEMENT OWNER IS MEASURED 0, NOT null", () => {
    // The issue's second falsifiable claim: an owner who moved nothing and an
    // unread window must be distinguishable in the payload.
    const moved = observed({ unstaked_alpha: 0, held_alpha: 100 });
    assert.equal(moved.buckets.unstaked, 0, "measured zero");
    assert.equal(moved.reconciles, true);

    const unread = classifyOwnerCutDisposition({
      netuid: 64,
      window_days: 30,
      accrued_alpha: 100,
      flows_observed: false,
    });
    assert.equal(unread.buckets.unstaked, null, "unread stays null");
    assert.equal(unread.buckets.unresolved, 100);
    assert.equal(unread.reconciles, false);
  });

  test("THE NOTES REFUSE THE TWO READINGS THE NUMBERS INVITE", () => {
    // Requirement 5 (movement, not intent) and 6 (one address only), in the
    // payload rather than the docs -- on the populated row, which is the one
    // that gets quoted.
    const notes = observed().notes.join(" ");
    assert.match(notes, /does NOT mean sold/i);
    assert.match(notes, /owner_coldkey only/);
  });

  test("the stale 'not read' note is gone once they are read", () => {
    // Requirement: keep notes[] truthful. Leaving "streams not read for this
    // window" beside populated buckets is a payload contradicting itself.
    assert.equal(
      observed().notes.some((n) => n.includes("not read for this window")),
      false,
    );
    assert.equal(
      classifyOwnerCutDisposition({
        netuid: 64,
        window_days: 30,
        accrued_alpha: 100,
        flows_observed: false,
      }).notes.some((n) => n.includes("not read for this window")),
      true,
      "and it is still there when they genuinely were not",
    );
  });
});
