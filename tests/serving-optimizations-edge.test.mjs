import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest, handleScheduled } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// Coverage for the serving-optimizations PR (#1764): the canonical cache-search
// now folds a collection's range/csv/array filter params into the static edge
// cache key, and the hourly maintenance cron .catch-isolates pruneHealthHistory
// like its sibling prunes. These tests execute exactly those new paths through
// the public worker surface — the cache-key build for a range-filtered
// collection, and the prune rejection isolation — without asserting any new
// behaviour beyond what the handlers already guarantee.

// A minimal stand-in for the Workers `caches.default`: a Map keyed on the
// request URL (mirrors the edge-cache stub in worker-runtime.test.mjs). The
// static edge cache calls canonicalCacheSearch to build its key, which is where
// the new range/csv/array filter folding for the `subnets` collection runs.
function installMockCaches() {
  const store = new Map();
  const putKeys = [];
  globalThis.caches = {
    default: {
      async match(request) {
        const cached = store.get(request.url);
        return cached ? cached.clone() : undefined;
      },
      async put(request, response) {
        putKeys.push(request.url);
        store.set(request.url, response.clone());
      },
    },
  };
  return { store, putKeys };
}

const ctx = { waitUntil: (promise) => promise };

let originalCaches;
afterEach(() => {
  globalThis.caches = originalCaches;
});

describe("static edge cache — range-filtered collection key", () => {
  test("a GET on the range-filtered `subnets` collection folds its filter params into the cache key", async () => {
    originalCaches = globalThis.caches;
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
      env,
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
    originalCaches = globalThis.caches;
    const cache = installMockCaches();
    const env = createLocalArtifactEnv();

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.equal(cache.putKeys.length, 1);
  });
});

describe("hourly maintenance cron — pruneHealthHistory isolation", () => {
  test("a rejecting pruneHealthHistory degrades to a no-op without aborting the cron", async () => {
    originalCaches = globalThis.caches;

    // A D1 stub whose statements resolve, so the two daily rollups confirm
    // (rolled: true) and the cron reaches the prune fan-out.
    const goodStmt = {
      bind: () => ({ run: () => Promise.resolve({ meta: { changes: 0 } }) }),
    };
    const goodDb = {
      prepare: () => goodStmt,
      batch: () => Promise.resolve([]),
    };
    // A D1 stub whose `prepare` ACCESS throws (a throwing getter). That is the
    // one way pruneHealthHistory can reject: its `if (!db?.prepare)` guard reads
    // the property before the try block, so the throw escapes as a rejection
    // (every actual DB call inside the try is already caught and folded to
    // { pruned: false }). This proves the new `.catch(() => ({ pruned: false }))`
    // isolation around it actually fires.
    const throwingDb = {
      get prepare() {
        throw new Error("transient D1 error");
      },
      batch: () => Promise.resolve([]),
    };

    // handleScheduled reads env.METAGRAPH_HEALTH_DB once per consumer, in order:
    // rollupDailyUptime (1), rollupAccountEventsDaily (2), writeSubnetSnapshot (3),
    // then pruneHealthHistory (4) — the first member of the prune Promise.all.
    // Hand pruneHealthHistory the throwing DB so it rejects; everyone before it
    // gets the working DB so the rollups confirm and the prune fan-out is reached.
    let dbReads = 0;
    const env = {
      get METAGRAPH_HEALTH_DB() {
        dbReads += 1;
        return dbReads === 4 ? throwingDb : goodDb;
      },
    };

    const result = await handleScheduled({ cron: "0 * * * *" }, env, ctx);

    // The rejection was isolated to a no-op for this tick (not propagated out of
    // the Promise.all): the cron returns the .catch fallback, not a throw.
    assert.deepEqual(result, { pruned: false });
    assert.ok(dbReads >= 4, "the prune fan-out was reached");
  });
});
