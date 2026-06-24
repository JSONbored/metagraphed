import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseNetuidField } from "../scripts/submission-policy.mjs";

describe("parseNetuidField", () => {
  test("accepts an all-digit netuid string", () => {
    assert.equal(parseNetuidField("7"), 7);
    assert.equal(parseNetuidField("0"), 0);
    assert.equal(parseNetuidField(" 42 "), 42);
  });

  test('a blank/whitespace field is NaN, not 0 (the Number("")===0 trap)', () => {
    // A bare Number("") / Number("  ") is 0 — a valid integer that, since Finney
    // exposes the root subnet (netuid 0), would silently attribute an empty
    // submission to subnet 0. parseNetuidField must reject it.
    assert.ok(Number.isNaN(parseNetuidField("")));
    assert.ok(Number.isNaN(parseNetuidField("   ")));
    assert.ok(Number.isNaN(parseNetuidField(null)));
    assert.ok(Number.isNaN(parseNetuidField(undefined)));
  });

  test("rejects non-digit, negative, and decimal values", () => {
    assert.ok(Number.isNaN(parseNetuidField("abc")));
    assert.ok(Number.isNaN(parseNetuidField("-1")));
    assert.ok(Number.isNaN(parseNetuidField("3.5")));
    assert.ok(Number.isNaN(parseNetuidField("_No response_")));
  });
});
