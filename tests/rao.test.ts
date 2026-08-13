// src/lib/rao.ts — the one rao-space implementation, extracted from nine
// private copies.
//
// The copies were annotated "a deliberate byte-for-byte copy per this
// codebase's per-module rounding-helper convention" and were not byte-for-byte:
// five threw on a non-finite input, three guarded the input but still threw on
// an input whose `* 1e9` overflowed, and only counterparties.ts guarded the
// value actually handed to BigInt. These tests pin the surviving behaviour so
// the drift cannot come back.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  RAO_PER_TAO,
  RAO_PER_TAO_NUMBER,
  nonNegativeOrZero,
  numberOrZero,
  raoBigToTao,
  round9,
  round9OrNull,
  finiteCellOrNull,
  nonNegativeCellOrNull,
  round9OrZero,
  taoCellOrNull,
  toRaoBig,
} from "../src/lib/rao.ts";

describe("toRaoBig", () => {
  test("converts TAO to exact rao", () => {
    assert.equal(toRaoBig(1), 1_000_000_000n);
    assert.equal(toRaoBig(0.000000001), 1n);
    assert.equal(toRaoBig(0), 0n);
    // The rounding is to the rao floor, not truncation.
    assert.equal(toRaoBig(0.0000000006), 1n);
    assert.equal(toRaoBig(0.0000000004), 0n);
  });

  test("accepts a raw store cell, not just a number", () => {
    // Several callers pass a column straight in; numeric strings arrive from
    // Postgres for some types.
    assert.equal(toRaoBig("2.5"), 2_500_000_000n);
    assert.equal(toRaoBig(null), 0n);
    assert.equal(toRaoBig(undefined), 0n);
    assert.equal(toRaoBig("not a number"), 0n);
  });

  test("a non-finite input is 0n, not a throw", () => {
    // Five of the nine copies were `BigInt(Math.round(tao * 1e9))` with no
    // guard at all, which is a RangeError here.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
      assert.doesNotThrow(() => toRaoBig(bad));
      assert.equal(toRaoBig(bad), 0n);
    }
  });

  test("A HUGE-BUT-FINITE INPUT IS 0n, NOT A THROW", () => {
    // The bug only counterparties.ts had fixed. `Number.isFinite(input)` passes
    // for MAX_VALUE, and the overflow happens on the multiply AFTER the guard —
    // so an input-side guard does not help and BigInt(Infinity) throws.
    assert.doesNotThrow(() => toRaoBig(Number.MAX_VALUE));
    assert.equal(toRaoBig(Number.MAX_VALUE), 0n);
    // Proof the input-side guard would NOT have caught it.
    assert.equal(Number.isFinite(Number.MAX_VALUE), true);
    assert.equal(Number.isFinite(Number.MAX_VALUE * 1e9), false);
    assert.throws(
      () => BigInt(Math.round(Number.MAX_VALUE * 1e9)),
      RangeError,
      "the unguarded implementation must still be shown to throw",
    );
  });

  test("negative amounts round-trip", () => {
    // Flow aggregations carry signed deltas.
    assert.equal(toRaoBig(-1.5), -1_500_000_000n);
    assert.equal(raoBigToTao(toRaoBig(-1.5)), -1.5);
  });
});

describe("raoBigToTao", () => {
  test("converts back exactly", () => {
    assert.equal(raoBigToTao(1_000_000_000n), 1);
    assert.equal(raoBigToTao(0n), 0);
    assert.equal(raoBigToTao(1n), 1e-9);
  });

  test("keeps precision where a direct Number(rao) / 1e9 loses it", () => {
    // 10,000,000.123456789 TAO. This is a REALISTIC magnitude, not a synthetic
    // one: total issuance is ~11.2M TAO, so a network-wide sum reaches here.
    // Above 2^53 rao the BigInt no longer converts exactly, and the error
    // survives the divide — which is why this splits whole from fractional
    // rather than dividing once.
    const rao = 10_000_000_123_456_789n;
    assert.equal(raoBigToTao(rao), 10_000_000.12345679);
    // The naive conversion, shown to actually differ rather than asserted to.
    assert.equal(Number(rao) / 1e9, 10_000_000.123456787);
    assert.notEqual(Number(rao) / 1e9, raoBigToTao(rao));
  });

  test("round-trips an accumulation without float drift", () => {
    // The reason the whole pattern exists: 1000 values that each round-trip
    // exactly still drift when summed in float space.
    const values = Array.from({ length: 1000 }, (_, i) => 0.1 + i * 1e-9);
    let rao = 0n;
    let float = 0;
    for (const v of values) {
      rao += toRaoBig(v);
      float += v;
    }
    const exact = raoBigToTao(rao);
    // 1000 x 0.1, plus 1e-9 x (999 x 1000 / 2) = 0.0004995.
    assert.equal(exact, 100.0004995);
    assert.notEqual(float, exact, "float accumulation must actually differ");
  });
});

test("RAO_PER_TAO is 1e9 as a BigInt", () => {
  assert.equal(RAO_PER_TAO, 1_000_000_000n);
  assert.equal(typeof RAO_PER_TAO, "bigint");
});

