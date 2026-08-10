// The shared TAO/USD current-reading cache (#10383).
//
// The memo is the whole risk surface. A 60s per-isolate cache is harmless when
// it behaves; the two ways it hurts are memoising a NULL (so one cold read
// after a deploy convinces the isolate for a minute that the index does not
// exist) and keying on nothing (so two bindings cross-read each other). Both
// were untested while this lived in workers/api.ts — the function moved here so
// the live volume handlers could reach it, and moving it is the moment to
// prove it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  readTaoUsdCurrentKv,
  TAO_USD_CURRENT_KV_TTL_MS,
} from "../workers/tao-usd-current.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

const NOW = Date.parse("2026-08-10T06:00:00.000Z");

/** A KV binding that counts reads, so memo hits are observable. */
function envWith(value: unknown) {
  const state = { reads: 0 };
  return {
    env: {
      METAGRAPH_CONTROL: {
        get: async () => {
          state.reads += 1;
          return value;
        },
      },
    },
    state,
  };
}

describe("reading the current TAO/USD blob", () => {
  test("an unbound store is null, not a throw", async () => {
    resetModuleState();
    assert.equal(await readTaoUsdCurrentKv({}, NOW), null);
    assert.equal(
      await readTaoUsdCurrentKv({ METAGRAPH_CONTROL: {} }, NOW),
      null,
    );
  });

  test("a throwing store is null", async () => {
    resetModuleState();
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => {
          throw new Error("KV unavailable");
        },
      },
    };
    assert.equal(await readTaoUsdCurrentKv(env, NOW), null);
  });

  test("a reading is reused within the window", async () => {
    resetModuleState();
    const { env, state } = envWith({ usd_per_tao: 204.125 });
    const a = await readTaoUsdCurrentKv(env, NOW);
    const b = await readTaoUsdCurrentKv(
      env,
      NOW + TAO_USD_CURRENT_KV_TTL_MS - 1,
    );
    assert.deepEqual(a, { usd_per_tao: 204.125 });
    assert.deepEqual(b, a);
    assert.equal(state.reads, 1, "the second call must not hit KV");
  });

  test("and re-read once the window closes", async () => {
    resetModuleState();
    const { env, state } = envWith({ usd_per_tao: 204.125 });
    await readTaoUsdCurrentKv(env, NOW);
    await readTaoUsdCurrentKv(env, NOW + TAO_USD_CURRENT_KV_TTL_MS);
    assert.equal(state.reads, 2, "the TTL boundary must expire the memo");
  });

  test("A NULL IS NEVER MEMOISED", async () => {
    // Otherwise the first request after a deploy — hitting KV before the lane
    // has written — decides for the whole isolate, for a minute, that there is
    // no index. Every route pricing alpha in USD would decline in unison for a
    // reason that was already false.
    resetModuleState();
    const { env, state } = envWith(null);
    assert.equal(await readTaoUsdCurrentKv(env, NOW), null);
    assert.equal(await readTaoUsdCurrentKv(env, NOW + 1), null);
    assert.equal(state.reads, 2, "a cold read must stay re-queried");
  });

  test("the memo is keyed on env, so two bindings never cross-read", async () => {
    resetModuleState();
    const a = envWith({ usd_per_tao: 1 });
    const b = envWith({ usd_per_tao: 2 });
    assert.deepEqual(await readTaoUsdCurrentKv(a.env, NOW), { usd_per_tao: 1 });
    assert.deepEqual(await readTaoUsdCurrentKv(b.env, NOW), { usd_per_tao: 2 });
    assert.equal(
      b.state.reads,
      1,
      "the second env must not read the first's value",
    );
  });

  test("the TTL is far below the freshness bound it must not extend", async () => {
    // src/alpha-usd.ts refuses a reading older than two hours. A memo longer
    // than that could keep a stale rate serving past the point the staleness
    // check would have caught it.
    const { TAO_USD_MAX_AGE_MS } = await import("../src/alpha-usd.ts");
    assert.ok(
      TAO_USD_CURRENT_KV_TTL_MS < TAO_USD_MAX_AGE_MS,
      "the memo must never outlive the freshness bound",
    );
  });

  test("module-state reset clears it between test files", async () => {
    // Registered, so a leftover reading cannot leak into the next file and make
    // an unrelated suite pass on a value it never set.
    const { env, state } = envWith({ usd_per_tao: 9 });
    await readTaoUsdCurrentKv(env, NOW);
    resetModuleState();
    await readTaoUsdCurrentKv(env, NOW);
    assert.equal(state.reads, 2);
  });
});
