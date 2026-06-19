import assert from "node:assert/strict";
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

  test("returns the fallback PNG (not a 500) when font loading fails", async () => {
    const og = fakeOg({ failFont: true });
    const { cache, puts } = fakeCache();
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
      cache,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 0 && bytes.length < 200); // tiny fallback PNG
    assert.equal(puts.length, 0); // a failed render is never cached
  });

  test("returns the fallback PNG when satori rendering throws", async () => {
    const og = fakeOg({ failRender: true });
    const res = await handleOgImage(req("GET"), {}, urlFor(), {
      readArtifact: readSummaryOk,
      og: og.og,
      cache: null,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
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
