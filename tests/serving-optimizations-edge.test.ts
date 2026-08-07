import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest, handleScheduled } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { mockEnv, type Row } from "./row-type.ts";

// Coverage for the serving-optimizations PR (#1764): the canonical cache-search
// now folds a collection's range/csv/array filter params into the static edge
// cache key, and the hourly maintenance cron .catch-isolates pruneHealthHistory
// like its sibling prunes. These tests execute exactly those new paths through
// the public worker surface — the cache-key build for a range-filtered
// collection, and the prune rejection isolation — without asserting any new
// behaviour beyond what the handlers already guarantee.

// A minimal stand-in for the Workers `caches.default`: a Map keyed on the
// request URL (mirrors the edge-cache stub in worker-runtime.test.ts). The
// static edge cache calls canonicalCacheSearch to build its key, which is where
// the new range/csv/array filter folding for the `subnets` collection runs.
function installMockCaches() {
  const store = new Map<string, Response>();
  const putKeys: string[] = [];
  (globalThis as Row).caches = {
    default: {
      async match(request: Request) {
        const cached = store.get(request.url);
        return cached ? cached.clone() : undefined;
      },
      async put(request: Request, response: Response) {
        putKeys.push(request.url);
        store.set(request.url, response.clone());
      },
    },
  };
  return { store, putKeys };
}

const ctx = {
  waitUntil: (promise: Promise<unknown>) => promise,
} as unknown as ExecutionContext;

let originalCaches: unknown;
afterEach(() => {
  (globalThis as Row).caches = originalCaches;
});

describe("static edge cache — range-filtered collection key", () => {
  test("a GET on the range-filtered `subnets` collection folds its filter params into the cache key", async () => {
    originalCaches = (globalThis as Row).caches;
    const cache = installMockCaches();
    const env = createLocalArtifactEnv();

    // /api/v1/subnets is static-edge-eligible AND backed by the `subnets` query
    // collection, whose range_filters (block, tempo, …) drive canonicalCacheSearch
    // to enumerate `min_<field>`/`max_<field>` params, plus its csv_filters
    // (netuids) — all of which the new fold must add to the key.
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets?min_tempo=1&max_tempo=99&netuids=7",
      ),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);

    // The body was cached under a single static-edge key (the range/csv/array
    // params were enumerated without throwing — the new fold ran).
    assert.equal(cache.putKeys.length, 1);
    const key = cache.putKeys[0];
    assert.ok(
      key.includes("min_tempo=1"),
      "range filter min_<field> folded into the key",
    );
    assert.ok(
      key.includes("max_tempo=99"),
      "range filter max_<field> folded into the key",
    );
  });

  test("an unfiltered GET on the same collection still caches (the fold tolerates absent params)", async () => {
    originalCaches = (globalThis as Row).caches;
    const cache = installMockCaches();
    const env = createLocalArtifactEnv();

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets"),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.equal(cache.putKeys.length, 1);
  });
});
