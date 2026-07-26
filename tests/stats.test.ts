import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { median, percentile } from "../src/lib/stats.ts";

// Direct unit tests for the canonical percentile()/median() the chain-*/subnet-*/
// blocks-summary distribution builders share (issue #8178). The edge cases here
// are exactly the ones the pre-consolidation per-file copies diverged on:
// p=0 / p=100 (most copies indexed arr[-1] -> undefined at p=0), a single-element
// array, and an empty array (undefined instead of null in all but one copy).

describe("percentile", () => {
  test("p=0 returns the minimum, not undefined", () => {
    assert.equal(percentile([1, 2, 3, 4], 0), 1);
  });

  test("p=100 returns the maximum", () => {
    assert.equal(percentile([1, 2, 3, 4], 100), 4);
  });

  test("nearest-rank interior percentiles match the family convention", () => {
    const ascending = [10, 20, 30, 40];
    assert.equal(percentile(ascending, 25), 10); // rank ceil(1) -> 1st
    assert.equal(percentile(ascending, 50), 20); // rank ceil(2) -> 2nd (lower-middle)
    assert.equal(percentile(ascending, 75), 30); // rank ceil(3) -> 3rd
    assert.equal(percentile(ascending, 90), 40); // rank ceil(3.6) -> 4th
  });

  test("single-element array returns that element for any p", () => {
    assert.equal(percentile([7], 0), 7);
    assert.equal(percentile([7], 50), 7);
    assert.equal(percentile([7], 100), 7);
  });

  test("empty array returns null, not undefined", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([], 0), null);
  });

  test("out-of-range p clamps to the array bounds", () => {
    assert.equal(percentile([1, 2, 3], -10), 1);
    assert.equal(percentile([1, 2, 3], 250), 3);
  });
});

describe("median", () => {
  test("odd count returns the middle value unchanged", () => {
    assert.equal(median([0.04, 0.05, 0.1]), 0.05);
  });

  test("even count averages the two middle values (not lower-middle)", () => {
    // Raw, unrounded average -- callers apply their own precision helper.
    assert.equal(median([1, 2]), 1.5);
    assert.equal(median([0.25, 0.75]), 0.5);
    assert.equal(median([1, 2, 4, 8]), 3);
  });

  test("single-element array returns that element", () => {
    assert.equal(median([42]), 42);
  });

  test("empty array returns null, not undefined", () => {
    assert.equal(median([]), null);
  });
});
