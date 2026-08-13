// #11001. /api/v1/blocks/{ref} and /api/v1/extrinsics/{hash} reached no cache at
// all: both return from dispatchChainHistoryRoute, upstream of the artifact
// path's `edgeCacheable` lookup, so every request paid a full lakehouse scan.
//
// What may be STORED is decided by the handler's cache profile, not by this
// wrapper re-deriving a freshness rule of its own — so these tests drive the
// wrapper with each profile a handler can emit and assert what reaches the
// store, plus the dispatch-level property that a cold (unresolved) block is not
// cached at all.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  chainDetailCacheKey,
  handleRequest,
  withChainDetailEdgeCache,
} from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const globalWithCaches = globalThis as unknown as { caches?: unknown };
const originalCaches = globalWithCaches.caches;

afterEach(() => {
  globalWithCaches.caches = originalCaches;
});

/** Minimal stand-in for `caches.default`, mirroring tests/analytics-edge-cache.test.ts. */
function mockCaches() {
  const store = new Map<string, Response>();
  const putKeys: string[] = [];
  const matchKeys: string[] = [];
  return {
    store,
    putKeys,
    matchKeys,
    install() {
      globalWithCaches.caches = {
        default: {
          async match(request: Request) {
            matchKeys.push(request.url);
            const cached = store.get(request.url);
            return cached ? cached.clone() : undefined;
          },
          async put(request: Request, response: Response) {
            putKeys.push(request.url);
            store.set(request.url, response.clone());
          },
        },
      } as unknown as Row;
    },
  };
}

const env = {} as unknown as Parameters<typeof chainDetailCacheKey>[0];
const url = new URL("https://api.metagraph.sh/api/v1/blocks/8803541");
const get = () => new Request(url.toString());

/** A handler response carrying `profile`, shaped like envelopeResponse's. */
function answer(profile: "static" | "short", body = '{"ok":true}') {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-metagraph-cache-profile": profile,
      etag: 'W/"abc"',
    },
  });
}

/** Counts how many times the underlying handler actually ran. */
function producer(response: () => Response) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    produce: async () => {
      calls += 1;
      return response();
    },
  };
}

describe("chain-detail edge cache (#11001)", () => {
  test("stores a settled (static) answer and serves the next request from it", async () => {
    const cache = mockCaches();
    cache.install();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    const handler = producer(() => answer("static"));

    const first = await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      ctx,
      handler.produce,
    );
    assert.equal(first.status, 200);
    // The response handed to the CLIENT must still be readable — a naive
    // implementation that puts the original body leaves this locked.
    assert.equal(await first.text(), '{"ok":true}');
    await Promise.all(waits);
    assert.equal(cache.putKeys.length, 1);

    const second = await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      ctx,
      handler.produce,
    );
    assert.equal(await second.text(), '{"ok":true}');
    // The whole point: the lakehouse scan did not run a second time.
    assert.equal(handler.calls, 1);
  });

  test("stores with OUR ttl, not the client-facing max-age", async () => {
    const cache = mockCaches();
    cache.install();
    const waits: Promise<unknown>[] = [];
    await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      { waitUntil: (p: Promise<unknown>) => waits.push(p) },
      async () => answer("static"),
    );
    await Promise.all(waits);
    const stored = [...cache.store.values()][0];
    assert.equal(stored.headers.get("cache-control"), "public, s-maxage=3600");
  });

  test("does NOT store an unsettled (short) answer", async () => {
    const cache = mockCaches();
    cache.install();
    const waits: Promise<unknown>[] = [];
    await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      { waitUntil: (p: Promise<unknown>) => waits.push(p) },
      async () => answer("short"),
    );
    await Promise.all(waits);
    assert.equal(cache.putKeys.length, 0);
  });

  test("does NOT store a gap (503) — it is transient by definition", async () => {
    const cache = mockCaches();
    cache.install();
    const waits: Promise<unknown>[] = [];
    await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      { waitUntil: (p: Promise<unknown>) => waits.push(p) },
      async () =>
        new Response('{"error":{"code":"block_detail_unavailable"}}', {
          status: 503,
          headers: { "x-metagraph-cache-profile": "static" },
        }),
    );
    await Promise.all(waits);
    assert.equal(cache.putKeys.length, 0);
  });

  test("answers a conditional request off a warm entry with 304", async () => {
    const cache = mockCaches();
    cache.install();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    await withChainDetailEdgeCache(get(), env, url, "mainnet", ctx, async () =>
      answer("static"),
    );
    await Promise.all(waits);

    const conditional = new Request(url.toString(), {
      headers: { "if-none-match": 'W/"abc"' },
    });
    const res = await withChainDetailEdgeCache(
      conditional,
      env,
      url,
      "mainnet",
      ctx,
      async () => {
        throw new Error("handler must not run on a warm conditional hit");
      },
    );
    assert.equal(res.status, 304);
  });

  test("bypasses the cache for a non-GET request", async () => {
    const cache = mockCaches();
    cache.install();
    const handler = producer(() => answer("static"));
    const res = await withChainDetailEdgeCache(
      new Request(url.toString(), { method: "HEAD" }),
      env,
      url,
      "mainnet",
      {},
      handler.produce,
    );
    assert.equal(res.status, 200);
    assert.equal(handler.calls, 1);
    assert.equal(cache.putKeys.length, 0);
  });

  test("skips the store when there is no waitUntil to defer it to", async () => {
    // dispatchChainHistoryRoute defaults `ctx` to `{}`, and several internal
    // call paths pass one — so the storable branch has to survive a context
    // with no waitUntil rather than throwing on it mid-response.
    const cache = mockCaches();
    cache.install();
    const res = await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      {},
      async () => answer("static"),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
    assert.equal(cache.putKeys.length, 0);
  });

  test("runs the handler when the runtime has no cache at all", async () => {
    globalWithCaches.caches = undefined;
    const handler = producer(() => answer("static"));
    const res = await withChainDetailEdgeCache(
      get(),
      env,
      url,
      "mainnet",
      {},
      handler.produce,
    );
    assert.equal(res.status, 200);
    assert.equal(handler.calls, 1);
  });
});

