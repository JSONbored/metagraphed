import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { handleIconProxy } from "../src/icon-proxy.mjs";

const PNG = new Uint8Array(200).fill(1).buffer; // >100 bytes -> not a placeholder

async function call(qs, { env = {}, headers = {}, fetchImpl, options } = {}) {
  const url = new URL("https://api.metagraph.sh/api/v1/icon" + qs);
  const request = new Request(url, { headers });
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
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 3); // all three artifact paths read

  // hosts pulled from base_url are allowlisted too
  const r2 = await call("?host=api.other.com", {
    env,
    options: { readArtifact },
    fetchImpl: async () =>
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
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
    new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  await call("?host=example.com", { env, options: { readArtifact }, fetchImpl });
  const before = reads;
  await call("?host=example.com", { env, options: { readArtifact }, fetchImpl });
  assert.equal(reads, before); // second call served from the WeakMap memo
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
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
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
        const chunks = [
          new Uint8Array(200 * 1024),
          new Uint8Array(200 * 1024),
        ];
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
      // both favicon sources hang; advance past each FETCH_TIMEOUT_MS window
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
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
