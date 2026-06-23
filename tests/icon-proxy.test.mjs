import assert from "node:assert/strict";
import { test } from "vitest";
import { handleIconProxy } from "../src/icon-proxy.mjs";

const PNG = new Uint8Array(200).fill(1).buffer; // >100 bytes -> not a placeholder

async function call(qs, { env = {}, headers = {}, fetchImpl } = {}) {
  const url = new URL("https://api.metagraph.sh/api/v1/icon" + qs);
  const request = new Request(url, { headers });
  const orig = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    return await handleIconProxy(request, env, url);
  } finally {
    globalThis.fetch = orig;
  }
}

test("rejects invalid hosts (400): empty, IP literal, localhost, single-label", async () => {
  assert.equal((await call("?host=")).status, 400);
  assert.equal((await call("?host=10.0.0.1")).status, 400);
  assert.equal((await call("?host=localhost")).status, 400);
  assert.equal((await call("?host=internal")).status, 400);
  assert.equal((await call("?host=%5B::1%5D")).status, 400);
});

test("serves + caches a fetched favicon (R2 miss -> 200, put called)", async () => {
  const puts = [];
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: {
      get: async () => null,
      put: async (k, _v, o) => puts.push({ k, o }),
    },
  };
  const fetchImpl = async () =>
    new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  const res = await call("?host=example.com&size=64", { env, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-icon-cache"), "miss");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.equal(res.headers.get("etag"), '"icon-example.com-64"');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].k, "icon-cache/example.com/64");
});

test("serves from the R2 cache when present (hit, no fetch)", async () => {
  let fetched = false;
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: {
      get: async () => ({
        body: PNG,
        httpMetadata: { contentType: "image/png" },
      }),
      put: async () => {},
    },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => {
      fetched = true;
      return new Response(PNG, { status: 200 });
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-icon-cache"), "hit");
  assert.equal(fetched, false);
});

test("404 when no source resolves", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal(res.status, 404);
});

test("rejects too-small (placeholder) responses -> 404", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const tiny = new Uint8Array(10).buffer;
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () =>
      new Response(tiny, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  });
  assert.equal(res.status, 404);
});

test("304 on matching If-None-Match (no fetch, no R2)", async () => {
  const res = await call("?host=example.com&size=64", {
    env: { METAGRAPH_ICON_ALLOWED_HOSTS: "example.com" },
    headers: { "if-none-match": '"icon-example.com-64"' },
  });
  assert.equal(res.status, 304);
});

test("non-GET is 405", async () => {
  const url = new URL("https://api.metagraph.sh/api/v1/icon?host=example.com");
  const res = await handleIconProxy(
    new Request(url, { method: "POST" }),
    { METAGRAPH_ICON_ALLOWED_HOSTS: "example.com" },
    url,
  );
  assert.equal(res.status, 405);
});

test("404 for syntactically valid but non-allowlisted hosts", async () => {
  let fetched = false;
  const res = await call("?host=attacker.example.com", {
    env: { METAGRAPH_ICON_ALLOWED_HOSTS: "example.com" },
    fetchImpl: async () => {
      fetched = true;
      return new Response(PNG, { status: 200 });
    },
  });
  assert.equal(res.status, 404);
  assert.equal(fetched, false);
});

test("rejects oversized upstream responses before caching", async () => {
  const puts = [];
  const tooLarge = new Uint8Array(256 * 1024 + 1).fill(1);
  const res = await call("?host=example.com", {
    env: {
      METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
      METAGRAPH_ARCHIVE: {
        get: async () => null,
        put: async (k) => puts.push(k),
      },
    },
    fetchImpl: async () =>
      new Response(tooLarge, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(tooLarge.byteLength),
        },
      }),
  });
  assert.equal(res.status, 404);
  assert.equal(puts.length, 0);
});
