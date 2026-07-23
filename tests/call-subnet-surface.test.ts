import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  callSubnetSurface,
  matchSchemaOperation,
  MAX_RESPONSE_BYTES,
  type CallSubnetSurfaceOptions,
} from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";

const SAFE = async () => false;
const UNSAFE = async () => true;

function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Row } = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("callSubnetSurface", () => {
  test("throws when isUnsafeUrl is not provided", async () => {
    await assert.rejects(
      () =>
        callSubnetSurface(
          { url: "https://example.com" },
          {} as CallSubnetSurfaceOptions,
        ),
      /requires options.isUnsafeUrl/,
    );
  });

  test("throws the same way when options itself is omitted entirely", async () => {
    await assert.rejects(
      () =>
        (callSubnetSurface as unknown as (surface: Row) => Promise<Row>)({
          url: "https://example.com",
        }),
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
          assert.equal(init!.method, "GET");
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
          assert.equal(init!.method, "GET");
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
          assert.equal(init!.method, "HEAD");
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
          const parsed = new URL(url as string);
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
          const originalCancel = res.body!.cancel.bind(res.body);
          res.body!.cancel = async (...args: unknown[]) => {
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
    assert.equal((result.body as string).length, MAX_RESPONSE_BYTES);
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
          const n = Number((url as string).split("/").pop());
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
            init!.signal!.addEventListener("abort", () => {
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
        query: {
          keep: "yes",
          drop1: null,
          drop2: undefined,
        } as unknown as Record<string, string | number | boolean>,
        fetchImpl: async (url) => {
          const parsed = new URL(url as string);
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
          assert.equal(init!.method, "GET");
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
          assert.equal(init!.method, "HEAD");
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
          const parsed = new URL(url as string);
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

  test("path override: a protocol-relative path (//host) is rejected, never resolved to a foreign origin", async () => {
    let fetched = false;
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "//attacker.example",
        method: "GET",
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.path_origin_mismatch, true);
    assert.equal(fetched, false);
  });

  test("path override: a scheme-qualified absolute path is rejected, never resolved to a foreign origin", async () => {
    let fetched = false;
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "https://attacker.example/x",
        method: "GET",
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.path_origin_mismatch, true);
    assert.equal(fetched, false);
  });

  test("path override: a same-origin path with an extra leading slash still resolves to the surface's own host", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "//example.com/users",
        method: "GET",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          assert.equal(url, "https://example.com/users");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("POST with a body sends it with the given content-type", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/users",
        method: "POST",
        body: JSON.stringify({ name: "x" }),
        contentType: "application/json",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://example.com/users");
          assert.equal(init!.method, "POST");
          assert.equal(init!.body, JSON.stringify({ name: "x" }));
          assert.equal(
            (init!.headers as Record<string, string>)["content-type"],
            "application/json",
          );
          return jsonResponse({ id: 1 });
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("PUT with a body behaves the same way as POST", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/users/1",
        method: "PUT",
        body: JSON.stringify({ name: "y" }),
        contentType: "application/json",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(init!.method, "PUT");
          assert.equal(init!.body, JSON.stringify({ name: "y" }));
          return jsonResponse({ id: 1 });
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("a POST/PUT with no body sends no body and no content-type header", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/ping",
        method: "POST",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(init!.body, undefined);
          assert.equal(
            (init!.headers as Record<string, string>)["content-type"],
            undefined,
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("a GET/HEAD request never sends a body even if one was somehow supplied", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/users",
        method: "GET",
        body: JSON.stringify({ name: "x" }),
        contentType: "application/json",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(init!.method, "GET");
          assert.equal(init!.body, undefined);
          assert.equal(
            (init!.headers as Record<string, string>)["content-type"],
            undefined,
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("a body is preserved across a followed redirect", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/users",
        method: "POST",
        body: "raw-body",
        contentType: "text/plain",
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          calls += 1;
          if (url === "https://example.com/users") {
            assert.equal(init!.body, "raw-body");
            return new Response(null, {
              status: 307,
              headers: { location: "https://example.com/users/v2" },
            });
          }
          assert.equal(init!.method, "POST");
          assert.equal(init!.body, "raw-body");
          return jsonResponse({ ok: true });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });

  test("credential: header location sets the named header", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(
            (init!.headers as Record<string, string>).Authorization,
            "Bearer abc123",
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential: query location merges a query param, distinct from the query option", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        query: { limit: 5 },
        credential: {
          location: "query",
          name: "api_key",
          value: "abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          const parsed = new URL(url as string);
          assert.equal(parsed.searchParams.get("limit"), "5");
          assert.equal(parsed.searchParams.get("api_key"), "abc123");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential: query location works with no query option supplied at all", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "query",
          name: "api_key",
          value: "abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          const parsed = new URL(url as string);
          assert.equal(parsed.searchParams.get("api_key"), "abc123");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  // #7687 (MCP execute Phase 3b): a query-location credential is part of the
  // request URL itself, so it's the one placement that can leak back out
  // through this function's own return value -- these confirm it's redacted
  // everywhere a URL/error could carry it, while header/cookie placement
  // (never echoed anywhere by this module) needs no equivalent redaction.
  test("credential: query-location value is redacted in the successful response's url", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "query", name: "api_key", value: "abc123" },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => jsonResponse({}),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(new URL(result.url).searchParams.get("api_key"), "<redacted>");
    assert.ok(!result.url.includes("abc123"));
  });

  test("credential: query-location value is redacted in the url after a followed redirect", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "query", name: "api_key", value: "abc123" },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          if (new URL(url as string).pathname === "/api") {
            return new Response(null, {
              status: 302,
              // The surface's own redirect happens to echo the query string
              // back -- exactly the case that would leak the credential if
              // redirectTarget weren't redacted too.
              headers: {
                location: `https://example.com/api/v2?api_key=abc123`,
              },
            });
          }
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
    assert.ok(!result.url.includes("abc123"));
    assert.equal(new URL(result.url).searchParams.get("api_key"), "<redacted>");
  });

  test("credential: a redirect target with no credential-named param is returned unchanged (nothing to redact)", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "query", name: "api_key", value: "abc123" },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          if (new URL(url as string).pathname === "/api") {
            // The surface's redirect drops the query string entirely --
            // nothing named "api_key" ends up in the target.
            return new Response(null, {
              status: 302,
              headers: { location: "https://example.com/api/v2" },
            });
          }
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://example.com/api/v2");
  });

  test("credential: query-location value is redacted in a blocked-redirect's redirect_target", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "query", name: "api_key", value: "abc123" },
        isUnsafeUrl: async (url) => url.includes("internal"),
        fetchImpl: async (url) => {
          if (new URL(url as string).pathname === "/api") {
            return new Response(null, {
              status: 302,
              headers: {
                location: "https://internal.example/secret?api_key=abc123",
              },
            });
          }
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.private_redirect_blocked, true);
    assert.ok(!result.redirect_target!.includes("abc123"));
    assert.equal(
      new URL(result.redirect_target!).searchParams.get("api_key"),
      "<redacted>",
    );
  });

  test("credential: query-location value is not present when the surface has no query param matching auth.name", async () => {
    // The redaction only touches a param actually named after the
    // credential -- an unrelated same-named-looking query value some OTHER
    // param happens to carry is left alone (nothing to redact there).
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        query: { other: "abc123" },
        credential: { location: "query", name: "api_key", value: "abc123" },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => jsonResponse({}),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(new URL(result.url).searchParams.get("other"), "abc123");
    assert.equal(new URL(result.url).searchParams.get("api_key"), "<redacted>");
  });

  test("credential: header/cookie-location values never appear in the response url (nothing to redact there)", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => jsonResponse({}),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://example.com/api");
  });

  test("credential: any placement's value is scrubbed from a network-error message", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          throw new Error(
            "fetch failed: https://example.com/api (header Authorization: Bearer abc123)",
          );
        },
      },
    );
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes("Bearer abc123"));
    assert.ok(result.error.includes("<redacted>"));
  });

  test("credential: no credential supplied leaves error messages untouched", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          throw new Error("connection refused");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "connection refused");
  });

  // metagraphed#7701: multi-value credential bundle (scheme:signature) --
  // the caller has already computed every value themselves (e.g. signed a
  // request locally with their own Bittensor hotkey); this module only
  // places the bundle, never computes or validates a signature.
  test("credential bundle: header location sets every named header", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          values: {
            "X-Hotkey": "5F...",
            "X-Timestamp": "1700000000",
            "X-Signature": "0xabc",
          },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(
            (init!.headers as Record<string, string>)["X-Hotkey"],
            "5F...",
          );
          assert.equal(
            (init!.headers as Record<string, string>)["X-Timestamp"],
            "1700000000",
          );
          assert.equal(
            (init!.headers as Record<string, string>)["X-Signature"],
            "0xabc",
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential bundle: query location merges every named param", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "query",
          values: { validator_hotkey: "5F...", signature: "0xabc", nonce: "1" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url) => {
          const parsed = new URL(url as string);
          assert.equal(parsed.searchParams.get("validator_hotkey"), "5F...");
          assert.equal(parsed.searchParams.get("signature"), "0xabc");
          assert.equal(parsed.searchParams.get("nonce"), "1");
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential bundle: cookie location joins every named cookie with '; '", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "cookie",
          values: { session: "abc", csrf: "def" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(
            (init!.headers as Record<string, string>).cookie,
            "session=abc; csrf=def",
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential bundle: body location merges every named field into the outgoing JSON body", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/submit",
        method: "POST",
        body: JSON.stringify({ payload: "x" }),
        contentType: "application/json",
        credential: {
          location: "body",
          values: {
            identity: "5F...",
            timestamp: "1700000000",
            signature: "0xabc",
          },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.deepEqual(JSON.parse(init!.body as string), {
            payload: "x",
            identity: "5F...",
            timestamp: "1700000000",
            signature: "0xabc",
          });
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential bundle: body location works with no separately-supplied body (credential fields only)", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/submit",
        method: "POST",
        contentType: "application/json",
        credential: {
          location: "body",
          values: { identity: "5F...", signature: "0xabc" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.deepEqual(JSON.parse(init!.body as string), {
            identity: "5F...",
            signature: "0xabc",
          });
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  // metagraphed#7716: body-envelope credential placement -- some APIs wrap
  // the credential in its own nested object alongside the semantic payload
  // (e.g. soma's {"payload": {...}, "sig": {...}}) instead of a flat merge.
  test("credential bundle: body envelope nests the credential under its own key, alongside the supplied payload", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/miner/openrouter-key/add",
        method: "POST",
        body: JSON.stringify({ api_key: "sk-..." }),
        contentType: "application/json",
        credential: {
          location: "body",
          values: {
            signer_ss58: "5F...",
            nonce: "abc123",
            signature: "0xabc",
          },
          bodyEnvelope: { payloadKey: "payload", credentialKey: "sig" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.deepEqual(JSON.parse(init!.body as string), {
            payload: { api_key: "sk-..." },
            sig: {
              signer_ss58: "5F...",
              nonce: "abc123",
              signature: "0xabc",
            },
          });
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential bundle: body envelope defaults the payload key to {} with no separately-supplied body", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/openapi.json" },
      {
        path: "/miner/openrouter-key/delete",
        method: "POST",
        contentType: "application/json",
        credential: {
          location: "body",
          values: { signer_ss58: "5F...", nonce: "abc", signature: "0xabc" },
          bodyEnvelope: { payloadKey: "payload", credentialKey: "sig" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.deepEqual(JSON.parse(init!.body as string), {
            payload: {},
            sig: { signer_ss58: "5F...", nonce: "abc", signature: "0xabc" },
          });
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential bundle: query values are all redacted in the returned url", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "query",
          values: { validator_hotkey: "5F...", signature: "0xabc" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => jsonResponse({}),
      },
    );
    assert.equal(result.ok, true);
    assert.ok(!result.url.includes("5F..."));
    assert.ok(!result.url.includes("0xabc"));
    assert.equal(
      new URL(result.url).searchParams.get("validator_hotkey"),
      "<redacted>",
    );
    assert.equal(
      new URL(result.url).searchParams.get("signature"),
      "<redacted>",
    );
  });

  test("credential bundle: every value is scrubbed from a network-error message", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          values: { "X-Hotkey": "5F-secret", "X-Signature": "0xdeadbeef" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          throw new Error(
            "fetch failed (X-Hotkey: 5F-secret, X-Signature: 0xdeadbeef)",
          );
        },
      },
    );
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes("5F-secret"));
    assert.ok(!result.error.includes("0xdeadbeef"));
  });

  test("credential: a query-location credential with neither name nor values leaves the url unchanged (nothing to redact)", async () => {
    // Exercises the credentialEntries/names fallback all the way to [] --
    // a credential object present but carrying no name and no values (never
    // produced by the tool handler's own validation, but this module's own
    // "caller validates eligibility, this module only places/redacts"
    // contract means it must still degrade to a no-op rather than throw.
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "query" },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => jsonResponse({}),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://example.com/api");
  });

  test("credential: a credential with neither value nor values leaves error messages unchanged (nothing to redact)", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "header" },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          throw new Error("connection refused");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "connection refused");
  });

  test("credential bundle: an empty-string value in the bundle is skipped during error scrubbing", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          values: { "X-Hotkey": "5F-secret", "X-Empty": "" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async () => {
          throw new Error("fetch failed (X-Hotkey: 5F-secret)");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes("5F-secret"));
    assert.ok(result.error.includes("<redacted>"));
  });

  test("credential bundle: preserved across a same-origin redirect, stripped on cross-origin", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          values: { "X-Hotkey": "5F...", "X-Signature": "0xabc" },
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          calls += 1;
          if (url === "https://example.com/api") {
            assert.equal(
              (init!.headers as Record<string, string>)["X-Hotkey"],
              "5F...",
            );
            return new Response(null, {
              status: 307,
              headers: { location: "https://other.example/api" },
            });
          }
          assert.equal(
            (init!.headers as Record<string, string>)["X-Hotkey"],
            undefined,
          );
          assert.equal(
            (init!.headers as Record<string, string>)["X-Signature"],
            undefined,
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });

  test("credential: cookie location sets a Cookie header formatted name=value", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "cookie",
          name: "session",
          value: "abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(
            (init!.headers as Record<string, string>).cookie,
            "session=abc123",
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential: an unrecognized location is silently ignored, never placed anywhere", async () => {
    // callSubnetSurface only places a credential, it doesn't validate
    // eligibility (the tool handler already restricts location to
    // header/query/cookie/body before ever constructing this option) -- an
    // unrecognized value should be a no-op, not a crash or a guess.
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "nonsense" as "body",
          name: "x",
          value: "abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://example.com/api");
          assert.equal((init!.headers as Record<string, string>).x, undefined);
          assert.equal(
            (init!.headers as Record<string, string>).cookie,
            undefined,
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential: applies to the surface's curated url with no path override (Phase 1 shape)", async () => {
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: { location: "header", name: "X-Api-Key", value: "k" },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://example.com/api");
          assert.equal(
            (init!.headers as Record<string, string>)["X-Api-Key"],
            "k",
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
  });

  test("credential: a header-location credential is preserved across a same-origin redirect", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          calls += 1;
          if (url === "https://example.com/api") {
            assert.equal(
              (init!.headers as Record<string, string>).Authorization,
              "Bearer abc123",
            );
            return new Response(null, {
              status: 307,
              headers: { location: "https://example.com/api/v2" },
            });
          }
          assert.equal(
            (init!.headers as Record<string, string>).Authorization,
            "Bearer abc123",
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });

  test("credential: a header-location credential is stripped on a cross-origin redirect", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          calls += 1;
          if (url === "https://example.com/api") {
            assert.equal(
              (init!.headers as Record<string, string>).Authorization,
              "Bearer abc123",
            );
            return new Response(null, {
              status: 307,
              headers: { location: "https://other.example/api" },
            });
          }
          assert.equal(url, "https://other.example/api");
          assert.equal(
            (init!.headers as Record<string, string>).Authorization,
            undefined,
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });

  test("credential: once stripped on a cross-origin hop, stays stripped on a further redirect back to the original origin", async () => {
    let calls = 0;
    const result = await callSubnetSurface(
      { url: "https://example.com/api" },
      {
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer abc123",
        },
        isUnsafeUrl: SAFE,
        fetchImpl: async (url, init) => {
          calls += 1;
          if (url === "https://example.com/api") {
            return new Response(null, {
              status: 307,
              headers: { location: "https://other.example/api" },
            });
          }
          if (url === "https://other.example/api") {
            assert.equal(
              (init!.headers as Record<string, string>).Authorization,
              undefined,
            );
            return new Response(null, {
              status: 307,
              headers: { location: "https://example.com/api/v2" },
            });
          }
          assert.equal(url, "https://example.com/api/v2");
          assert.equal(
            (init!.headers as Record<string, string>).Authorization,
            undefined,
          );
          return jsonResponse({});
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
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
          assert.equal(init!.method, "HEAD");
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
    assert.equal((result.body as string).length, MAX_RESPONSE_BYTES);
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
      () =>
        matchSchemaOperation(
          { paths: {} },
          "/users",
          undefined as unknown as string,
        ),
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
