import assert from "node:assert/strict";
import { test } from "vitest";
import { HEALTH_META_KV_TTL_MS, readHealthMetaKv } from "../workers/api.ts";

// readHealthMetaKv wraps readHealthKv(env, KV_HEALTH_META) with a 60-second
// in-isolate memo — same pattern as readRpcPoolArtifact (#1309) and
// latestPointer (#367). Analytics routes (percentiles, incidents, trends,
// uptime, trajectory, leaderboards) all read the same KV key; the memo
// collapses per-request KV reads on warm isolates.

function mkKvEnv(metaValue = { last_run_at: "2026-06-21T00:00:00.000Z" }) {
  let gets = 0;
  return {
    get gets() {
      return gets;
    },
    METAGRAPH_CONTROL: {
      async get() {
        gets += 1;
        return metaValue;
      },
    },
  } as unknown as Env & { readonly gets: number };
}

test("readHealthMetaKv memoizes within the TTL — one KV read for repeated calls", async () => {
  const env = mkKvEnv();
  const t0 = 1_000_000;
  const a = (await readHealthMetaKv(env, t0)) as { last_run_at: string };
  const b = (await readHealthMetaKv(env, t0 + 1000)) as { last_run_at: string };
  assert.equal(a.last_run_at, "2026-06-21T00:00:00.000Z");
  assert.deepEqual(a, b);
  assert.equal(
    env.gets,
    1,
    "the second call within the TTL must be served from the in-isolate memo",
  );

  // Past the TTL it re-reads.
  await readHealthMetaKv(env, t0 + HEALTH_META_KV_TTL_MS + 1);
  assert.equal(env.gets, 2, "an expired memo triggers a fresh KV read");
});

test("readHealthMetaKv never cross-reads a different env (isolation safety)", async () => {
  const envA = mkKvEnv({ last_run_at: "a" });
  const envB = mkKvEnv({ last_run_at: "b" });
  const t0 = 2_000_000;
  const a = (await readHealthMetaKv(envA, t0)) as { last_run_at: string };
  const b = (await readHealthMetaKv(envB, t0)) as { last_run_at: string };
  assert.equal(a.last_run_at, "a");
  assert.equal(b.last_run_at, "b", "a different env object must miss the memo");
  assert.equal(envA.gets, 1);
  assert.equal(envB.gets, 1);
});

test("readHealthMetaKv returns null when KV binding is absent", async () => {
  const result = await readHealthMetaKv({} as unknown as Env, 3_000_000);
  assert.equal(result, null);
});

test("readHealthMetaKv does not cache a null result (no sticky cold miss)", async () => {
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
  await readHealthMetaKv(env, t0);
  await readHealthMetaKv(env, t0 + 1000);
  assert.equal(gets, 2, "a null result must not be memoized");
});
