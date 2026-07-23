import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createPinnedLookup, safeFetch } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

// IP-literal URLs so isUnsafeResolvedUrl never needs DNS: 1.1.1.1 / 8.8.8.8 are
// public (safe); 169.254.169.254 (link-local, the classic cloud-metadata SSRF
// target) + 127.0.0.1 are private (unsafe). fetch is stubbed, so no network.
function mockResponse({
  status = 200,
  location = null as string | null,
  contentType = "application/json" as string | null,
  body = "{}",
}) {
  const headers = new Map<string, string>();
  if (location) headers.set("location", location);
  if (contentType) headers.set("content-type", contentType);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers.get(String(key).toLowerCase()) ?? null,
    },
    text: async () => body,
    body: { cancel: async () => {} },
  };
}

describe("safeFetch SSRF guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("does NOT follow a redirect into a private address", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      calls.push(String(url));
      return mockResponse({
        status: 302,
        location: "http://169.254.169.254/latest/meta-data/",
      });
    }) as unknown as typeof fetch);

    const result = await safeFetch("http://1.1.1.1/");

    assert.equal(result.ok, false);
    assert.equal(result.unsafe, true);
    // The private redirect target must never be requested.
    assert.deepEqual(calls, ["http://1.1.1.1/"]);
    assert.ok(!calls.some((u) => u.includes("169.254.169.254")));
  });

  test("rejects an initial private URL without fetching it", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      calls.push(String(url));
      return mockResponse({ status: 200 });
    }) as unknown as typeof fetch);

    const result = await safeFetch("http://127.0.0.1:8080/admin");

    assert.equal(result.unsafe, true);
    assert.deepEqual(calls, []); // never connected
  });

  test("follows a redirect between public addresses and returns the final URL", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url) === "http://1.1.1.1/"
        ? mockResponse({ status: 301, location: "http://8.8.8.8/spec.json" })
        : mockResponse({ status: 200, body: '{"openapi":"3.0.0"}' });
    }) as unknown as typeof fetch);

    const result = await safeFetch("http://1.1.1.1/", {
      accept: "application/json",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.url, "http://8.8.8.8/spec.json");
    assert.deepEqual(calls, ["http://1.1.1.1/", "http://8.8.8.8/spec.json"]);
    assert.equal(await result.response!.text(), '{"openapi":"3.0.0"}');
  });

  test("returns the final non-2xx response for a direct public URL", async () => {
    vi.stubGlobal("fetch", (async () =>
      mockResponse({ status: 404 })) as unknown as typeof fetch);
    const result = await safeFetch("http://1.1.1.1/missing");
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  test("pins the checked DNS answer into the actual fetch connection", async () => {
    const resolverCalls: Row[] = [];
    const fetchCalls: Row[] = [];
    const resolver = async (host: string, options: unknown) => {
      resolverCalls.push([host, options] as unknown as Row);
      return [{ address: "93.184.216.34", family: 4 }];
    };
    vi.stubGlobal("fetch", (async (
      url: string | URL | Request,
      options: unknown,
    ) => {
      fetchCalls.push([String(url), options] as unknown as Row);
      return mockResponse({ status: 200 });
    }) as unknown as typeof fetch);

    const result = await safeFetch("http://rebind.example.test/surface", {
      resolver,
    } as unknown as Parameters<typeof safeFetch>[1]);

    assert.equal(result.ok, true);
    assert.deepEqual(resolverCalls, [
      ["rebind.example.test", { all: true, verbatim: true }],
    ]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], "http://rebind.example.test/surface");
    assert.ok(fetchCalls[0][1].dispatcher);
  });

  test("preserves caller method, headers, and abort signal with pinned fetches", async () => {
    const signal = AbortSignal.timeout(1000);
    const fetchCalls: Row[] = [];
    vi.stubGlobal("fetch", (async (
      url: string | URL | Request,
      options: unknown,
    ) => {
      fetchCalls.push([String(url), options] as unknown as Row);
      return mockResponse({ status: 204, contentType: null });
    }) as unknown as typeof fetch);

    const result = await safeFetch("http://1.1.1.1/health", {
      method: "HEAD",
      headers: {
        accept: "application/json",
        "user-agent": "metagraphed-smoke-probe/0.0",
      },
      signal,
    });

    assert.equal(result.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][1].method, "HEAD");
    assert.deepEqual(fetchCalls[0][1].headers, {
      accept: "application/json",
      "user-agent": "metagraphed-smoke-probe/0.0",
    });
    assert.equal(fetchCalls[0][1].signal, signal);
    assert.ok(fetchCalls[0][1].dispatcher);
  });
});

describe("createPinnedLookup", () => {
  const PINNED = "93.184.216.34";

  test("resolves the pinned host to the vetted address (single + all forms)", () => {
    const lookup = createPinnedLookup("example.test", PINNED, 4);

    // Node's single-answer form: callback(err, address, family).
    let single: Row | undefined;
    lookup("example.test", {}, ((
      err: Error | null,
      address?: string,
      family?: number,
    ) => {
      single = { err, address, family };
    }) as unknown as Parameters<typeof lookup>[2]);
    assert.equal(single!.err, null);
    assert.equal(single!.address, PINNED);
    assert.equal(single!.family, 4);

    // The `{ all: true }` form must return an address array. Hostname matching is
    // normalized, so an upper-cased request for the same host still resolves.
    let all: Row | undefined;
    lookup("EXAMPLE.TEST", { all: true }, ((
      err: Error | null,
      addresses?: Row[],
    ) => {
      all = { err, addresses };
    }) as unknown as Parameters<typeof lookup>[2]);
    assert.equal(all!.err, null);
    assert.deepEqual(all!.addresses, [{ address: PINNED, family: 4 }]);
  });

  test("rejects a connect-time lookup for any other (rebound) host", () => {
    const lookup = createPinnedLookup("example.test", PINNED, 4);
    let captured: Error | null | undefined;
    lookup("evil.test", { all: true }, ((err: Error | null) => {
      captured = err;
    }) as unknown as Parameters<typeof lookup>[2]);
    assert.ok(captured instanceof Error);
    assert.match(captured!.message, /unpinned host/);
  });
});
