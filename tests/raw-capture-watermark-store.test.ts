// Which store holds the raw-capture watermark (src/raw-capture-sync.ts, #10107).
//
// THE READ MUST MOVE WITH THE WRITE. This nearly shipped inverted on the write
// side only: the caller always builds a D1-backed inner store, so skipping the
// D1 write while still reading `inner` would have read a row nothing updates
// again. The capture resumes FROM the watermark, so it would have re-captured
// the same blocks every tick, forever -- with both stores looking healthy and
// the mirror lane reporting ok.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { mirroredWatermark } from "../src/raw-capture-sync.ts";

const NOW = 1_786_000_000_000;
const waitUntil = { waitUntil: () => undefined };

/** An inner (D1) store that records what it was asked to do. */
function fakeInner(value: number | null) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      async read() {
        calls.push("read");
        return value;
      },
      async write(v: number) {
        calls.push(`write:${v}`);
        return undefined;
      },
    },
  };
}

const NEON_ENV = {
  HYPERDRIVE: { connectionString: "postgresql://example/db" },
  NEON_SOLE_STORE_TABLES: "raw_capture_state",
};

describe("mirroredWatermark", () => {
  test("while D1 owns it, BOTH the read and the write go to D1", () => {
    const inner = fakeInner(42);
    const store = mirroredWatermark(
      inner.store,
      { NEON_DUAL_WRITE_LANES: "raw-capture-state" },
      waitUntil,
      "finney",
      () => NOW,
    );
    return (async () => {
      assert.equal(await store.read(), 42);
      await store.write(43);
      assert.deepEqual(inner.calls, ["read", "write:43"]);
    })();
  });

  test("once Neon owns it, the D1 WRITE is skipped", async () => {
    const inner = fakeInner(42);
    const store = mirroredWatermark(
      inner.store,
      NEON_ENV,
      waitUntil,
      "finney",
      () => NOW,
    );
    await store.write(43);
    assert.deepEqual(
      inner.calls.filter((c) => c.startsWith("write")),
      [],
      "D1 was written while Neon owns the table",
    );
  });

  test("once Neon owns it, the D1 READ is skipped too", async () => {
    // The assertion this file exists for. A read still hitting `inner` returns
    // a frozen watermark and the capture re-runs the same blocks forever.
    const inner = fakeInner(42);
    const store = mirroredWatermark(
      inner.store,
      NEON_ENV,
      waitUntil,
      "finney",
      () => NOW,
    );
    await store.read();
    assert.deepEqual(
      inner.calls.filter((c) => c === "read"),
      [],
      "the watermark was read from D1 while Neon owns the table",
    );
  });

  test("a Neon read that fails is null, never zero", async () => {
    // null means "start at the floor"; 0 is a REAL watermark meaning genesis.
    // Collapsing the two would restart the capture from block 0 on a blip.
    const inner = fakeInner(42);
    const store = mirroredWatermark(
      inner.store,
      NEON_ENV,
      waitUntil,
      "finney",
      () => NOW,
    );
    // The fake connection string cannot resolve, so this exercises the catch.
    assert.equal(await store.read(), null);
  });

  test("without a waitUntil there is no Neon reader, so D1 still answers", async () => {
    // createPgSql returns its connection through waitUntil; with nowhere to
    // park the teardown, opening one would leak per tick.
    const inner = fakeInner(42);
    const store = mirroredWatermark(
      inner.store,
      NEON_ENV,
      undefined,
      "finney",
      () => NOW,
    );
    assert.equal(await store.read(), 42);
  });
});
