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
    assert.deepEqual(a, {
      usd_per_tao: 204.125,
      observed_at: null,
      block_number: null,
      price_basis: null,
    });
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
    assert.equal((await readTaoUsdCurrentKv(a.env, NOW))?.usd_per_tao, 1);
    assert.equal((await readTaoUsdCurrentKv(b.env, NOW))?.usd_per_tao, 2);
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

  // The producer wrote `observed_at` as the raw epoch-ms integer from
  // `tao_usd_index`, while `TaoUsdReading` declares a string. `taoUsdUsable`
  // grades the stamp with `Date.parse`, which returns NaN for a stringified
  // integer -- and an unparseable stamp is graded `index_stale` by design. So a
  // cache rewritten every minute read as permanently stale, and /economics,
  // /subnets/{netuid}/volume and /chain/alpha-volume declined every USD field.
  describe("the observed_at stamp is normalised to ISO", () => {
    test("an epoch-ms stamp is graded fresh, not stale", async () => {
      resetModuleState();
      const { env } = envWith({
        usd_per_tao: 204.125,
        observed_at: NOW - 1000,
      });
      const reading = await readTaoUsdCurrentKv(env, NOW);
      assert.equal(reading?.observed_at, new Date(NOW - 1000).toISOString());
      const { taoUsdUsable } = await import("../src/alpha-usd.ts");
      assert.equal(
        taoUsdUsable(reading, NOW).ok,
        true,
        "a one-second-old reading must not be graded stale",
      );
    });

    test("an ISO stamp is passed through unchanged", async () => {
      // Values written before the producer fix are numbers and values after it
      // are strings; both are in KV at the same time across a deploy.
      resetModuleState();
      const iso = new Date(NOW - 1000).toISOString();
      const { env } = envWith({ usd_per_tao: 204.125, observed_at: iso });
      assert.equal((await readTaoUsdCurrentKv(env, NOW))?.observed_at, iso);
    });

    test("a genuinely stale stamp is still stale", async () => {
      // Proving the fix cannot pass by making everything look fresh.
      resetModuleState();
      const { TAO_USD_MAX_AGE_MS, taoUsdUsable } =
        await import("../src/alpha-usd.ts");
      const { env } = envWith({
        usd_per_tao: 204.125,
        observed_at: NOW - TAO_USD_MAX_AGE_MS - 1000,
      });
      const graded = taoUsdUsable(await readTaoUsdCurrentKv(env, NOW), NOW);
      assert.equal(graded.ok, false);
      assert.equal(graded.ok === false && graded.reason, "index_stale");
    });

    test("an unusable stamp stays stale rather than defaulting to fresh", async () => {
      resetModuleState();
      const { taoUsdUsable } = await import("../src/alpha-usd.ts");
      // 1e20 ms is past the Date range, so `new Date(v)` is Invalid Date --
      // the one finite-positive number that still cannot become a stamp.
      for (const bad of [0, -1, Number.NaN, {}, true, 1e20]) {
        const { env } = envWith({ usd_per_tao: 204.125, observed_at: bad });
        const reading = await readTaoUsdCurrentKv(env, NOW);
        assert.equal(reading?.observed_at, null, `${JSON.stringify(bad)}`);
        assert.equal(taoUsdUsable(reading, NOW).ok, false);
        resetModuleState();
      }
    });

    test("block_number is carried when it is a real height, else null", async () => {
      resetModuleState();
      const good = envWith({
        usd_per_tao: 204.125,
        observed_at: NOW - 1000,
        block_number: 25_692_599,
      });
      assert.equal(
        (await readTaoUsdCurrentKv(good.env, NOW))?.block_number,
        25_692_599,
      );
      // A fractional or non-numeric height is not a height. It rides along as
      // the audit trail for the rate, so a wrong one is worse than none.
      for (const bad of [25_692_599.5, "25692599", null]) {
        resetModuleState();
        const { env } = envWith({
          usd_per_tao: 204.125,
          observed_at: NOW - 1000,
          block_number: bad,
        });
        assert.equal(
          (await readTaoUsdCurrentKv(env, NOW))?.block_number,
          null,
          `${JSON.stringify(bad)}`,
        );
      }
    });

    test("an unpriced blob is index_unpriced, never a zero rate", async () => {
      resetModuleState();
      const { taoUsdUsable } = await import("../src/alpha-usd.ts");
      const { env } = envWith({
        usd_per_tao: null,
        observed_at: NOW - 1000,
        price_basis: "insufficient_pools",
      });
      const reading = await readTaoUsdCurrentKv(env, NOW);
      assert.equal(reading?.usd_per_tao, null);
      assert.equal(reading?.price_basis, "insufficient_pools");
      const graded = taoUsdUsable(reading, NOW);
      assert.equal(graded.ok === false && graded.reason, "index_unpriced");
    });
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
