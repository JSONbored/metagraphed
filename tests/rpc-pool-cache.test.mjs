import assert from "node:assert/strict";
import { test } from "vitest";
import {
  readRpcPoolArtifact,
  RPC_POOL_ARTIFACT_TTL_MS,
} from "../workers/api.mjs";

// rpc/pools.json is R2-only (see src/artifact-storage.mjs R2_ONLY_PATTERNS), so a
// successful read resolves through env.METAGRAPH_ARCHIVE.get. Counting those gets
// proves the per-isolate memo collapses the per-request fetch (#1309).
function mkR2Env(poolsData = { pools: [{ id: "finney-rpc", endpoints: [] }] }) {
  let gets = 0;
  return {
    get gets() {
      return gets;
    },
    METAGRAPH_ARCHIVE: {
      async get() {
        gets += 1;
        return { json: async () => poolsData };
      },
    },
  };
}

test("readRpcPoolArtifact memoizes within the TTL — one R2 read for repeated calls (#1309)", async () => {
  const env = mkR2Env();
  const t0 = 1_000_000;
  const a = await readRpcPoolArtifact(env, t0);
  const b = await readRpcPoolArtifact(env, t0 + 1000);
  assert.equal(a.ok, true);
  assert.deepEqual(a.data, b.data);
  assert.equal(
    env.gets,
    1,
    "the second call within the TTL is served from memo",
  );

  // Past the TTL it re-reads.
  await readRpcPoolArtifact(env, t0 + RPC_POOL_ARTIFACT_TTL_MS + 1);
  assert.equal(env.gets, 2, "an expired memo triggers a fresh R2 read");
});

test("readRpcPoolArtifact never cross-reads a different env (test isolation + multi-binding safety)", async () => {
  const envA = mkR2Env({ pools: [{ id: "a", endpoints: [] }] });
  const envB = mkR2Env({ pools: [{ id: "b", endpoints: [] }] });
  const t0 = 2_000_000;
  const a = await readRpcPoolArtifact(envA, t0);
  const b = await readRpcPoolArtifact(envB, t0);
  assert.equal(a.data.pools[0].id, "a");
  assert.equal(
    b.data.pools[0].id,
    "b",
    "a different env object must miss the memo",
  );
  assert.equal(envA.gets, 1);
  assert.equal(envB.gets, 1);
});

test("readRpcPoolArtifact does not cache a failed read (no sticky transient miss)", async () => {
  let gets = 0;
  const env = {
    METAGRAPH_ARCHIVE: {
      async get() {
        gets += 1;
        return null; // R2 miss → readArtifact returns { ok: false, status: 404 }
      },
    },
  };
  const t0 = 3_000_000;
  const first = await readRpcPoolArtifact(env, t0);
  const second = await readRpcPoolArtifact(env, t0 + 1000);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(gets, 2, "a failed read must not be memoized");
});
