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
