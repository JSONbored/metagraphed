import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { buildStatParts, handleOgImage } from "../src/og-image.ts";

// A fake readR2Object dep: records the artifact path it was called with and
// returns a configurable result, mirroring workers/storage.ts's readR2Object
// contract ({ ok, object } on a hit).
function fakeReadR2Object({
  ok = true,
  body = "PNG-BYTES",
  fail = false,
} = {}) {
  const calls = [];
  return {
    calls,
    readR2Object: async (env, artifactPath, storageTier) => {
      calls.push({ artifactPath, storageTier });
      if (fail) throw new Error("r2 read blew up");
      if (!ok) return { ok: false, status: 404, code: "artifact_not_found" };
      return { ok: true, object: { body }, source: "r2", storage_tier: "r2" };
    },
  };
}

function fakeCache(hit = null) {
  const puts = [];
  return {
    puts,
    cache: { match: async () => hit, put: async (key) => void puts.push(key) },
  };
}

// Fake ASSETS binding: serves the branded card or 404s, and records requested
// paths so tests can assert the canonical fallback asset was used.
function fakeAssets({ found = true } = {}) {
  const requested = [];
  return {
    requested,
    assets: {
      fetch: async (request) => {
        requested.push(new URL(request.url).pathname);
        return found
          ? new Response("BRANDED-FALLBACK-CARD-1200x630", {
              status: 200,
              headers: { "content-type": "image/png" },
            })
          : new Response("not found", { status: 404 });
      },
    },
  };
}

function req(method, path = "/og.png") {
  return new Request(`https://api.metagraph.sh${path}`, { method });
}
const urlFor = (path = "/og.png") => new URL(`https://api.metagraph.sh${path}`);

