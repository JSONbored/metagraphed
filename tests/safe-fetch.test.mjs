import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { safeFetch } from "../scripts/lib.mjs";

// IP-literal URLs so isUnsafeResolvedUrl never needs DNS: 1.1.1.1 / 8.8.8.8 are
// public (safe); 169.254.169.254 (link-local, the classic cloud-metadata SSRF
// target) + 127.0.0.1 are private (unsafe). fetch is stubbed, so no network.
function mockResponse({
  status = 200,
  location = null,
  contentType = "application/json",
  body = "{}",
}) {
  const headers = new Map();
  if (location) headers.set("location", location);
  if (contentType) headers.set("content-type", contentType);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers.get(String(key).toLowerCase()) ?? null },
    text: async () => body,
    body: { cancel: async () => {} },
  };
}

describe("safeFetch SSRF guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("does NOT follow a redirect into a private address", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      return mockResponse({
        status: 302,
        location: "http://169.254.169.254/latest/meta-data/",
      });
    });

    const result = await safeFetch("http://1.1.1.1/");

    assert.equal(result.ok, false);
    assert.equal(result.unsafe, true);
    // The private redirect target must never be requested.
    assert.deepEqual(calls, ["http://1.1.1.1/"]);
    assert.ok(!calls.some((u) => u.includes("169.254.169.254")));
  });

  test("rejects an initial private URL without fetching it", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      return mockResponse({ status: 200 });
    });

    const result = await safeFetch("http://127.0.0.1:8080/admin");

    assert.equal(result.unsafe, true);
    assert.deepEqual(calls, []); // never connected
  });

  test("follows a redirect between public addresses and returns the final URL", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      return String(url) === "http://1.1.1.1/"
        ? mockResponse({ status: 301, location: "http://8.8.8.8/spec.json" })
        : mockResponse({ status: 200, body: '{"openapi":"3.0.0"}' });
    });

    const result = await safeFetch("http://1.1.1.1/", {
      accept: "application/json",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.url, "http://8.8.8.8/spec.json");
    assert.deepEqual(calls, ["http://1.1.1.1/", "http://8.8.8.8/spec.json"]);
    assert.equal(await result.response.text(), '{"openapi":"3.0.0"}');
  });

  test("returns the final non-2xx response for a direct public URL", async () => {
    vi.stubGlobal("fetch", async () => mockResponse({ status: 404 }));
    const result = await safeFetch("http://1.1.1.1/missing");
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });
});
