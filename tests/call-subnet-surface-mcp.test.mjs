// MCP-level tests for the call_subnet_surface tool (metagraphed#7014, MCP
// execute Phase 1). Mirrors tests/surface-verify.test.mjs's
// verify_integration MCP-tool describe block: same catalog fixture shape,
// same fetch-mock-with-try/finally-restore pattern, same DNS-rebinding-mock
// approach for the SSRF guard. src/call-subnet-surface.ts's own unit tests
// (tests/call-subnet-surface.test.mjs) exhaustively cover the fetch/
// redirect/body-capping logic in isolation; this file only proves the tool
// wiring (surface resolution, auth_required/probe.enabled gating, arg
// validation, error-code mapping) end-to-end through the real JSON-RPC path.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";

const NO_AUTH_SURFACE = {
  surface_id: "x:api:1",
  surface_key: "srf-xapi100000000",
  netuid: 5,
  kind: "subnet-api",
  url: "https://x.example/api",
  provider: "p",
  auth_required: false,
  probe: { method: "GET", expect: "json", timeout_ms: 8000, enabled: true },
};

const AUTH_SURFACE = {
  surface_id: "x:api:2",
  netuid: 6,
  kind: "subnet-api",
  url: "https://x.example/private",
  auth_required: true,
  probe: { method: "GET", enabled: true },
};

const DISABLED_PROBE_SURFACE = {
  surface_id: "x:api:3",
  netuid: 7,
  kind: "subnet-api",
  url: "https://x.example/flaky",
  auth_required: false,
  probe: { method: "GET", enabled: false },
};

// #7674 (MCP execute Phase 2b) fixtures: a surface whose captured schema
// lives under a DIFFERENT surface_id (schema_source cross-reference, the
// normal case for a subnet-api surface backed by a sibling openapi surface),
// a surface with no schema at all, and a surface with no schema_source but
// whose own surface_id happens to resolve (the self-describing fallback).
const SCHEMA_SURFACE = {
  surface_id: "x:api:4",
  netuid: 8,
  kind: "subnet-api",
  url: "https://x.example/anything",
  provider: "p",
  auth_required: false,
  probe: { method: "GET", expect: "json", timeout_ms: 8000, enabled: true },
  schema_source: { surface_id: "x:openapi:1" },
};

const NO_SCHEMA_SURFACE = {
  surface_id: "x:api:5",
  netuid: 9,
  kind: "subnet-api",
  url: "https://x.example/bare",
  auth_required: false,
  probe: { method: "GET", enabled: true },
  schema_source: null,
};

const SELF_SCHEMA_SURFACE = {
  surface_id: "x:openapi:1",
  netuid: 8,
  kind: "openapi",
  url: "https://x.example/openapi.json",
  auth_required: false,
  probe: { method: "HEAD", enabled: true },
};

