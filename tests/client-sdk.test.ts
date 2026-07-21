// Hermetic tests for the published @jsonbored/metagraphed TS client (global fetch
// mocked, no network). Mirrors python/tests/test_client.py and covers the
// throw-on-error contract, timeout signal, RPC helper, and cursor pagination.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createLruEtagCache,
  createMetagraphedClient,
  MetagraphedError,
  metagraphedFetch,
  metagraphedPaginate,
  metagraphedRpc,
} from "../generated/metagraphed-client.js";

function stubFetch(
  impl: (url: URL, init: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("metagraphedFetch", () => {
  test("interpolates path params, sets accept, builds the URL", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({
        ok: true,
        schema_version: 1,
        data: { netuid: 7 },
        meta: {},
      }),
    );
    const out = await metagraphedFetch("/api/v1/subnets/{netuid}" as never, {
      pathParams: { netuid: 7 } as never,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.metagraph.sh/api/v1/subnets/7");
    expect((init.headers as Record<string, string>).accept).toBe(
      "application/json",
    );
    expect((out as { data: unknown }).data).toEqual({ netuid: 7 });
  });

  test("drops undefined/null query params, applies the rest", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, data: [], meta: {} }),
    );
    await metagraphedFetch("/api/v1/subnets" as never, {
      query: { limit: 2, cursor: undefined, q: null } as never,
    });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
  });

  test("honors a baseUrl override", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, data: {}, meta: {} }),
    );
    await metagraphedFetch("/api/v1/health" as never, {
      baseUrl: "https://staging.example.com",
    });
    expect((fetchMock.mock.calls[0][0] as URL).toString()).toBe(
      "https://staging.example.com/api/v1/health",
    );
  });

  test("throws MetagraphedError when a 2xx response is not JSON", async () => {
    stubFetch(
      async () =>
        new Response("<html>maintenance page</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    await expect(
      metagraphedFetch("/api/v1/health" as never),
    ).rejects.toMatchObject({
      name: "MetagraphedError",
      status: 200,
      message: "Response body was not valid JSON (status 200)",
    });
  });

  test("throws MetagraphedError surfacing the error envelope on non-2xx", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          ok: false,
          schema_version: 1,
          data: null,
          error: { code: "artifact_not_found", message: "No subnet 99999" },
        },
        404,
      ),
    );
    const error = await metagraphedFetch("/api/v1/subnets/{netuid}" as never, {
      pathParams: { netuid: 99999 } as never,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MetagraphedError);
    expect(error).toMatchObject({
      status: 404,
      code: "artifact_not_found",
      message: "No subnet 99999",
    });
  });

  test("throws on a missing path parameter", async () => {
    stubFetch(async () => jsonResponse({ ok: true, data: {}, meta: {} }));
    await expect(
      metagraphedFetch("/api/v1/subnets/{netuid}" as never, {
        pathParams: {} as never,
      }),
    ).rejects.toThrow(/Missing path parameter/);
  });

  test("passes an abort signal by default and none when timeoutMs is 0", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, data: {}, meta: {} }),
    );
    await metagraphedFetch("/api/v1/health" as never, {});
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(
      AbortSignal,
    );
    await metagraphedFetch("/api/v1/health" as never, { timeoutMs: 0 });
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBeUndefined();
  });
});

describe("metagraphedPaginate", () => {
  test("follows next_cursor until exhausted, carrying the cursor", async () => {
    const pages = [
      { ok: true, data: [1], meta: { pagination: { next_cursor: "2" } } },
      { ok: true, data: [2], meta: { pagination: { next_cursor: null } } },
    ];
    let index = 0;
    const fetchMock = stubFetch(async () => jsonResponse(pages[index++]));
    const seen: number[] = [];
    for await (const page of metagraphedPaginate("/api/v1/subnets" as never, {
      query: { limit: 1 } as never,
    })) {
      seen.push((page as { data: number[] }).data[0]);
    }
    expect(seen).toEqual([1, 2]);
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get("cursor")).toBe(
      "2",
    );
  });
});