describe("handleOgImage", () => {
  test("returns null for a non-OG path so routing falls through", async () => {
    const result = await handleOgImage(req("GET", "/foo"), {}, urlFor("/foo"));
    assert.equal(result, null);
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const res = await handleOgImage(req("POST"), {}, urlFor(), { cache: null });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  });

  test("HEAD returns image headers and no body", async () => {
    const res = await handleOgImage(req("HEAD"), {}, urlFor(), { cache: null });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control"), /max-age=3600/);
    assert.equal(await res.text(), "");
  });

  test("serves the pre-rendered card from R2 on a hit", async () => {
    const { readR2Object, calls } = fakeReadR2Object({ body: "PNG-BODY" });
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control"), /stale-while-revalidate/);
    assert.equal(await res.text(), "PNG-BODY");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].artifactPath, "/metagraph/og-image.png");
    // successful reads are cached
    assert.equal(puts.length, 1);
  });

  test("serves a successful R2 read without caching when no cache dep is given", async () => {
    const { readR2Object } = fakeReadR2Object({ body: "PNG-BODY" });
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache: null,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PNG-BODY");
  });

  test("HEAD returns the cached render headers (no body) on a cache hit", async () => {
    // A primed cache + a HEAD request must short-circuit to the cached response
    // headers with an empty body (exercises the HEAD-on-cache-hit branch).
    const cachedResponse = new Response("PNG-BODY", {
      status: 200,
      headers: { "content-type": "image/png", "x-render": "cached" },
    });
    const res = await handleOgImage(req("HEAD"), {}, urlFor(), {
      cache: { match: async () => cachedResponse, put: async () => {} },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-render"), "cached");
    assert.equal(await res.text(), "", "HEAD carries no body");
  });

  test("falls back to the branded static card when the R2 object is cold", async () => {
    const { readR2Object } = fakeReadR2Object({ ok: false });
    const { assets, requested } = fakeAssets();
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache,
      assets,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), "BRANDED-FALLBACK-CARD-1200x630");
    assert.deepEqual(requested, ["/brand/og-fallback.png"]);
    // short cache, not the long success window, and never edge-cached
    const cc = res.headers.get("cache-control");
    assert.doesNotMatch(cc, /max-age=3600/);
    assert.doesNotMatch(cc, /stale-while-revalidate/);
    assert.match(cc, /max-age=60/);
    assert.equal(puts.length, 0);
  });

  test("falls back to the branded static card when the R2 read throws", async () => {
    const { readR2Object } = fakeReadR2Object({ fail: true });
    const { assets } = fakeAssets();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache: null,
      assets,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), "BRANDED-FALLBACK-CARD-1200x630");
    assert.match(res.headers.get("cache-control"), /max-age=60/);
  });

  test("treats a non-function readR2Object dep as an R2 miss (fallback card)", async () => {
    // deps.readR2Object omitted -> degrades to the fallback without throwing.
    const { assets, requested } = fakeAssets();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      cache: null,
      assets,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "BRANDED-FALLBACK-CARD-1200x630");
    assert.deepEqual(requested, ["/brand/og-fallback.png"]);
  });

  test("returns a 503 with no-store (never a cached blank) when even the fallback asset is unreachable", async () => {
    const { readR2Object } = fakeReadR2Object({ ok: false });
    const { assets } = fakeAssets({ found: false });
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache,
      assets,
    });
    // total failure: 5xx + no-store so crawlers use the page meta tags
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(puts.length, 0);
  });

  test("returns a 503 (not a 1x1 at 200) when no ASSETS binding is configured", async () => {
    const { readR2Object } = fakeReadR2Object({ ok: false });
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache: null,
      assets: null,
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("the committed fallback asset is a real full-size 1200x630 PNG", () => {
    const path = fileURLToPath(
      new URL("../public/brand/og-fallback.png", import.meta.url),
    );
    const buf = readFileSync(path);
    // PNG signature
    assert.deepEqual(
      [...buf.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    // IHDR width/height are big-endian uint32 at byte offsets 16 and 20
    assert.equal(buf.readUInt32BE(16), 1200);
    assert.equal(buf.readUInt32BE(20), 630);
    // a real branded card, not the old 1x1 pixel (~70 bytes)
    assert.ok(buf.length > 1000);
  });

  test("returns 503 when the fallback asset fetch itself throws (no cached blank)", async () => {
    const { readR2Object } = fakeReadR2Object({ ok: false });
    const assets = {
      fetch: async () => {
        throw new Error("ASSETS subsystem down");
      },
    };
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache: null,
      assets,
    });
    // fallbackResponse swallowed the throw and degraded to the 503 no-store path
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(await res.text(), /temporarily unavailable/);
  });

  test("a HEAD on a cache hit returns the cached headers with no body", async () => {
    const cachedResponse = new Response("CACHED-PNG", {
      headers: { "content-type": "image/png", "x-cached": "1" },
    });
    const res = await handleOgImage(req("HEAD"), {}, urlFor(), {
      cache: { match: async () => cachedResponse, put: async () => {} },
    });
    // HEAD on a cache hit: status + headers from the cached response, empty body
    assert.equal(res.headers.get("x-cached"), "1");
    assert.equal(await res.text(), "");
  });

  test("uses globalThis.caches.default when no cache dep is provided", async () => {
    const matched = [];
    const cachedResponse = new Response("GLOBAL-CACHED-PNG", {
      headers: { "content-type": "image/png" },
    });
    const originalCaches = globalThis.caches;
    globalThis.caches = {
      default: {
        match: async (key) => {
          matched.push(key);
          return cachedResponse;
        },
        put: async () => {},
      },
    };
    try {
      const { readR2Object, calls } = fakeReadR2Object();
      const res = await handleOgImage(req("GET"), {}, urlFor(), {
        readR2Object,
        // cache intentionally omitted -> falls back to globalThis.caches.default
      });
      assert.equal(await res.text(), "GLOBAL-CACHED-PNG");
      assert.equal(matched.length, 1);
      // served from cache, so no R2 read happened
      assert.equal(calls.length, 0);
    } finally {
      globalThis.caches = originalCaches;
    }
  });

  test("serves a cached response on hit without reading R2", async () => {
    const { readR2Object, calls } = fakeReadR2Object();
    const cachedResponse = new Response("CACHED-PNG", {
      headers: { "content-type": "image/png" },
    });
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readR2Object,
      cache: { match: async () => cachedResponse, put: async () => {} },
    });
    assert.equal(await res.text(), "CACHED-PNG");
    assert.equal(calls.length, 0);
  });
});

describe("buildStatParts", () => {
  test("returns null for missing data", () => {
    assert.equal(buildStatParts(null), null);
    assert.equal(buildStatParts(undefined), null);
  });

  test("formats every present, numeric count", () => {
    const parts = buildStatParts({
      subnet_count: 129,
      counts: { endpoints: 1198, providers: 92 },
      coverage: { average_score: 57 },
    });
    assert.deepEqual(parts, [
      "129 subnets",
      "1,198 endpoints",
      "92 providers",
      "57% coverage",
    ]);
  });

  test("renders only the stats that are present (partial summary, no coverage)", () => {
    // subnet_count is a non-number (→ formatCount null), endpoints present,
    // providers absent, coverage absent. Must skip the rest, never emitting
    // "undefined" or "null".
    const parts = buildStatParts({
      subnet_count: "many",
      counts: { endpoints: 1198 },
      coverage: { average_score: "n/a" },
    });
    assert.deepEqual(parts, ["1,198 endpoints"]);
  });

  test("returns null (not []) when every count is non-numeric", () => {
    const parts = buildStatParts({
      subnet_count: null,
      counts: { endpoints: "x", providers: undefined },
      coverage: { average_score: "n/a" },
    });
    assert.equal(parts, null);
  });
});
