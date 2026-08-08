// The raw-capture watermark store (src/raw-capture-sync.ts, #10107, #10170).
//
// THE READ MUST MOVE WITH THE WRITE. This nearly shipped inverted on the write
// side only: the caller built a D1-backed inner store, so skipping the D1 write
// while still reading it would have read a row nothing updates again. The
// capture resumes FROM the watermark, so it would have re-captured the same
// blocks every tick, forever -- with both stores looking healthy and the mirror
// lane reporting ok.
//
// D1 is gone and there is no `inner` left to disagree with, so what this file
// now guards is the pair of null rules that survive the collapse: a read that
// CANNOT RUN and a read that FAILS both answer null, never 0. The capture
// treats null as "start at the floor" and 0 as a real watermark at genesis, so
// collapsing the two would restart a whole chain's capture on a blip.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { neonWatermark } from "../src/raw-capture-sync.ts";

const NOW = 1_786_000_000_000;
const waitUntil = { waitUntil: () => undefined };

const NEON_ENV = {
  HYPERDRIVE: { connectionString: "postgresql://example/db" },
  NEON_SOLE_STORE_TABLES: "raw_capture_state",
};

describe("neonWatermark", () => {
  test("a read that fails is null, never zero", async () => {
    // The fake connection string cannot resolve, so this exercises the catch.
    const store = neonWatermark(NEON_ENV, waitUntil, "finney", () => NOW);
    assert.equal(await store.read(), null);
  });

  test("without a waitUntil there is no reader at all, and that is null too", async () => {
    // createPgSql returns its connection through waitUntil; with nowhere to
    // park the teardown, opening one would leak per tick. Declining to open one
    // must still read as "no watermark", not as "watermark zero".
    const store = neonWatermark(NEON_ENV, undefined, "finney", () => NOW);
    assert.equal(await store.read(), null);
  });

  test("without Hyperdrive bound there is no reader either", async () => {
    const store = neonWatermark(
      { NEON_SOLE_STORE_TABLES: "raw_capture_state" },
      waitUntil,
      "finney",
      () => NOW,
    );
    assert.equal(await store.read(), null);
  });

  // The write half cannot land against an unresolvable connection string
  // either. What matters is that it does not THROW: runLane converts a failure
  // into that lane's result, and a throw from the watermark would take the
  // whole tick down rather than one lane's report.
  test("a write that cannot reach the store does not throw", async () => {
    const store = neonWatermark(NEON_ENV, waitUntil, "finney", () => NOW);
    await store.write(43);
  });
});