// ── The rounding family (#10948) ────────────────────────────────────────────
//
// Six modules declared `round9`, and their own comments said they matched:
// metagraph-neurons' read "Matches src/chain-yield.ts / src/subnet-yield.ts's
// own round9 exactly". It did not match either of them, and they did not match
// each other. On the same non-finite input the three returned three different
// answers.
//
// These pin that the three behaviours are still three, because collapsing them
// onto whichever was most common is the failure this refactor exists to remove
// rather than repeat.
describe("round9 / round9OrZero / round9OrNull", () => {
  test("all three agree on an ordinary value", () => {
    assert.equal(round9(1.2345678901), 1.23456789);
    assert.equal(round9OrZero(1.2345678901), 1.23456789);
    assert.equal(round9OrNull(1.2345678901), 1.23456789);
  });

  test("and disagree on a non-finite one, deliberately", () => {
    // THE DIVERGENCE, stated. Not hypothetical: both yield modules compute
    // `round9(emission / stake)`, so a subnet with zero stake produces
    // Infinity on one surface and 0 on the other, from the same arithmetic.
    assert.equal(Number.isNaN(round9(Number.NaN)), true);
    assert.equal(round9(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
    assert.equal(round9OrZero(Number.NaN), 0);
    assert.equal(round9OrZero(Number.POSITIVE_INFINITY), 0);
    assert.equal(round9OrNull(Number.NaN), null);
    assert.equal(round9OrNull(Number.POSITIVE_INFINITY), null);
  });

  test("the zero-stake case each yield surface actually hits", () => {
    // 1 TAO of emission over 0 stake. This is the input that made the two
    // "identical" implementations answer differently in production.
    const emission = 1;
    const stake = 0;
    assert.equal(round9(emission / stake), Number.POSITIVE_INFINITY);
    assert.equal(round9OrZero(emission / stake), 0);
    assert.equal(round9OrNull(emission / stake), null);
  });

  test("null and undefined are absent, not zero, for the nullable one", () => {
    assert.equal(round9OrNull(null), null);
    assert.equal(round9OrNull(undefined), null);
  });

  test("a non-numeric string is not a number on either coercing variant", () => {
    assert.equal(round9OrZero("nope"), 0);
    assert.equal(round9OrNull("nope"), null);
    // ...but a numeric string is, which is why these take `unknown`: several
    // callers hand a raw store cell straight in.
    assert.equal(round9OrZero("1.5"), 1.5);
    assert.equal(round9OrNull("1.5"), 1.5);
  });

  test("negatives round toward the same rao grid", () => {
    assert.equal(round9(-1.2345678904), -1.23456789);
    assert.equal(round9OrZero(-1.2345678904), -1.23456789);
    assert.equal(round9OrNull(-1.2345678904), -1.23456789);
  });

  test("numberOrZero and nonNegativeOrZero are different functions", () => {
    // They were hiding under ONE name. Nine modules' `toNumber` passed a
    // negative through; `accounts-list` and `metagraph-neurons` declared a
    // `numberOrZero` that clamped it. Collapsing them onto one export turned a
    // negative stake cell into a real negative on two surfaces that had been
    // reading it as zero, and both suites failed -- which is the only reason
    // this is two exports instead of a footnote.
    assert.equal(numberOrZero(-5), -5, "a negative net flow is a real value");
    assert.equal(nonNegativeOrZero(-5), 0, "a negative stake cell is junk");
    // They agree everywhere else, which is what made the divergence invisible.
    for (const v of [0, 1.5, "2.25", null, undefined, "nope", Number.NaN]) {
      assert.equal(
        numberOrZero(v),
        nonNegativeOrZero(v),
        `disagreed on ${String(v)}`,
      );
    }
  });

  test("taoCellOrNull rejects a blank cell that round9OrNull would zero", () => {
    // THE REASON IT IS A SEPARATE FUNCTION. `Number("")` is 0, so a blank
    // store cell rounds to a confident zero — a measurement nobody made.
    // account-events and extrinsics both carried an identical private copy
    // guarding this; folding the rule into round9OrNull would have changed
    // what a blank cell means for every existing caller of that one.
    assert.equal(round9OrNull(""), 0);
    assert.equal(taoCellOrNull(""), null);
    assert.equal(taoCellOrNull("   "), null);
    assert.equal(taoCellOrNull("\t"), null);
  });

  test("taoCellOrNull otherwise agrees with round9OrNull", () => {
    for (const v of [null, undefined, "nope", Number.NaN, 1.5, "2.25", 0, -3]) {
      assert.equal(
        taoCellOrNull(v),
        round9OrNull(v),
        `diverged on ${String(v)}`,
      );
    }
  });

  test("finiteCellOrNull does NOT round, and taoCellOrNull does", () => {
    // The trap in batch 3: seven modules' `nullableTao` looked like
    // taoCellOrNull and returns the RAW coerced number. Collapsing them onto
    // the rounding one would have introduced rao-rounding on seven surfaces
    // that never had it.
    const finer = 1.2345678901234;
    assert.equal(finiteCellOrNull(finer), finer);
    assert.equal(taoCellOrNull(finer), 1.23456789);
  });

  test("the two cell variants differ only on a negative", () => {
    // ONE NAME, TWO CONTRACTS: of seven `nullableTao` copies, four accepted a
    // negative and three rejected it. Which is right depends on the column --
    // a stake cannot be negative, a net flow can.
    assert.equal(finiteCellOrNull(-1), -1);
    assert.equal(nonNegativeCellOrNull(-1), null);
    for (const v of [
      null,
      undefined,
      "",
      "  ",
      "nope",
      Number.NaN,
      0,
      2.5,
      "3.5",
    ]) {
      assert.equal(
        finiteCellOrNull(v),
        nonNegativeCellOrNull(v),
        `diverged on ${String(v)}`,
      );
    }
  });

  test("the two constants are the same quantity in two types", () => {
    // src/movers.ts declared BOTH privately, four lines apart.
    assert.equal(BigInt(RAO_PER_TAO_NUMBER), RAO_PER_TAO);
  });
});
