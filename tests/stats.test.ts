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
