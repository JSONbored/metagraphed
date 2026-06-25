import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { handleIconProxy } from "../src/icon-proxy.mjs";

const PNG = new Uint8Array(200).fill(1).buffer; // >100 bytes -> not a placeholder

async function call(
  qs,
  { env = {}, headers = {}, method = "GET", fetchImpl, options } = {},
) {
  const url = new URL("https://api.metagraph.sh/api/v1/icon" + qs);
  const request = new Request(url, { method, headers });
  const orig = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    return await handleIconProxy(request, env, url, options);
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

test("never fetches the requested host directly (only fixed aggregators)", async () => {
  const requested = [];
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async (src) => {
      requested.push(String(src));
      return new Response("", { status: 404 });
    },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(requested, [
    "https://icons.duckduckgo.com/ip3/example.com.ico",
    "https://www.google.com/s2/favicons?domain=example.com&sz=128",
  ]);
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

test("builds the allowlist from artifact url/base_url/website fields (nested + arrays)", async () => {
  const seen = [];
  const env = {
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const readArtifact = async (_env, path) => {
    seen.push(path);
    if (path.endsWith("subnets.json")) {
      // exercise: array recursion, the `url` key, a nested object, and an
      // invalid URL string (hostFromUrl -> catch -> skipped).
      return {
        ok: true,
        data: {
          subnets: [
            null, // primitive array item -> collectHosts early-return
            "skip-me", // primitive string in an array -> early-return
            { url: "https://example.com/x", nested: { id: 1 } },
            { url: "not a url", base_url: 42 },
          ],
        },
      };
    }
    if (path.endsWith("providers.json")) {
      // exercise: `base_url` + `website` keys + a primitive value (no recursion).
      return {
        ok: true,
        data: { base_url: "https://api.other.com", website: "ftp://h.io/p" },
      };
    }
    // operational-surfaces.json: ok:false -> collectHosts skipped (line 102 false).
    return { ok: false, data: null };
  };
  const res = await call("?host=example.com&size=64", {
    env,
    options: { readArtifact },
    fetchImpl: async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 3); // all three artifact paths read

  // hosts pulled from base_url are allowlisted too
  const r2 = await call("?host=api.other.com", {
    env,
    options: { readArtifact },
    fetchImpl: async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  });
  assert.equal(r2.status, 200);
});

test("memoizes the artifact allowlist per env (readArtifact not re-read)", async () => {
  let reads = 0;
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const readArtifact = async () => {
    reads += 1;
    return { ok: true, data: {} };
  };
  const fetchImpl = async () =>
    new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  await call("?host=example.com", {
    env,
    options: { readArtifact },
    fetchImpl,
  });
  const before = reads;
  await call("?host=example.com", {
    env,
    options: { readArtifact },
    fetchImpl,
  });
  assert.equal(reads, before); // second call served from the TTL memo
});

test("re-reads the artifact allowlist after the memo TTL expires", async () => {
  let reads = 0;
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const readArtifact = async () => {
    reads += 1;
    return { ok: true, data: {} };
  };
  const fetchImpl = async () =>
    new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  const t0 = 1_000_000;
  await call("?host=example.com", {
    env,
    options: { readArtifact, now: t0 },
    fetchImpl,
  });
  const afterFirst = reads;
  // Within the TTL window -> memo hit, no re-read.
  await call("?host=example.com", {
    env,
    options: { readArtifact, now: t0 + 60_000 },
    fetchImpl,
  });
  assert.equal(reads, afterFirst, "within TTL: no re-read");
  // Past the 5-minute TTL -> the memo is stale, artifacts are re-read so a
  // newly-published host would now resolve.
  await call("?host=example.com", {
    env,
    options: { readArtifact, now: t0 + 300_001 },
    fetchImpl,
  });
  assert.equal(reads > afterFirst, true, "past TTL: artifacts re-read");
});

test("a host published after the first memo resolves once the TTL lapses", async () => {
  let published = false;
  const env = {
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  // The allowlist artifact starts empty, then a new surface appears.
  const readArtifact = async (_e, path) => {
    if (!path.endsWith("subnets.json")) return { ok: false, data: null };
    return published
      ? { ok: true, data: { url: "https://fresh.example" } }
      : { ok: true, data: {} };
  };
  const fetchImpl = async () =>
    new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  const t0 = 2_000_000;
  // Not yet published -> 404 (not allowlisted), and the empty memo is cached.
  const before = await call("?host=fresh.example", {
    env,
    options: { readArtifact, now: t0 },
    fetchImpl,
  });
  assert.equal(before.status, 404);
  published = true;
  // Still inside the TTL -> served from the stale (empty) memo, still 404.
  const stillStale = await call("?host=fresh.example", {
    env,
    options: { readArtifact, now: t0 + 10_000 },
    fetchImpl,
  });
  assert.equal(stillStale.status, 404);
  // Past the TTL -> memo refreshes, the new host resolves.
  const fresh = await call("?host=fresh.example", {
    env,
    options: { readArtifact, now: t0 + 300_001 },
    fetchImpl,
  });
  assert.equal(fresh.status, 200);
});

test("artifact read errors fail closed (host still allowed via configured env)", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const readArtifact = async () => {
    throw new Error("artifact store down");
  };
  const res = await call("?host=example.com", {
    env,
    options: { readArtifact },
    fetchImpl: async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  });
  // configured host survives even though every artifact read threw
  assert.equal(res.status, 200);
});

test("boundedArrayBuffer falls back to arrayBuffer() when body has no getReader", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  // A Response-like object whose body lacks getReader -> the non-stream path.
  const fakeRes = {
    ok: true,
    headers: new Headers({ "content-type": "image/png" }),
    body: {},
    arrayBuffer: async () => PNG,
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => fakeRes,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-icon-cache"), "miss");
});

test("boundedArrayBuffer rejects oversized arrayBuffer() in the non-stream path", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const tooLarge = new Uint8Array(256 * 1024 + 1).buffer;
  // No content-length header + body without getReader -> arrayBuffer() fallback,
  // which then exceeds MAX_ICON_BYTES (line 117 false branch).
  const fakeRes = {
    ok: true,
    headers: new Headers({ "content-type": "image/png" }),
    body: {},
    arrayBuffer: async () => tooLarge,
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => fakeRes,
  });
  assert.equal(res.status, 404);
});

test("boundedArrayBuffer rejects an oversized streamed body (no content-length)", async () => {
  const puts = [];
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: {
      get: async () => null,
      put: async (k) => puts.push(k),
    },
  };
  let canceled = false;
  // Stream chunks that together exceed MAX_ICON_BYTES, with NO content-length
  // header, forcing the reader loop + reader.cancel() size-cap branch.
  const fakeRes = {
    ok: true,
    headers: new Headers({ "content-type": "image/png" }),
    body: {
      getReader() {
        const chunks = [new Uint8Array(200 * 1024), new Uint8Array(200 * 1024)];
        let i = 0;
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          cancel: async () => {
            canceled = true;
          },
          releaseLock: () => {},
        };
      },
    },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => fakeRes,
  });
  assert.equal(res.status, 404);
  assert.equal(canceled, true); // reader.cancel() ran on the size cap
  assert.equal(puts.length, 0);
});