const SCHEMA_DOCUMENT = {
  document: {
    paths: {
      "/users/{id}": { get: { summary: "get user" } },
      "/users": {
        post: {
          summary: "create user",
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
      "/users/{id}/notes": {
        put: {
          summary: "replace note",
          requestBody: {
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
      "/ping": {
        post: { summary: "ping, no request body declared" },
      },
      "/multi": {
        post: {
          summary: "ambiguous media type",
          requestBody: {
            content: {
              "application/xml": { schema: { type: "object" } },
              "text/csv": { schema: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

// #7686 (MCP execute Phase 3a) fixtures: a fully-documented bearer surface
// (header location), an api-key surface (query location), a custom-scheme
// surface (no generic mechanism), and a bearer surface missing
// auth.location/auth.name (scheme is generic, but not documented enough).
const BEARER_SURFACE = {
  surface_id: "x:api:6",
  netuid: 10,
  kind: "subnet-api",
  url: "https://x.example/admin",
  auth_required: true,
  auth: { scheme: "bearer", location: "header", name: "Authorization" },
  probe: { method: "GET", enabled: true },
};

const API_KEY_QUERY_SURFACE = {
  surface_id: "x:api:7",
  netuid: 11,
  kind: "subnet-api",
  url: "https://x.example/billing",
  auth_required: true,
  auth: { scheme: "api-key", location: "query", name: "api_key" },
  probe: { method: "GET", enabled: true },
};

const CUSTOM_AUTH_SURFACE = {
  surface_id: "x:api:8",
  netuid: 12,
  kind: "subnet-api",
  url: "https://x.example/custom",
  auth_required: true,
  auth: { scheme: "custom" },
  probe: { method: "GET", enabled: true },
};

const INCOMPLETE_AUTH_SURFACE = {
  surface_id: "x:api:9",
  netuid: 13,
  kind: "subnet-api",
  url: "https://x.example/undocumented",
  auth_required: true,
  auth: { scheme: "bearer" },
  probe: { method: "GET", enabled: true },
};

const DISABLED_PROBE_BEARER_SURFACE = {
  surface_id: "x:api:10",
  netuid: 14,
  kind: "subnet-api",
  url: "https://x.example/disabled-admin",
  auth_required: true,
  auth: { scheme: "bearer", location: "header", name: "Authorization" },
  probe: { method: "GET", enabled: false },
};

// A generically-supported scheme with `name` documented but `location`
// missing -- distinct from INCOMPLETE_AUTH_SURFACE above (which is missing
// `name` too, short-circuiting before location is ever checked).
const MISSING_LOCATION_SURFACE = {
  surface_id: "x:api:11",
  netuid: 15,
  kind: "subnet-api",
  url: "https://x.example/no-location",
  auth_required: true,
  auth: { scheme: "bearer", name: "Authorization" },
  probe: { method: "GET", enabled: true },
};

// #7701 (MCP execute Phase 4): scheme:signature multi-value credential
// bundle fixtures -- a Bittensor hotkey-signed request the CALLER computes
// and supplies as a complete {name: value} bundle; this tool only places it,
// never signs anything itself.
const SIGNATURE_HEADER_SURFACE = {
  surface_id: "x:api:12",
  netuid: 16,
  kind: "subnet-api",
  url: "https://x.example/signed",
  auth_required: true,
  auth: {
    scheme: "signature",
    location: "header",
    names: ["X-Hotkey", "X-Timestamp", "X-Signature"],
  },
  probe: { method: "GET", enabled: true },
};

const SIGNATURE_QUERY_SURFACE = {
  surface_id: "x:api:13",
  netuid: 17,
  kind: "subnet-api",
  url: "https://x.example/signed-query",
  auth_required: true,
  auth: {
    scheme: "signature",
    location: "query",
    names: ["validator_hotkey", "signature"],
  },
  probe: { method: "GET", enabled: true },
};

const SIGNATURE_COOKIE_SURFACE = {
  surface_id: "x:api:14",
  netuid: 18,
  kind: "subnet-api",
  url: "https://x.example/signed-cookie",
  auth_required: true,
  auth: { scheme: "signature", location: "cookie", names: ["session", "csrf"] },
  probe: { method: "GET", enabled: true },
};

// Body-location signature needs a captured schema (the credential merges
// into a POST/PUT JSON body) -- reuses SCHEMA_DOCUMENT's /users and /ping
// operations via schema_source, same as SCHEMA_SURFACE above.
const SIGNATURE_BODY_SURFACE = {
  surface_id: "x:api:15",
  netuid: 19,
  kind: "subnet-api",
  url: "https://x.example/signed-body",
  auth_required: true,
  auth: {
    scheme: "signature",
    location: "body",
    names: ["identity", "timestamp", "signature"],
  },
  probe: { method: "GET", enabled: true },
  schema_source: { surface_id: "x:openapi:1" },
};

const SIGNATURE_NO_NAMES_SURFACE = {
  surface_id: "x:api:16",
  netuid: 20,
  kind: "subnet-api",
  url: "https://x.example/signed-undocumented",
  auth_required: true,
  auth: { scheme: "signature", location: "header" },
  probe: { method: "GET", enabled: true },
};

const SIGNATURE_EMPTY_NAMES_SURFACE = {
  surface_id: "x:api:17",
  netuid: 21,
  kind: "subnet-api",
  url: "https://x.example/signed-empty-names",
  auth_required: true,
  auth: { scheme: "signature", location: "header", names: [] },
  probe: { method: "GET", enabled: true },
};

const SIGNATURE_NO_LOCATION_SURFACE = {
  surface_id: "x:api:18",
  netuid: 22,
  kind: "subnet-api",
  url: "https://x.example/signed-no-location",
  auth_required: true,
  auth: { scheme: "signature", names: ["X-Hotkey", "X-Signature"] },
  probe: { method: "GET", enabled: true },
};

const CATALOG = {
  surfaces: [
    NO_AUTH_SURFACE,
    AUTH_SURFACE,
    DISABLED_PROBE_SURFACE,
    SCHEMA_SURFACE,
    NO_SCHEMA_SURFACE,
    SELF_SCHEMA_SURFACE,
    BEARER_SURFACE,
    API_KEY_QUERY_SURFACE,
    CUSTOM_AUTH_SURFACE,
    INCOMPLETE_AUTH_SURFACE,
    DISABLED_PROBE_BEARER_SURFACE,
    MISSING_LOCATION_SURFACE,
    SIGNATURE_HEADER_SURFACE,
    SIGNATURE_QUERY_SURFACE,
    SIGNATURE_COOKIE_SURFACE,
    SIGNATURE_BODY_SURFACE,
    SIGNATURE_NO_NAMES_SURFACE,
    SIGNATURE_EMPTY_NAMES_SURFACE,
    SIGNATURE_NO_LOCATION_SURFACE,
  ],
};

const deps = {
  readArtifact: async (_e, path) => {
    if (path === "/metagraph/operational-surfaces.json") {
      return { ok: true, data: CATALOG };
    }
    if (path === "/metagraph/schemas/x:openapi:1.json") {
      return { ok: true, data: SCHEMA_DOCUMENT };
    }
    return { ok: false, status: 404 };
  },
};

async function callTool(args, fetchImpl) {
  const of = globalThis.fetch;
  globalThis.fetch =
    fetchImpl ??
    (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
  try {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_subnet_surface", arguments: args },
        }),
      }),
      {},
      deps,
    );
    return (await response.json()).result;
  } finally {
    globalThis.fetch = of;
  }
}

describe("call_subnet_surface MCP tool (#7014)", () => {
  test("happy path: returns the real response body, not just health metadata", async () => {
    const result = await callTool({ surface_id: "x:api:1" });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.surface_id, "x:api:1");
    assert.equal(result.structuredContent.status_code, 200);
    assert.deepEqual(result.structuredContent.body, { ok: true });
  });

  test("resolves by stable surface_key too", async () => {
    const result = await callTool({ surface_id: "srf-xapi100000000" });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.surface_id, "x:api:1");
  });

  test("missing surface_id is invalid_params", async () => {
    const result = await callTool({});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid_params/);
  });

  test("malformed surface_id format is invalid_params", async () => {
    const result = await callTool({ surface_id: "not a valid id!" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid_params/);
  });

  test("unknown surface_id is not_found", async () => {
    const result = await callTool({ surface_id: "does-not-exist" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not_found/);
  });

  test("an authenticated surface is rejected outright (Phase 3 not built)", async () => {
    const result = await callTool({ surface_id: "x:api:2" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /auth_required/);
  });

  test("a surface with probe.enabled:false is rejected", async () => {
    const result = await callTool({ surface_id: "x:api:3" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /surface_unavailable/);
  });

  test("merges query params onto the curated URL", async () => {
    let requestedUrl;
    const result = await callTool(
      { surface_id: "x:api:1", query: { limit: 3 } },
      async (url) => {
        requestedUrl = String(url);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(result.isError, false);
    assert.equal(new URL(requestedUrl).searchParams.get("limit"), "3");
  });

  test("an upstream fetch failure maps to upstream_unavailable", async () => {
    const result = await callTool({ surface_id: "x:api:1" }, async () => {
      throw new Error("connection refused");
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /upstream_unavailable/);
  });

  test("an upstream error with no message falls back to a generic message", async () => {
    const result = await callTool({ surface_id: "x:api:1" }, async () => {
      throw new Error("");
    });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /upstream_unavailable: The surface could not be reached\./,
    );
  });

  test("a malformed JSON body is still returned, with parse_error set", async () => {
    const result = await callTool(
      { surface_id: "x:api:1" },
      async () =>
        new Response("{not valid json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.body, "{not valid json");
    assert.ok(result.structuredContent.parse_error);
  });

  test("a binary content-type maps to unsupported_content_type", async () => {
    const result = await callTool(
      { surface_id: "x:api:1" },
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unsupported_content_type/);
  });

  test("blocks DNS-rebinding on a catalogued no-auth surface before ever fetching it", async () => {
    let surfaceFetches = 0;
    const result = await callTool({ surface_id: "x:api:1" }, async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(
          JSON.stringify({ Answer: [{ type: 1, data: "10.0.0.5" }] }),
          { headers: { "content-type": "application/dns-json" } },
        );
      }
      surfaceFetches += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /forbidden/);
    assert.equal(surfaceFetches, 0);
  });

  // #7674 (MCP execute Phase 2b): path/method schema-validated execution.
  describe("path/method execution (#7674)", () => {
    test("valid path/method fetches the surface's origin + path, not its curated url", async () => {
      let requestedUrl;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users/123",
          method: "GET",
        },
        async (url) => {
          requestedUrl = String(url);
          return new Response(JSON.stringify({ id: 123 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(requestedUrl, "https://x.example/users/123");
      assert.deepEqual(result.structuredContent.body, { id: 123 });
    });

    test("resolves the schema via schema_source.surface_id, not the calling surface's own id", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
        method: "GET",
      });
      assert.equal(result.isError, false);
    });

    test("falls back to the surface's own surface_id when schema_source is absent", async () => {
      const result = await callTool({
        surface_id: "x:openapi:1",
        path: "/users/123",
        method: "GET",
      });
      assert.equal(result.isError, false);
    });

    test("method is case-insensitive and normalized before schema matching", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
        method: "get",
      });
      assert.equal(result.isError, false);
    });

    test("path without method is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("method without path is invalid_params", async () => {
      const result = await callTool({ surface_id: "x:api:4", method: "GET" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("a method outside GET/HEAD/POST/PUT is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
        method: "DELETE",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("a surface with no captured schema at all is rejected with no_schema", async () => {
      const result = await callTool({
        surface_id: "x:api:5",
        path: "/anything",
        method: "GET",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no_schema/);
    });

    test("an undeclared path is rejected with path_not_declared", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/not/in/the/schema",
        method: "GET",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /path_not_declared/);
    });

    test("a declared path with an undeclared method is rejected with path_not_declared", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
        method: "HEAD",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /path_not_declared/);
    });

    test("an auth_required surface is still rejected before schema resolution ever runs", async () => {
      const result = await callTool({
        surface_id: "x:api:2",
        path: "/anything",
        method: "GET",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /auth_required/);
    });

    test("a path resolving outside the surface's own origin is rejected as forbidden, never fetched", async () => {
      let fetched = false;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          // Matches the declared /users/{id} template's shape (2 segments,
          // literal "users" first) -- matchSchemaOperation approves it, but
          // the leading "//" makes new URL() treat "users" as the target
          // host instead of a path segment on the surface's own origin.
          path: "//users/attacker.example",
          method: "GET",
        },
        async () => {
          fetched = true;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /forbidden/);
      assert.equal(fetched, false);
    });

    test("without path/method, a schema-bearing surface still uses its own curated url (Phase 1 unchanged)", async () => {
      let requestedUrl;
      const result = await callTool({ surface_id: "x:api:4" }, async (url) => {
        requestedUrl = String(url);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      assert.equal(result.isError, false);
      assert.equal(requestedUrl, "https://x.example/anything");
    });
  });

  // #7675 (MCP execute Phase 2c): POST/PUT + request bodies.
  describe("POST/PUT request bodies (#7675)", () => {
    test("a JSON object body is serialized and sent with application/json", async () => {
      let sentBody;
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users",
          method: "POST",
          body: { name: "ada" },
        },
        async (url, init) => {
          sentBody = init.body;
          sentContentType = init.headers["content-type"];
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentBody, JSON.stringify({ name: "ada" }));
      assert.equal(sentContentType, "application/json");
    });

    test("a pre-serialized JSON string body is sent as-is", async () => {
      let sentBody;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users",
          method: "POST",
          body: '{"name":"ada"}',
        },
        async (url, init) => {
          sentBody = init.body;
          return new Response("{}", {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentBody, '{"name":"ada"}');
    });

    test("a non-JSON declared media type requires a string body and is sent as-is", async () => {
      let sentBody;
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users/123/notes",
          method: "PUT",
          body: "plain note text",
        },
        async (url, init) => {
          sentBody = init.body;
          sentContentType = init.headers["content-type"];
          return new Response("ok", { status: 200 });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentBody, "plain note text");
      assert.equal(sentContentType, "text/plain");
    });

    test("an object body against a non-JSON-only media type is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123/notes",
        method: "PUT",
        body: { not: "a string" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("a body against an operation with no declared request body is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/ping",
        method: "POST",
        body: { x: 1 },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("POST/PUT with no body arg at all is allowed (body is optional)", async () => {
      const result = await callTool(
        { surface_id: "x:api:4", path: "/ping", method: "POST" },
        async () => new Response("pong", { status: 200 }),
      );
      assert.equal(result.isError, false);
    });

    test("an explicit content_type not declared for the operation is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users",
        method: "POST",
        body: { name: "ada" },
        content_type: "application/xml",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("an explicit content_type matching a declared media type is honored", async () => {
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/multi",
          method: "POST",
          body: "a,b,c",
          content_type: "text/csv",
        },
        async (url, init) => {
          sentContentType = init.headers["content-type"];
          return new Response("ok", { status: 200 });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentContentType, "text/csv");
    });

    test("an ambiguous multi-media-type operation with no content_type override is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/multi",
        method: "POST",
        body: "a,b,c",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("content_type without a body is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        content_type: "application/json",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("body without path/method is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        body: { x: 1 },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("body with method GET is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
        method: "GET",
        body: { x: 1 },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("an array body is rejected as an invalid type", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users",
        method: "POST",
        body: [1, 2, 3],
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });
  });

  // #7686 (MCP execute Phase 3a): credential-passthrough eligibility + placement.
  describe("credential passthrough (#7686)", () => {
    test("a bearer surface with a credential injects it as the documented header", async () => {
      let sentHeader;
      const result = await callTool(
        { surface_id: "x:api:6", credential: "Bearer abc123" },
        async (url, init) => {
          sentHeader = init.headers.Authorization;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentHeader, "Bearer abc123");
    });

    test("an api-key surface with a credential injects it as the documented query param", async () => {
      let requestedUrl;
      const result = await callTool(
        { surface_id: "x:api:7", credential: "abc123" },
        async (url) => {
          requestedUrl = String(url);
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(new URL(requestedUrl).searchParams.get("api_key"), "abc123");
    });

    test("no credential on an auth_required surface is still auth_required (Phase 1/2 unchanged)", async () => {
      const result = await callTool({ surface_id: "x:api:6" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /auth_required/);
    });

    test("a credential on a custom-scheme surface is credential_not_supported", async () => {
      const result = await callTool({
        surface_id: "x:api:8",
        credential: "whatever",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
    });

    test("a credential on a bearer surface missing location/name is credential_not_supported", async () => {
      const result = await callTool({
        surface_id: "x:api:9",
        credential: "whatever",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
    });

    test("a credential on a bearer surface with name but no location is credential_not_supported", async () => {
      // Distinct from the missing-name case above: name present, only
      // location absent -- exercises the `location !== ...` half of the
      // eligibility check, not just the `!name` short-circuit.
      const result = await callTool({
        surface_id: "x:api:11",
        credential: "whatever",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
    });

    test("a credential on a surface with auth_required but no auth object at all names the scheme as undocumented", async () => {
      const result = await callTool({
        surface_id: "x:api:2",
        credential: "whatever",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
      assert.match(result.content[0].text, /"undocumented"/);
    });

    test("a credential on a surface that doesn't require auth is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:1",
        credential: "whatever",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
    });

    test("a credentialed call to an eligible surface still respects probe.enabled:false", async () => {
      let fetched = false;
      const result = await callTool(
        { surface_id: "x:api:10", credential: "Bearer abc123" },
        async () => {
          fetched = true;
          return new Response("{}", { status: 200 });
        },
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /surface_unavailable/);
      assert.equal(fetched, false);
    });

    test("a credentialed call to a schema-bearing surface still works with path/method (Phase 2 + 3 compose)", async () => {
      let sentHeader;
      let requestedUrl;
      const result = await callTool(
        {
          surface_id: "x:api:6",
          credential: "Bearer abc123",
          path: "/admin",
          method: "GET",
        },
        async (url, init) => {
          requestedUrl = String(url);
          sentHeader = init.headers.Authorization;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      // x:api:6 has no captured schema, so this exercises the no_schema path
      // -- credential eligibility is still validated before schema resolution.
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no_schema/);
      assert.equal(sentHeader, undefined);
      assert.equal(requestedUrl, undefined);
    });
  });

  // #7701 (MCP execute Phase 4): scheme:signature multi-value credential
  // bundle -- eligibility validation and placement across every supported
  // location. src/call-subnet-surface.mjs's own unit tests already cover
  // placement/redaction exhaustively; this block proves the tool-layer
  // eligibility gate (name-set matching, value typing, body's path/method
  // requirement) end-to-end.
  describe("signature-scheme credential passthrough (#7701)", () => {
    test("location:header injects every named header", async () => {
      let sentHeaders;
      const result = await callTool(
        {
          surface_id: "x:api:12",
          credential: {
            "X-Hotkey": "5F...",
            "X-Timestamp": "1700000000",
            "X-Signature": "0xabc",
          },
        },
        async (url, init) => {
          sentHeaders = init.headers;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentHeaders["X-Hotkey"], "5F...");
      assert.equal(sentHeaders["X-Timestamp"], "1700000000");
      assert.equal(sentHeaders["X-Signature"], "0xabc");
    });

    test("location:query merges every named param", async () => {
      let requestedUrl;
      const result = await callTool(
        {
          surface_id: "x:api:13",
          credential: { validator_hotkey: "5F...", signature: "0xabc" },
        },
        async (url) => {
          requestedUrl = String(url);
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(
        new URL(requestedUrl).searchParams.get("validator_hotkey"),
        "5F...",
      );
      assert.equal(
        new URL(requestedUrl).searchParams.get("signature"),
        "0xabc",
      );
    });

    test("location:cookie joins every named cookie", async () => {
      let sentHeaders;
      const result = await callTool(
        {
          surface_id: "x:api:14",
          credential: { session: "abc", csrf: "def" },
        },
        async (url, init) => {
          sentHeaders = init.headers;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentHeaders.cookie, "session=abc; csrf=def");
    });

    test("location:body merges every named field into an explicitly-supplied JSON body", async () => {
      let sentBody;
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:15",
          path: "/users",
          method: "POST",
          body: { name: "ada" },
          credential: {
            identity: "5F...",
            timestamp: "1700000000",
            signature: "0xabc",
          },
        },
        async (url, init) => {
          sentBody = init.body;
          sentContentType = init.headers["content-type"];
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody), {
        name: "ada",
        identity: "5F...",
        timestamp: "1700000000",
        signature: "0xabc",
      });
      assert.equal(sentContentType, "application/json");
    });

    test("location:body with no separately-supplied body still defaults content-type to application/json", async () => {
      let sentBody;
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:15",
          path: "/ping",
          method: "POST",
          credential: {
            identity: "5F...",
            timestamp: "1700000000",
            signature: "0xabc",
          },
        },
        async (url, init) => {
          sentBody = init.body;
          sentContentType = init.headers["content-type"];
          return new Response("pong", { status: 200 });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody), {
        identity: "5F...",
        timestamp: "1700000000",
        signature: "0xabc",
      });
      assert.equal(sentContentType, "application/json");
    });

    test("a credential missing a required name is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:12",
        credential: { "X-Hotkey": "5F...", "X-Timestamp": "1700000000" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /Missing/);
    });

    test("a credential carrying an extra unexpected key is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:12",
        credential: {
          "X-Hotkey": "5F...",
          "X-Timestamp": "1700000000",
          "X-Signature": "0xabc",
          "X-Extra": "nope",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /Unexpected/);
    });

    test("a non-string credential value is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:12",
        credential: {
          "X-Hotkey": "5F...",
          "X-Timestamp": 1700000000,
          "X-Signature": "0xabc",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /non-empty string/);
    });

    test("an empty-string credential value is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:12",
        credential: {
          "X-Hotkey": "",
          "X-Timestamp": "1700000000",
          "X-Signature": "0xabc",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /non-empty string/);
    });

    test("a plain string credential is invalid_params -- signature scheme requires an object", async () => {
      const result = await callTool({
        surface_id: "x:api:12",
        credential: "just-a-string",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /object mapping/);
    });

    test("an object credential on a bearer surface is invalid_params -- bearer requires a string", async () => {
      const result = await callTool({
        surface_id: "x:api:6",
        credential: { token: "abc123" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /not an object/);
    });

    test("an array credential is treated as no credential at all (auth_required)", async () => {
      const result = await callTool({
        surface_id: "x:api:12",
        credential: ["5F...", "1700000000", "0xabc"],
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /auth_required/);
    });

    test("location:body without path/method (POST or PUT) is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:15",
        credential: {
          identity: "5F...",
          timestamp: "1700000000",
          signature: "0xabc",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /POST or PUT/);
    });

    test("location:body with method GET is invalid_params even though path is set", async () => {
      // Distinct from the no-path-at-all case above: exercises the PUT half
      // of the POST/PUT check once hasPath is already true.
      const result = await callTool({
        surface_id: "x:api:15",
        path: "/users/123",
        method: "GET",
        credential: {
          identity: "5F...",
          timestamp: "1700000000",
          signature: "0xabc",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /POST or PUT/);
    });

    test("a surface with no auth.names documented is credential_not_supported", async () => {
      const result = await callTool({
        surface_id: "x:api:16",
        credential: { "X-Hotkey": "5F..." },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
    });

    test("a surface with an empty auth.names array is credential_not_supported", async () => {
      const result = await callTool({
        surface_id: "x:api:17",
        credential: { whatever: "x" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
    });

    test("a surface with auth.names but no auth.location is credential_not_supported", async () => {
      const result = await callTool({
        surface_id: "x:api:18",
        credential: { "X-Hotkey": "5F...", "X-Signature": "0xabc" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /credential_not_supported/);
    });
  });

  // #7687 (MCP execute Phase 3b): a credential must never appear in usage
  // telemetry. usageEventProperties (src/usage-telemetry.mjs) is already a
  // strict allowlist that never receives raw tool args -- this proves that
  // holds for a real credentialed call, not just by reading the allowlist.
  describe("credential never reaches usage telemetry (#7687)", () => {
    test("a credentialed call_subnet_surface records only the allowlisted fields", async () => {
      const of = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const recorded = [];
      try {
        const response = await handleMcpRequest(
          new Request("https://metagraph.sh/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "call_subnet_surface",
                arguments: {
                  surface_id: "x:api:6",
                  credential: "Bearer super-secret-abc123",
                },
              },
            }),
          }),
          { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" },
          {
            ...deps,
            executionCtx: { waitUntil: (p) => p },
            recordUsageEvent: async (_env, event) => {
              recorded.push(event);
              return true;
            },
          },
        );
        await response.json();
      } finally {
        globalThis.fetch = of;
      }
      assert.equal(recorded.length, 1);
      const serialized = JSON.stringify(recorded[0]);
      assert.ok(!serialized.includes("super-secret-abc123"));
      assert.deepEqual(Object.keys(recorded[0]).sort(), [
        "durationMs",
        "mcpTool",
        "ok",
      ]);
      assert.equal(recorded[0].mcpTool, "call_subnet_surface");
    });
  });
});
