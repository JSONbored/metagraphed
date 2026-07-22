import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  callSubnetSurface,
  matchSchemaOperation,
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

  test("path override: fetches the surface's origin + path, not surface.url", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/v1/users/123",
        method: "GET",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://example.com/v1/users/123");
          assert.equal(init.method, "GET");
          return jsonResponse({ id: 123 });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, { id: 123 });
  });

  test("path override: HEAD method is honored over the surface's own probe method", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json", probe: { method: "GET" } },
      {
        path: "/status",
        method: "HEAD",
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
  });

  test("path override: query params still merge onto the path-derived URL", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/search",
        method: "GET",
        query: { q: "x" },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          assert.equal(parsed.pathname, "/search");
          assert.equal(parsed.searchParams.get("q"), "x");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("path override: ignores any path/query the surface's own url happened to have", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/some/nested/openapi.json?x=1" },
      {
        path: "/other",
        method: "GET",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          assert.equal(url, "https://example.com/other");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("without a path override, method falls back to Phase 1's probe-derived default even if a method option is set alone", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api", probe: { method: "HEAD" } },
      {
        // method with no path is a caller misuse; callSubnetSurface itself
        // ignores it and stays on Phase 1 behavior -- the tool handler is
        // responsible for requiring path+method together.
        method: "GET",
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

describe("matchSchemaOperation", () => {
  test("throws when path does not start with a slash", () => {
    assert.throws(
      () => matchSchemaOperation({ paths: {} }, "users/123", "GET"),
      /path must be a string starting with "\/"/,
    );
  });

  test("throws when method is missing or not a string", () => {
    assert.throws(
      () => matchSchemaOperation({ paths: {} }, "/users", ""),
      /method must be a non-empty string/,
    );
    assert.throws(
      () => matchSchemaOperation({ paths: {} }, "/users", undefined),
      /method must be a non-empty string/,
    );
  });

  test("returns null when document.paths is missing, empty, or malformed", () => {
    assert.equal(matchSchemaOperation({}, "/users", "GET"), null);
    assert.equal(matchSchemaOperation({ paths: {} }, "/users", "GET"), null);
    assert.equal(matchSchemaOperation({ paths: null }, "/users", "GET"), null);
    assert.equal(matchSchemaOperation(undefined, "/users", "GET"), null);
  });

  test("matches an exact literal path", () => {
    const getOp = { summary: "list users" };
    const document = { paths: { "/users": { get: getOp } } };
    const result = matchSchemaOperation(document, "/users", "GET");
    assert.deepEqual(result, { operation: getOp, matchedTemplate: "/users" });
  });

  test("matches a single {param} path segment", () => {
    const getOp = { summary: "get user" };
    const document = { paths: { "/users/{id}": { get: getOp } } };
    const result = matchSchemaOperation(document, "/users/123", "GET");
    assert.deepEqual(result, {
      operation: getOp,
      matchedTemplate: "/users/{id}",
    });
  });

  test("matches multiple {param} segments in one template", () => {
    const getOp = { summary: "get post" };
    const document = {
      paths: { "/users/{id}/posts/{postId}": { get: getOp } },
    };
    const result = matchSchemaOperation(
      document,
      "/users/123/posts/456",
      "GET",
    );
    assert.deepEqual(result, {
      operation: getOp,
      matchedTemplate: "/users/{id}/posts/{postId}",
    });
  });

  test("does not match when the concrete path has more segments than the template", () => {
    const document = { paths: { "/users/{id}": { get: {} } } };
    assert.equal(
      matchSchemaOperation(document, "/users/123/extra", "GET"),
      null,
    );
  });

  test("does not match when the concrete path has fewer segments than the template", () => {
    const document = { paths: { "/users/{id}/posts": { get: {} } } };
    assert.equal(matchSchemaOperation(document, "/users/123", "GET"), null);
  });

  test("does not match when a literal segment differs", () => {
    const document = { paths: { "/users/{id}": { get: {} } } };
    assert.equal(matchSchemaOperation(document, "/accounts/123", "GET"), null);
  });

  test("returns null when the path matches but the method is not declared", () => {
    const document = { paths: { "/users": { get: {} } } };
    assert.equal(matchSchemaOperation(document, "/users", "POST"), null);
  });

  test("is case-insensitive on the requested method", () => {
    const getOp = { summary: "list users" };
    const document = { paths: { "/users": { get: getOp } } };
    assert.deepEqual(matchSchemaOperation(document, "/users", "get"), {
      operation: getOp,
      matchedTemplate: "/users",
    });
    assert.deepEqual(matchSchemaOperation(document, "/users", "GeT"), {
      operation: getOp,
      matchedTemplate: "/users",
    });
  });

  test("treats doubled/trailing slashes the same as a clean path on both sides", () => {
    const getOp = { summary: "list users" };
    const document = { paths: { "/users/": { get: getOp } } };
    assert.deepEqual(matchSchemaOperation(document, "/users", "GET"), {
      operation: getOp,
      matchedTemplate: "/users/",
    });
  });

  test("ignores a query string or fragment appended to the concrete path", () => {
    const getOp = { summary: "list users" };
    const document = { paths: { "/users": { get: getOp } } };
    assert.deepEqual(matchSchemaOperation(document, "/users?limit=5", "GET"), {
      operation: getOp,
      matchedTemplate: "/users",
    });
    assert.deepEqual(matchSchemaOperation(document, "/users#frag", "GET"), {
      operation: getOp,
      matchedTemplate: "/users",
    });
  });

  test("skips a malformed path-item entry instead of throwing", () => {
    const getOp = { summary: "list users" };
    const document = {
      paths: { "/broken": null, "/users": { get: getOp } },
    };
    assert.deepEqual(matchSchemaOperation(document, "/users", "GET"), {
      operation: getOp,
      matchedTemplate: "/users",
    });
  });

  test("root path matches an empty-segment template", () => {
    const getOp = { summary: "root" };
    const document = { paths: { "/": { get: getOp } } };
    assert.deepEqual(matchSchemaOperation(document, "/", "GET"), {
      operation: getOp,
      matchedTemplate: "/",
    });
  });
});