test("accepts a streamed body under the size cap (reader path success)", async () => {
  const puts = [];
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: {
      get: async () => null,
      put: async (k) => puts.push(k),
    },
  };
  const fakeRes = {
    ok: true,
    headers: new Headers({ "content-type": "image/png" }),
    body: {
      getReader() {
        const chunks = [new Uint8Array(120), new Uint8Array(120)];
        let i = 0;
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          cancel: async () => {},
          releaseLock: () => {},
        };
      },
    },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => fakeRes,
  });
  assert.equal(res.status, 200);
  assert.equal(puts.length, 1); // reassembled buffer cached
});

test("skips a non-image content-type and cancels its body", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  let canceled = false;
  const fakeRes = {
    ok: true,
    headers: new Headers({ "content-type": "text/html" }),
    body: {
      cancel: async () => {
        canceled = true;
      },
    },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => fakeRes,
  });
  assert.equal(res.status, 404);
  assert.equal(canceled, true);
});

test("HEAD on an R2 hit returns a bodyless 200 with matching headers", async () => {
  let bodyCanceled = false;
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: {
      get: async () => ({
        body: {
          cancel: async () => {
            bodyCanceled = true;
          },
        },
        size: 200,
        httpMetadata: { contentType: "image/png" },
      }),
      put: async () => {},
    },
  };
  const res = await call("?host=example.com&size=64", { env, method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-icon-cache"), "hit");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("etag"), '"icon-example.com-64"');
  assert.equal(res.headers.get("content-length"), "200"); // R2 object size
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.equal(await res.text(), ""); // no body streamed
  assert.equal(bodyCanceled, true); // the R2 body stream was released
});

test("HEAD on a live miss returns a bodyless 200 advertising the byte length", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const res = await call("?host=example.com", {
    env,
    method: "HEAD",
    fetchImpl: async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-icon-cache"), "miss");
  assert.equal(res.headers.get("content-length"), "200"); // PNG byteLength
  assert.equal(await res.text(), "");
});

test("non-allowlisted host negative-caches for a full day (stable no)", async () => {
  const res = await call("?host=attacker.example.com", {
    env: { METAGRAPH_ICON_ALLOWED_HOSTS: "example.com" },
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("cache-control"), /max-age=86400/);
});

test("allowlisted host, clean 404 from every aggregator -> 24h negative cache", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("cache-control"), /max-age=86400/);
});

test("allowlisted host, thrown upstream error -> short transient negative cache", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => {
      throw new Error("connection reset");
    },
  });
  assert.equal(res.status, 404);
  // 10-minute window, NOT the 24h stable one — a real icon retries soon.
  assert.match(res.headers.get("cache-control"), /max-age=600/);
});

test("allowlisted host, 5xx from an aggregator -> short transient negative cache", async () => {
  const env = {
    METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
    METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
  };
  const res = await call("?host=example.com", {
    env,
    fetchImpl: async () => new Response("", { status: 503 }),
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("cache-control"), /max-age=600/);
});

test("aborts a hung upstream fetch via the timeout controller", async () => {
  vi.useFakeTimers();
  try {
    const env = {
      METAGRAPH_ICON_ALLOWED_HOSTS: "example.com",
      METAGRAPH_ARCHIVE: { get: async () => null, put: async () => {} },
    };
    let aborts = 0;
    const fetchImpl = (_src, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborts += 1;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const url = new URL(
      "https://api.metagraph.sh/api/v1/icon?host=example.com",
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    let pending;
    try {
      pending = handleIconProxy(new Request(url), env, url);
      // Every favicon source hangs; advance past each FETCH_TIMEOUT_MS window so the
      // handler aborts each in turn and exhausts the list (loop covers all sources +
      // margin, robust to the source count changing).
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(3000);
      const res = await pending;
      assert.equal(res.status, 404);
      assert.equal(aborts >= 1, true); // controller.abort() fired
    } finally {
      globalThis.fetch = orig;
    }
  } finally {
    vi.useRealTimers();
  }
});