describe("chain-detail cache key (#11001)", () => {
  // The two chains' block numbers overlap and the /{network}/ prefix is stripped
  // before dispatch, so a key built from the path alone would serve a testnet
  // block to the next mainnet caller with nothing downstream able to tell.
  test("is network-scoped", () => {
    assert.notEqual(
      chainDetailCacheKey(env, url, "mainnet").url,
      chainDetailCacheKey(env, url, "testnet").url,
    );
  });

  test("distinguishes two refs on the same chain", () => {
    assert.notEqual(
      chainDetailCacheKey(env, url, "mainnet").url,
      chainDetailCacheKey(
        env,
        new URL("https://api.metagraph.sh/api/v1/blocks/8803542"),
        "mainnet",
      ).url,
    );
  });

  test("namespaces by contract version, so a contract change invalidates", () => {
    assert.match(
      chainDetailCacheKey(env, url, "mainnet").url,
      /\/chain-detail\//,
    );
  });
});

describe("the dispatch actually routes through the cache (#11001)", () => {
  // These two are the wiring assertions, and they are POSITIVE on purpose. The
  // interesting property — a cold ref is not stored — is a zero-put assertion
  // that would pass just as well if the wrapper had never been wired into
  // dispatchChainHistoryRoute at all. So each test first proves the lookup
  // happened, against the chain-detail key, and only then that nothing was
  // stored.
  for (const [label, path] of [
    ["block", "/api/v1/blocks/777"],
    [
      "extrinsic",
      "/api/v1/extrinsics/0x58e19156f8fdadbf60f70aaf664e80aa80c9ebb705dffe6a919048798c5c7af0",
    ],
    // #11018: the two sub-resources #11010 left behind.
    ["block-extrinsics", "/api/v1/blocks/777/extrinsics"],
    ["block-events", "/api/v1/blocks/777/events"],
  ] as const) {
    test(`${label} detail consults the edge cache, and a cold ref is not stored`, async () => {
      const cache = mockCaches();
      cache.install();
      const waits: Promise<unknown>[] = [];
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Parameters<typeof handleRequest>[1],
        { waitUntil: (p: Promise<unknown>) => waits.push(p) },
      );
      assert.equal(res.status, 200);
      await Promise.all(waits);

      // Wired: the lookup happened, and against THIS route's key.
      assert.equal(
        cache.matchKeys.some(
          (k) => k.includes("/chain-detail/") && k.endsWith(path),
        ),
        true,
        `expected a chain-detail cache lookup for ${path}, saw ${JSON.stringify(cache.matchKeys)}`,
      );
      // Correct: an unresolved ref takes the `short` profile, so pinning a
      // `block: null` / `extrinsic: null` at the edge for an hour is exactly
      // what must not happen.
      assert.equal(cache.putKeys.length, 0);
    });
  }
});
