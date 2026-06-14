// Hermetic tests for the published @jsonbored/metagraphed TS client (global fetch
// mocked, no network). Mirrors python/tests/test_client.py and covers the
// throw-on-error contract, timeout signal, RPC helper, and cursor pagination.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MetagraphedError,
  metagraphedFetch,
  metagraphedPaginate,
  metagraphedRpc,
} from "../generated/metagraphed-client";

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
