// The seam-drift rule (#9161), tested without a lakehouse.
//
// `DEFAULT_BLOCKS_SEAM` routes every cold block read, and a seam that lags the
// lakehouse does not fail loudly -- it serves reduced-column rows for a range
// where verified ones exist. The constant went stale exactly that way: a
// decoder extended chain.blocks 2,338 blocks past it and nothing re-measured.
//
// So the rule has to alert on a lag, on a lead, and on a gap -- and stay quiet
// otherwise, because a check that cries wolf gets switched off before the one
// time it matters.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { evaluateSeam } from "../scripts/check-lakehouse-seam.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";

/** A contiguous lakehouse ending at `hi`. */
function contiguous(hi: number, lo = 0) {
  return { lo, hi, count: hi - lo + 1 };
}

describe("the lakehouse seam-drift rule (#9161)", () => {
  test("a seam exactly at the lakehouse ceiling is quiet", () => {
    const { reasons, summary } = evaluateSeam({
      seam: 8_759_336,
      ...contiguous(8_759_336),
    });
    assert.deepEqual(reasons, []);
    assert.equal(summary.drift, 0);
    assert.equal(summary.contiguous, true);
  });

  test("a lagging seam is reported with the range it would downgrade", () => {
    // The real bug. The message has to name the blocks, because "drift: 2338"
    // alone does not tell a reader what breaks.
    const { reasons } = evaluateSeam({
      seam: 8_756_998,
      ...contiguous(8_759_336),
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /lags the lakehouse by 2338/);
    assert.match(reasons[0], /8756999\.\.8759336/);
    assert.match(reasons[0], /null author\/spec_version\/event_count/);
  });

  test("a seam AHEAD of the lakehouse is reported too, and differently", () => {
    // The opposite failure, and it is worse: those blocks route to a lakehouse
    // that cannot answer, so they read as missing rather than as reduced.
    const { reasons } = evaluateSeam({
      seam: 8_760_000,
      ...contiguous(8_759_336),
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /664 block\(s\) AHEAD/);
    assert.match(reasons[0], /read as missing/);
  });

  test("a gap in the range is caught, not just a stale ceiling", () => {
    // count != hi - lo + 1. A gap BELOW the seam is unreadable from either
    // tier, so it matters more than the ceiling being off.
    const { reasons, summary } = evaluateSeam({
      seam: 8_759_336,
      lo: 0,
      hi: 8_759_336,
      count: 8_759_000,
    });
    assert.equal(summary.contiguous, false);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /NOT contiguous/);
    assert.match(reasons[0], /337 missing/);
  });

  test("a gap and a drift are reported together, not one at a time", () => {
    // Reporting only the first would turn one investigation into two.
    const { reasons } = evaluateSeam({
      seam: 8_756_998,
      lo: 0,
      hi: 8_759_336,
      count: 8_759_000,
    });
    assert.equal(reasons.length, 2);
  });

  test("an unmeasurable lakehouse alerts rather than passing", () => {
    // r2SqlQuery returns null on ANY failure. Staying quiet here would make an
    // unreachable lakehouse indistinguishable from a healthy one -- the exact
    // false negative that makes a monitor worthless.
    const { reasons } = evaluateSeam({
      seam: 8_759_336,
      lo: null,
      hi: null,
      count: null,
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /could not measure/);
  });

  test("the shipped constant is the one the check would pass", () => {
    // Pins the measured value into the suite: the constant and the number this
    // rule was verified against cannot drift apart without a test failing.
    assert.equal(
      DEFAULT_BLOCKS_SEAM,
      8_759_336,
      "DEFAULT_BLOCKS_SEAM changed -- re-measure max(chain.blocks) and update " +
        "this expectation in the same commit, or the seam is unverified",
    );
    assert.deepEqual(
      evaluateSeam({
        seam: DEFAULT_BLOCKS_SEAM,
        ...contiguous(8_759_336),
      }).reasons,
      [],
    );
  });
});
