import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { median, percentile } from "../src/lib/stats.ts";

describe("percentile", () => {
  test("empty array returns null", () => {
    assert.equal(percentile([], 50), null);
  });

  test("p=0 returns the minimum, not undefined", () => {
    assert.equal(percentile([10, 20, 30, 40], 0), 10);
  });

  test("p=100 returns the maximum", () => {
    assert.equal(percentile([10, 20, 30, 40], 100), 40);
  });

  test("single-element array returns that element for any p", () => {
    assert.equal(percentile([42], 0), 42);
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 100), 42);
  });

  test("nearest-rank percentiles match the values exercised by callers today", () => {
    const ascending = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(ascending, 10), 10);
    assert.equal(percentile(ascending, 25), 30);
    assert.equal(percentile(ascending, 50), 50);
    assert.equal(percentile(ascending, 75), 80);
    assert.equal(percentile(ascending, 90), 90);
    assert.equal(percentile(ascending, 95), 100);
    assert.equal(percentile(ascending, 99), 100);
  });
});

describe("median", () => {
  test("empty array returns null", () => {
    assert.equal(median([]), null);
  });

  test("single-element array returns that element", () => {
    assert.equal(median([7]), 7);
  });

  test("odd count returns the middle value", () => {
    assert.equal(median([1, 2, 3, 4, 5]), 3);
  });

  test("even count returns the unrounded average of the two middle values", () => {
    assert.equal(median([0.2, 0.4]), 0.30000000000000004);
    assert.equal(median([10, 20, 30, 100]), 25);
  });
});

// ── the round-family survivors (#10948) ─────────────────────────────────────
import { roundDp, roundBelowOne, roundDpOrNull } from "../src/lib/stats.ts";
import { round9NonNegative } from "../src/lib/rao.ts";
import { captureStamp, epochMsStamp } from "../src/lib/capture-stamp.ts";

describe("roundDp (#10948 -- the sixteen-way copy)", () => {
  test("rounds at the requested precision, default 2", () => {
    assert.equal(roundDp(1.005 + Number.EPSILON), 1.01);
    assert.equal(roundDp(1.23456), 1.23);
    assert.equal(roundDp(1.23456, 4), 1.2346);
    // -1.235 * 100 is -123.50000000000001 in floats, so this rounds
    // away from zero -- pinned as the real behaviour every copy always had.
    assert.equal(roundDp(-1.235, 2), -1.24);
  });
  test("preserves the copies' non-finite behaviour: NaN in, NaN out", () => {
    // The copies did NOT guard non-finite input -- callers guaranteed it.
    // The survivor keeps that contract rather than quietly adding one.
    assert.ok(Number.isNaN(roundDp(Number.NaN)));
  });
});

describe("roundBelowOne (#10948 -- the sub-1 clamp family)", () => {
  test("a sub-1 value that would round to 1 saturates below it", () => {
    assert.equal(roundBelowOne(0.99996, 4), 0.9999);
    assert.equal(roundBelowOne(0.99996), 0.9999);
  });
  test("a value at or above 1 passes through the plain rounding", () => {
    assert.equal(roundBelowOne(1, 4), 1);
    assert.equal(roundBelowOne(1.00004, 4), 1);
    assert.equal(roundBelowOne(2.34567, 4), 2.3457);
  });
  test("an ordinary sub-1 value is just rounded", () => {
    assert.equal(roundBelowOne(0.12345, 4), 0.1235);
  });
});

describe("roundDpOrNull (#10948 -- null survives the rounding)", () => {
  test("null, undefined and non-finite read as null, not 0 and not NaN", () => {
    assert.equal(roundDpOrNull(null, 6), null);
    assert.equal(roundDpOrNull(undefined, 6), null);
    assert.equal(roundDpOrNull(Number.NaN, 6), null);
    assert.equal(roundDpOrNull(Number.POSITIVE_INFINITY, 6), null);
  });
  test("a finite value rounds at the requested precision", () => {
    assert.equal(roundDpOrNull(0.1234567, 6), 0.123457);
    assert.equal(roundDpOrNull(0, 6), 0);
  });
});

describe("round9NonNegative (#10948 -- the clamp IS the contract)", () => {
  test("a negative reads as zero, unlike round9OrZero", () => {
    assert.equal(round9NonNegative(-1.5), 0);
  });
  test("non-numeric and non-finite read as zero", () => {
    assert.equal(round9NonNegative("nope"), 0);
    assert.equal(round9NonNegative(Number.NaN), 0);
    assert.equal(round9NonNegative(null), 0);
  });
  test("a positive rounds at 9dp", () => {
    assert.equal(round9NonNegative("1.23456789012"), 1.23456789);
  });
});

describe("captureStamp (#10948 -- the pair whose 'byte-for-byte' had drifted)", () => {
  test("numeric-string epochs parse as epochs, not dates", () => {
    const stamp = captureStamp("1723500000000");
    assert.equal(stamp?.ms, 1723500000000);
  });
  test("an ISO string keeps its own serialization", () => {
    const iso = "2026-08-13T00:00:00.000Z";
    assert.deepEqual(captureStamp(iso), { ms: Date.parse(iso), value: iso });
  });
  test("garbage, null, and non-positive epochs read as null", () => {
    assert.equal(captureStamp("not a date"), null);
    assert.equal(captureStamp(null), null);
    assert.equal(captureStamp(0), null);
    assert.equal(captureStamp(-5), null);
    assert.equal(epochMsStamp(Number.NaN), null);
  });
});