describe("metagraphedRpc", () => {
  test("posts a JSON-RPC body and returns the result", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { peers: 40 } }),
    );
    const result = await metagraphedRpc<{ peers: number }>("finney", {
      method: "system_health",
    });
    expect(result).toEqual({ peers: 40 });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.metagraph.sh/rpc/v1/finney");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "system_health",
      params: [],
    });
  });

  test("throws MetagraphedError on a JSON-RPC-level error", async () => {
    stubFetch(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await expect(
      metagraphedRpc("finney", { method: "nope" }),
    ).rejects.toMatchObject({ name: "MetagraphedError", code: "-32601" });
  });

  test("throws MetagraphedError on an HTTP error, surfacing the envelope", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          ok: false,
          error: { code: "rpc_method_blocked", message: "blocked" },
        },
        403,
      ),
    );
    await expect(
      metagraphedRpc("finney", { method: "author_submitExtrinsic" }),
    ).rejects.toMatchObject({ status: 403, code: "rpc_method_blocked" });
  });
});

describe("createMetagraphedClient", () => {
  test("convenience methods build typed paths + queries", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { netuid: 7 }, meta: {} }),
    );
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.getSubnet(7);
    expect((fetchMock.mock.calls[0][0] as URL).toString()).toBe(
      "https://api.metagraph.sh/api/v1/subnets/7",
    );
    await client.subnets({ limit: 5 } as never);
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get("limit")).toBe(
      "5",
    );
  });

  test("does not retry by default — throws on the first 503", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "x", message: "down" } }, 503),
    );
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries opt-in on 429/5xx then resolves the success", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () =>
      ++call === 1
        ? jsonResponse({ ok: false, error: { code: "x", message: "" } }, 429)
        : jsonResponse({ ok: true, data: { netuid: 7 }, meta: {} }),
    );
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      retry: { retries: 2, minDelayMs: 0 },
    });
    const out = await client.getSubnet(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((out as { data: unknown }).data).toEqual({ netuid: 7 });
  });

  test("retries exhaust then throw the final error envelope", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: { code: "unavailable", message: "down" } },
        503,
      ),
    );
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      retry: { retries: 2, minDelayMs: 0 },
    });
    await expect(client.health()).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test("backoff honors a Retry-After header", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      let call = 0;
      const fetchMock = vi.fn(async () =>
        ++call === 1
          ? new Response("{}", {
              status: 503,
              headers: { "retry-after": "2" },
            })
          : jsonResponse({ ok: true, data: { up: true }, meta: {} }),
      );
      const client = createMetagraphedClient({
        fetch: fetchMock as unknown as typeof fetch,
        timeoutMs: 0,
        retry: { retries: 1 },
      });
      const pending = client.health();
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ETag caching sends If-None-Match and returns the cached body on 304", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ ok: true, data: { v: 1 }, meta: {} }),
          { status: 200, headers: { etag: 'W/"abc"' } },
        );
      }
      expect((init.headers as Record<string, string>)["if-none-match"]).toBe(
        'W/"abc"',
      );
      return new Response(null, { status: 304 });
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      cache: true,
    });
    const first = await client.health();
    const second = await client.health();
    expect((first as { data: unknown }).data).toEqual({ v: 1 });
    expect((second as { data: unknown }).data).toEqual({ v: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("ETag caching isolates entries by headers that can vary representations", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      if (headers["x-tenant"] === "tenant-a") {
        return new Response(
          JSON.stringify({ ok: true, data: { secret: "tenant-a" }, meta: {} }),
          { status: 200, headers: { etag: 'W/"tenant-a"' } },
        );
      }
      expect(headers["if-none-match"]).toBeUndefined();
      return new Response(
        JSON.stringify({ ok: true, data: { secret: "tenant-b" }, meta: {} }),
        { status: 200, headers: { etag: 'W/"tenant-b"' } },
      );
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      cache: true,
    });
    const first = await client.health({ headers: { "x-tenant": "tenant-a" } });
    const second = await client.health({ headers: { "x-tenant": "tenant-b" } });
    expect((first as { data: unknown }).data).toEqual({
      secret: "tenant-a",
    });
    expect((second as { data: unknown }).data).toEqual({
      secret: "tenant-b",
    });
  });

  test("ETag cache keys do not expose raw request header values", async () => {
    const observedKeys: string[] = [];
    const cache = {
      get(key: string) {
        observedKeys.push(key);
        return undefined;
      },
      set(key: string) {
        observedKeys.push(key);
      },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { v: 1 }, meta: {} }), {
          status: 200,
          headers: { etag: 'W/"secret-safe"' },
        }),
    );
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      headers: {
        authorization: "Bearer SECRET_TOKEN_123",
        cookie: "sid=SECRET_COOKIE_456",
      },
      cache,
    });

    await client.health({ headers: { "x-api-key": "SECRET_API_KEY_789" } });

    expect(observedKeys).toHaveLength(2);
    for (const key of observedKeys) {
      expect(key).toContain("https://api.metagraph.sh/api/v1/health");
      expect(key).not.toContain("SECRET_TOKEN_123");
      expect(key).not.toContain("SECRET_COOKIE_456");
      expect(key).not.toContain("SECRET_API_KEY_789");
      expect(key).not.toContain("authorization:");
      expect(key).not.toContain("cookie:");
      expect(key).not.toContain("x-api-key:");
    }
  });

  test("fetchAll collects nested data[collection] rows across cursor pages", async () => {
    // List endpoints nest rows under data[meta.pagination.collection].
    const pages = [
      {
        ok: true,
        data: { subnets: [{ netuid: 1 }, { netuid: 2 }] },
        meta: { pagination: { collection: "subnets", next_cursor: "c2" } },
      },
      {
        ok: true,
        data: { subnets: [{ netuid: 3 }] },
        meta: { pagination: { collection: "subnets", next_cursor: null } },
      },
    ];
    let index = 0;
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
      jsonResponse(pages[index++]),
    );
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    const all = await client.fetchAll("/api/v1/subnets" as never);
    expect(all).toEqual([{ netuid: 1 }, { netuid: 2 }, { netuid: 3 }]);
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get("cursor")).toBe(
      "c2",
    );
  });

  test("fetchAll falls back to a flat data array and the lone array field", async () => {
    const flat = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: [{ id: "a" }],
        meta: { pagination: { next_cursor: null } },
      }),
    );
    const flatClient = createMetagraphedClient({
      fetch: flat as unknown as typeof fetch,
    });
    expect(await flatClient.fetchAll("/api/v1/subnets" as never)).toEqual([
      { id: "a" },
    ]);

    // No collection key, but data has a single array-valued field.
    const lone = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: { rows: [{ id: "b" }] },
        meta: { pagination: { next_cursor: null } },
      }),
    );
    const loneClient = createMetagraphedClient({
      fetch: lone as unknown as typeof fetch,
    });
    expect(await loneClient.fetchAll("/api/v1/subnets" as never)).toEqual([
      { id: "b" },
    ]);
  });

  test("retries transport errors (network/timeout) then resolves", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError("network down");
      return jsonResponse({ ok: true, data: { up: true }, meta: {} });
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      retry: { retries: 2, minDelayMs: 0 },
    });
    const out = await client.health();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((out as { data: unknown }).data).toEqual({ up: true });
  });

  test("rethrows a transport error after exhausting retries", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("ECONNRESET");
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      retry: { retries: 1, minDelayMs: 0 },
    });
    await expect(client.health()).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  test("does not retry a caller-initiated abort", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      retry: { retries: 3, minDelayMs: 0 },
    });
    await expect(
      client.health({ signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("re-issues unconditionally when a 304 has no cache entry", async () => {
    const evicting = { get: () => undefined, set: () => {} };
    let call = 0;
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      call += 1;
      if (call === 1) return new Response(null, { status: 304 });
      expect(
        (init.headers as Record<string, string>)["if-none-match"],
      ).toBeUndefined();
      return jsonResponse({ ok: true, data: { fresh: true }, meta: {} });
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
      cache: evicting,
    });
    const out = await client.health();
    expect((out as { data: unknown }).data).toEqual({ fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("throws instead of looping on repeated 304 responses without a cache entry", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 2) {
        expect(
          (init.headers as Record<string, string>)["if-none-match"],
        ).toBeUndefined();
      }
      return new Response(null, { status: 304 });
    });
    const client = createMetagraphedClient({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.health({ headers: { "if-none-match": 'W/"caller-stale"' } }),
    ).rejects.toMatchObject({
      name: "MetagraphedError",
      status: 304,
      message: "GET /api/v1/health returned 304 without a cached response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createLruEtagCache", () => {
  test("evicts the least-recently-used entry beyond maxEntries", () => {
    const cache = createLruEtagCache(2);
    cache.set("a", { etag: "1", body: "A" });
    cache.set("b", { etag: "2", body: "B" });
    cache.get("a"); // touch -> "b" becomes least-recently-used
    cache.set("c", { etag: "3", body: "C" }); // exceeds cap -> evict "b"
    expect(cache.get("a")?.body).toBe("A");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")?.body).toBe("C");
  });
});
