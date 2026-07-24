import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ECONOMICS_CURRENT_KV_TTL_MS,
  readEconomicsCurrentKv,
} from "../workers/api.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";

// readEconomicsCurrentKv wraps readHealthKv(env, KV_ECONOMICS_CURRENT) with a
// 60-second in-isolate memo — same pattern as readHealthMetaKv (#1375),
// readRpcPoolArtifact (#1309), and latestPointer (#367). resolveLiveEconomics
// reads this large blob on every /api/v1/economics request AND every
// /api/v1/subnets/{netuid} request (the per-subnet overlay, #1308); neither is
// edge-cached for the live overlay, so the memo collapses warm-isolate reads.

function mkKvEnv(
  blob = { captured_at: "2026-06-22T00:00:00.000Z", subnets: [] },
) {
  let gets = 0;
  let lastKey: string | null = null;
  return {
    get gets() {
      return gets;
    },
    get lastKey() {
      return lastKey;
    },
    METAGRAPH_CONTROL: {
      async get(key: string) {
        gets += 1;
        lastKey = key;
        return blob;
      },
    },
  } as unknown as Env & {
    readonly gets: number;
    readonly lastKey: string | null;
  };
}

test("readEconomicsCurrentKv reads the economics:current KV key", async () => {
  const env = mkKvEnv();
  await readEconomicsCurrentKv(env, 10_000);
  assert.equal(env.lastKey, KV_ECONOMICS_CURRENT);
});

test("readEconomicsCurrentKv memoizes within the TTL — one KV read for repeated calls", async () => {
  const env = mkKvEnv();
  const t0 = 1_000_000;
  const a = await readEconomicsCurrentKv(env, t0);
  const b = await readEconomicsCurrentKv(env, t0 + 1000);
  assert.equal(
    (a as { captured_at: string }).captured_at,
    "2026-06-22T00:00:00.000Z",
  );
  assert.deepEqual(a, b);
  assert.equal(
    env.gets,
    1,
    "the second call within the TTL must be served from the in-isolate memo",
  );

  // Past the TTL it re-reads.
  await readEconomicsCurrentKv(env, t0 + ECONOMICS_CURRENT_KV_TTL_MS + 1);
  assert.equal(env.gets, 2, "an expired memo triggers a fresh KV read");
});

test("readEconomicsCurrentKv never cross-reads a different env (isolation safety)", async () => {
  const envA = mkKvEnv({ captured_at: "a", subnets: [] });
  const envB = mkKvEnv({ captured_at: "b", subnets: [] });
  const t0 = 2_000_000;
  const a = (await readEconomicsCurrentKv(envA, t0)) as { captured_at: string };
  const b = (await readEconomicsCurrentKv(envB, t0)) as { captured_at: string };
  assert.equal(a.captured_at, "a");
  assert.equal(b.captured_at, "b", "a different env object must miss the memo");
  assert.equal(envA.gets, 1);
  assert.equal(envB.gets, 1);
});

test("readEconomicsCurrentKv returns null when KV binding is absent", async () => {
  const result = await readEconomicsCurrentKv({} as unknown as Env, 3_000_000);
  assert.equal(result, null);
});

test("readEconomicsCurrentKv does not cache a null result (no sticky cold miss)", async () => {
  let gets = 0;
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        gets += 1;
        return null;
      },
    },
  } as unknown as Env;
  const t0 = 4_000_000;
  await readEconomicsCurrentKv(env, t0);
  await readEconomicsCurrentKv(env, t0 + 1000);
  assert.equal(gets, 2, "a null result must not be memoized");
});
