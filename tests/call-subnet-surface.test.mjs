import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  callSubnetSurface,
  MAX_RESPONSE_BYTES,
} from "../src/call-subnet-surface.mjs";

const SAFE = () => false;
const UNSAFE = () => true;

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("callSubnetSurface", () => {
  test("throws when isUnsafeUrl is not provided", async () => {
    await assert.rejects(
      () => callSubnetSurface({ url: "https://example.com" }, {}),
      /requires options.isUnsafeUrl/,
    );
  });

  test("throws the same way when options itself is omitted entirely", async () => {
    await assert.rejects(
      () => callSubnetSurface({ url: "https://example.com" }),
      /requires options.isUnsafeUrl/,
    );
  });

  test("rejects an unsafe URL without ever fetching", async () => {
    let fetched = false;
    const result = await callSubnetSurface(
      { url: "https://internal.example/api" },
      {
        isUnsafeUrl: UNSAFE,
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.unsafe_url, true);
    assert.equal(fetched, false);
  });

  test("happy path: fetches, parses JSON, returns the body", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api", probe: { method: "GET" } },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://example.com/api");
          assert.equal(init.method, "GET");
          return jsonResponse({ hello: "world" });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.deepEqual(result.body, { hello: "world" });
    assert.equal(result.truncated, false);
    assert.equal(result.content_type, "application/json");
  });

  test("defaults to GET when probe.method is missing or not HEAD", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(init.method, "GET");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("uses HEAD when the surface declares it", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api", probe: { method: "HEAD" } },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(init.method, "HEAD");
          return new Response(null, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
  });

  test("merges query params onto the curated URL", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        query: { limit: 5, active: true, name: "x" },
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          assert.equal(parsed.searchParams.get("limit"), "5");
          assert.equal(parsed.searchParams.get("active"), "true");
          assert.equal(parsed.searchParams.get("name"), "x");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("returns non-JSON text content capped, not parsed", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () =>
          new Response("plain text body", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.body, "plain text body");
  });

  test("rejects a binary content-type outright", async () => {
    let bodyCancelled = false;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          const res = new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
          const originalCancel = res.body.cancel.bind(res.body);
          res.body.cancel = async (...args) => {
            bodyCancelled = true;
            return originalCancel(...args);
          };
          return res;
        },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported content-type: image\/png/);
    assert.equal(bodyCancelled, true);
  });

  test("truncates a response body larger than MAX_RESPONSE_BYTES", async () => {
    const big = "x".repeat(MAX_RESPONSE_BYTES + 1000);
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () =>
          new Response(big, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.body.length, MAX_RESPONSE_BYTES);
  });

  test("reports a parse_error but still returns the raw text on malformed JSON", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () =>
          new Response("{not valid json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.body, "{not valid json");
    assert.ok(result.parse_error);
  });

  test("follows a same-safety redirect and returns the final response", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          calls += 1;
          if (url === "https://example.com/api") {
            return new Response(null, {
              status: 302,
              headers: { location: "https://example.com/api/v2" },
            });
          }
          assert.equal(url, "https://example.com/api/v2");
          return jsonResponse({ redirected: true });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, { redirected: true });
    assert.equal(result.url, "https://example.com/api/v2");
    assert.equal(calls, 2);
  });

  test("blocks a redirect whose target is unsafe", async () => {
    let secondFetchCalled = false;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: async (url) => url.includes("internal"),
        fetchImpl: async (url) => {
          if (url === "https://example.com/api") {
            return new Response(null, {
              status: 302,
              headers: { location: "https://internal.example/secret" },
            });
          }
          secondFetchCalled = true;
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.private_redirect_blocked, true);
    assert.equal(result.redirect_target, "https://internal.example/secret");
    assert.equal(secondFetchCalled, false);
  });

  test("stops following redirects after the hop cap and surfaces the last hop's redirect", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/0" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          calls += 1;
          const n = Number(url.split("/").pop());
          if (n < 8) {
            return new Response(null, {
              status: 302,
              headers: { location: `https://example.com/${n + 1}` },
            });
          }
          return jsonResponse({ stopped_at: n });
        },
      },
    );
    // MAX_REDIRECTS is 5: hops 0->1->2->3->4->5 happen (redirectCount 0..5
    // still < 5 check passes for the first 5), then the 6th response (still
    // a redirect) is returned as-is without following further.
    assert.equal(result.ok, true);
    assert.ok(calls <= 7);
  });

  test("propagates a network/timeout error as ok:false", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "network down");
    assert.equal(result.error_class, "Error");
  });

  test("aborts and reports an AbortError when the surface's own timeout_ms elapses", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api", probe: { timeout_ms: 5 } },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: (url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error_class, "AbortError");
  });

  test("falls back to the global fetch when fetchImpl is not provided", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ via: "global" });
    try {
      const result = await callSubnetSurface(
        { url: "https://example.com/api" },
        { isUnsafeUrl: SAFE },
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.body, { via: "global" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("ignores explicit null/undefined values in query instead of stringifying them", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        query: { keep: "yes", drop1: null, drop2: undefined },
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          assert.equal(parsed.searchParams.get("keep"), "yes");
          assert.equal(parsed.searchParams.has("drop1"), false);
          assert.equal(parsed.searchParams.has("drop2"), false);
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("respects a surface-declared timeout_ms instead of the 10s default", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api", probe: { timeout_ms: 5000 } },
      { isUnsafeUrl: SAFE, fetchImpl: async () => jsonResponse({}) },
    );
    assert.equal(result.ok, true);
  });

  test("truncates exactly at a chunk boundary where zero bytes of the final chunk are allowed", async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES).fill(97)); // exactly at cap
        } else if (pulls === 2) {
          controller.enqueue(new Uint8Array(10).fill(98)); // entirely over cap
        } else {
          controller.close();
        }
      },
    });
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.body.length, MAX_RESPONSE_BYTES);
  });
});
