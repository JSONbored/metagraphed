import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { handleRequest, withChainDetailEdgeCache } from "../workers/api.ts";
import { readSelectedHistoryBlock } from "../src/indexed-history-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

beforeEach(() => resetModuleState());
afterEach(() => vi.unstubAllGlobals());

function failingArchive() {
  const get = vi.fn(async () => {
    throw new Error("R2 unavailable");
  });
  return {
    NATIVE_PROJECTIONS: "enabled",
    METAGRAPH_ARCHIVE: { get },
    NATIVE_HISTORY_FIXTURE: "test",
  } as unknown as Env;
}

test("real numeric and hash detail routes label selected failures without querying SQL", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("SQL must not execute");
  });
  vi.stubGlobal("fetch", fetch);
  for (const ref of ["7700100", "0x" + "a".repeat(64)]) {
    const response = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/testnet/blocks/${ref}`),
      failingArchive(),
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-metagraph-degraded"),
      "tier_unavailable",
    );
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test("detail cache excludes a static response whose indexed dependency failed", async () => {
  const put = vi.fn(async () => {});
  vi.stubGlobal("caches", { default: { match: async () => undefined, put } });
  const env = failingArchive();
  const url = new URL("https://api.metagraph.sh/api/v1/blocks/8000000");
  const waits: Promise<unknown>[] = [];
  const response = await withChainDetailEdgeCache(
    new Request(url),
    env,
    url,
    "mainnet",
    { waitUntil: (p) => waits.push(p) },
    async () => {
      assert.equal(
        await readSelectedHistoryBlock(env, "blocks", 8000000),
        null,
      );
      return Response.json(
        { partial: true },
        { headers: { "x-metagraph-cache-profile": "static" } },
      );
    },
  );
  await Promise.all(waits);
  assert.equal(
    response.headers.get("x-metagraph-degraded"),
    "tier_unavailable",
  );
  assert.equal(put.mock.calls.length, 0);
});

test("a pre-labelled static detail is not cached and an unselected read stays healthy", async () => {
  const put = vi.fn(async () => {});
  vi.stubGlobal("caches", { default: { match: async () => undefined, put } });
  const url = new URL("https://api.metagraph.sh/api/v1/blocks/8000000");
  const env = {
    METAGRAPH_ARCHIVE: { get: async () => null },
  } as unknown as Env;
  for (const marked of [true, false]) {
    const waits: Promise<unknown>[] = [];
    const response = await withChainDetailEdgeCache(
      new Request(url),
      env,
      url,
      "mainnet",
      { waitUntil: (p) => waits.push(p) },
      async () => {
        assert.equal(
          await readSelectedHistoryBlock(env, "blocks", 8000000),
          undefined,
        );
        const headers = new Headers({ "x-metagraph-cache-profile": "static" });
        if (marked) headers.set("x-metagraph-degraded", "tier_unavailable");
        return Response.json({ healthy: !marked }, { headers });
      },
    );
    await Promise.all(waits);
    assert.equal(
      response.headers.get("x-metagraph-degraded"),
      marked ? "tier_unavailable" : null,
    );
    assert.equal(put.mock.calls.length, marked ? 0 : 1);
  }
});
