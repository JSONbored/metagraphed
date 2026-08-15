// Four namings of "coerce to a number or null", and why they are not one
// function (#11207).
//
// `toInt` was copy-pasted into six modules under ONE name with THREE different
// bodies. The tempting fix is to keep the strictest and delete the rest, and it
// is a regression in whichever domain loses its variant: a negative row count
// becoming null, a blank chain-event argument becoming zero, a malformed query
// parameter becoming a block height.
//
// So these pin the DIFFERENCES rather than each helper in isolation. A future
// consolidation has to delete one of these assertions to land, which is exactly
// the conversation that should happen first.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  countOrZero,
  integerOrNull,
  nonNegativeIntOrNull,
  numberOrNull,
  safeIntOrNull,
} from "../src/read-store.ts";

describe("the four coercions differ where it matters", () => {
  test("NEGATIVES: only the non-negative rule rejects them", () => {
    // A block height cannot be -1; a prune's delta and a lane's gap can.
    assert.equal(nonNegativeIntOrNull(-1), null);
    assert.equal(safeIntOrNull(-1), -1);
    assert.equal(integerOrNull(-1), -1);
    assert.equal(numberOrNull(-1), -1);
  });

  test("A BLANK STRING: three answers, and each one is load-bearing", () => {
    // `Number("")` is 0, and a zero netuid is a real subnet -- which is why
    // the chain-event reader catches the blank before coercing, and why the
    // driver-side helpers do not need to.
    assert.equal(integerOrNull(""), null);
    assert.equal(integerOrNull("   "), null);
    assert.equal(safeIntOrNull(""), 0);
    assert.equal(numberOrNull(""), 0);
    assert.equal(nonNegativeIntOrNull(""), null);
  });

  test("A PADDED STRING: strict for wire input, coercive for driver output", () => {
    // " 7 " off a query parameter means the caller sent something malformed.
    // " 7 " off the driver is a BIGINT that arrived as text.
    assert.equal(nonNegativeIntOrNull(" 7 "), null);
    assert.equal(safeIntOrNull(" 7 "), 7);
    assert.equal(integerOrNull(" 7 "), 7);
  });

  test("BEYOND 2^53: only the safe-integer rule refuses it", () => {
    // These values have already been through JSON by the time `integerOrNull`
    // sees them, so precision was lost upstream and refusing does not recover
    // it. A driver value that large is a bug worth catching.
    const huge = 1e300;
    assert.equal(safeIntOrNull(huge), null);
    assert.equal(integerOrNull(huge), huge);
    assert.equal(numberOrNull(huge), huge);
  });

  test("NON-INTEGERS are rejected by all three int rules, kept by numberOrNull", () => {
    for (const coerce of [nonNegativeIntOrNull, safeIntOrNull, integerOrNull]) {
      assert.equal(coerce(1.5), null, coerce.name);
    }
    assert.equal(numberOrNull(1.5), 1.5);
  });

  test("UNREADABLE input: null everywhere except the count, which reads ZERO", () => {
    // `countOrZero` is the odd one out on purpose: every caller is a coverage
    // rule, and a count it cannot read must mean "covered nothing" so the rule
    // ALERTS. Null would compare false against a floor and report healthy.
    for (const coerce of [
      nonNegativeIntOrNull,
      safeIntOrNull,
      integerOrNull,
      numberOrNull,
    ]) {
      assert.equal(coerce("abc"), null, coerce.name);
    }
    assert.equal(countOrZero("abc"), 0);
  });

  test("null and undefined are absent, never zero", () => {
    for (const coerce of [
      nonNegativeIntOrNull,
      safeIntOrNull,
      integerOrNull,
      numberOrNull,
    ]) {
      assert.equal(coerce(null), null, coerce.name);
      assert.equal(coerce(undefined), null, coerce.name);
    }
  });
});
