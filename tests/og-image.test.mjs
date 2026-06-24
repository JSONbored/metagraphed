import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { handleOgImage } from "../src/og-image.mjs";

// A fake workers-og module: records the markup + fonts it was handed, and can be
// told to fail font loading or rendering to exercise the fail-soft paths.
function fakeOg({ failFont = false, failRender = false } = {}) {
  const calls = { fontTexts: [], fontWeights: [], markup: null, fonts: null };
  return {
    calls,
    og: {
      loadGoogleFont: async ({ weight, text }) => {
        calls.fontTexts.push(text);
        calls.fontWeights.push(weight);
        if (failFont) throw new Error("font fetch failed");
        return new ArrayBuffer(8);
      },
      ImageResponse: class {
        constructor(markup, opts) {
          calls.markup = markup;
          calls.fonts = opts.fonts;
          if (failRender) throw new Error("satori blew up");
          this.body = "PNG-BODY";
          this.status = 200;
          this.headers = new Headers({ "x-render": "ok" });
        }
      },
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

const readSummaryOk = async () => ({
  ok: true,
  data: {
    subnet_count: 129,
    counts: { endpoints: 1198, providers: 92 },
    coverage: { average_score: 57 },
  },
});
const readSummaryMiss = async () => ({ ok: false, status: 404 });

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

  test("renders a PNG card embedding live registry stats", async () => {
    const og = fakeOg();
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
      cache,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control"), /stale-while-revalidate/);
    // live counts are formatted into the card markup
    assert.match(og.calls.markup, /129 subnets/);
    assert.match(og.calls.markup, /1,198 endpoints/);
    assert.match(og.calls.markup, /92 providers/);
    assert.match(og.calls.markup, /57% coverage/);
    // no non-ASCII glyphs in the rendered text -- the stat-row
    // separator is a styled div, not a character (which would tofu)
    assert.doesNotMatch(og.calls.markup, /[\u0080-\uffff]/);
    assert.doesNotMatch(og.calls.fontTexts[0], /[\u0080-\uffff]/);
    // both Space Grotesk weights loaded, subset to the rendered glyphs
    assert.deepEqual(og.calls.fontWeights.sort(), [500, 700]);
    assert.match(og.calls.fontTexts[0], /129 subnets/);
    // successful renders are cached
    assert.equal(puts.length, 1);
  });

  test("falls back to a generic stat line when registry-summary is unavailable", async () => {
    const og = fakeOg();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryMiss,
      og: og.og,
      cache: null,
    });
    assert.equal(res.status, 200);
    // no live counts rendered; the ASCII fallback stat line stands in
    assert.doesNotMatch(og.calls.markup, /\d+ subnets/);
    assert.match(og.calls.markup, /Live health, schemas, and discovery/);
  });

  test("serves the branded full-size fallback card (not a 1x1, not a 500) when font loading fails", async () => {
    const og = fakeOg({ failFont: true });
    const { assets, requested } = fakeAssets();
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
      cache,
      assets,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    // the full branded card, not the old valid-but-empty 1x1 pixel
    assert.equal(await res.text(), "BRANDED-FALLBACK-CARD-1200x630");
    assert.deepEqual(requested, ["/brand/og-fallback.png"]);
    // short cache, not the long success window, and never edge-cached
    const cc = res.headers.get("cache-control");
    assert.doesNotMatch(cc, /max-age=3600/);
    assert.doesNotMatch(cc, /stale-while-revalidate/);
    assert.match(cc, /max-age=60/);
    assert.equal(puts.length, 0);
  });

  test("serves the branded fallback card when satori rendering throws", async () => {
    const og = fakeOg({ failRender: true });
    const { assets } = fakeAssets();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
      cache: null,
      assets,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), "BRANDED-FALLBACK-CARD-1200x630");
    assert.match(res.headers.get("cache-control"), /max-age=60/);
  });

  test("returns a 503 with no-store (never a cached blank) when even the fallback asset is unreachable", async () => {
    const og = fakeOg({ failRender: true });
    const { assets } = fakeAssets({ found: false });
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
      cache,
      assets,
    });
    // total failure: 5xx + no-store so crawlers use the page meta tags
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(puts.length, 0);
  });

  test("returns a 503 (not a 1x1 at 200) when no ASSETS binding is configured", async () => {
    const og = fakeOg({ failRender: true });
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
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

  test("falls back to a generic stat line when readArtifact itself throws", async () => {
    const og = fakeOg();
    const readArtifactThrows = async () => {
      throw new Error("registry-summary read blew up");
    };
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readArtifactThrows,
      og: og.og,
      cache: null,
    });
    assert.equal(res.status, 200);
    // loadStatLine swallowed the throw -> generic ASCII fallback line, no counts
    assert.doesNotMatch(og.calls.markup, /\d+ subnets/);
    assert.match(og.calls.markup, /Live health, schemas, and discovery/);
  });

  test("serves the branded fallback card when workers-og is unavailable (import/destructure throws)", async () => {
    // deps.og is truthy (so the dynamic import is short-circuited) but accessing
    // its members throws during destructuring -> the catch on line 190-192 fires.
    const explodingOg = new Proxy(
      {},
      {
        get() {
          throw new Error("workers-og module evaluation failed");
        },
      },
    );
    const { assets, requested } = fakeAssets();
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: explodingOg,
      cache,
      assets,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), "BRANDED-FALLBACK-CARD-1200x630");
    assert.deepEqual(requested, ["/brand/og-fallback.png"]);
    // a fallback is never edge-cached
    assert.equal(puts.length, 0);
  });

  test("returns 503 when the fallback asset fetch itself throws (no cached blank)", async () => {
    const og = fakeOg({ failRender: true });
    const assets = {
      fetch: async () => {
        throw new Error("ASSETS subsystem down");
      },
    };
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
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
      readArtifact: readSummaryOk,
      cache: { match: async () => cachedResponse, put: async () => {} },
    });
    // HEAD on a cache hit: status + headers from the cached response, empty body
    assert.equal(res.headers.get("x-cached"), "1");
    assert.equal(await res.text(), "");
  });

  test("uses globalThis.caches.default when no cache dep is provided", async () => {
    const og = fakeOg();
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
      const res = await handleOgImage(req("GET"), {}, urlFor(), {
        readArtifact: readSummaryOk,
        og: og.og,
        // cache intentionally omitted -> falls back to globalThis.caches.default
      });
      assert.equal(await res.text(), "GLOBAL-CACHED-PNG");
      assert.equal(matched.length, 1);
      // served from cache, so no render happened
      assert.equal(og.calls.markup, null);
    } finally {
      globalThis.caches = originalCaches;
    }
  });

  test("serves a cached render on hit without re-rendering", async () => {
    let rendered = false;
    const og = {
      loadGoogleFont: async () => {
        rendered = true;
        return new ArrayBuffer(8);
      },
      ImageResponse: class {
        constructor() {
          rendered = true;
        }
      },
    };
    const cachedResponse = new Response("CACHED-PNG", {
      headers: { "content-type": "image/png" },
    });
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og,
      cache: { match: async () => cachedResponse, put: async () => {} },
    });
    assert.equal(await res.text(), "CACHED-PNG");
    assert.equal(rendered, false);
  });
});
