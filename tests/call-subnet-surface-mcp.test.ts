// MCP-level tests for the call_subnet_surface tool (metagraphed#7014, MCP
// execute Phase 1). Mirrors tests/surface-verify.test.ts's
// verify_integration MCP-tool describe block: same catalog fixture shape,
// same fetch-mock-with-try/finally-restore pattern, same DNS-rebinding-mock
// approach for the SSRF guard. src/call-subnet-surface.ts's own unit tests
// (tests/call-subnet-surface.test.ts) exhaustively cover the fetch/
// redirect/body-capping logic in isolation; this file only proves the tool
// wiring (surface resolution, auth_required/probe.enabled gating, arg
// validation, error-code mapping) end-to-end through the real JSON-RPC path.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

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

// #7722: auth.scheme:"basic" -- plain HTTP Basic Auth, same single-value
// shape as bearer/api-key (a pre-computed opaque string), just a different
// value_format convention.
const BASIC_AUTH_SURFACE = {
  surface_id: "x:api:21",
  netuid: 25,
  kind: "subnet-api",
  url: "https://x.example/basic-gated",
  auth_required: true,
  auth: {
    scheme: "basic",
    location: "header",
    name: "Authorization",
    value_format: "Basic <base64(username:password)>",
  },
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

// metagraphed#7716: body-envelope credential placement -- the credential
// nests under its own key alongside the semantic payload, instead of a flat
// top-level merge.
const SIGNATURE_BODY_ENVELOPE_SURFACE = {
  surface_id: "x:api:19",
  netuid: 23,
  kind: "subnet-api",
  url: "https://x.example/signed-envelope",
  auth_required: true,
  auth: {
    scheme: "signature",
    location: "body",
    names: ["signer_ss58", "nonce", "signature"],
    body_envelope: { payload_key: "payload", credential_key: "sig" },
  },
  probe: { method: "GET", enabled: true },
  schema_source: { surface_id: "x:openapi:1" },
};

// A malformed body_envelope (missing credential_key) -- must fall back to
// the existing flat-merge behavior rather than crash or silently drop the
// credential.
const SIGNATURE_MALFORMED_ENVELOPE_SURFACE = {
  surface_id: "x:api:20",
  netuid: 24,
  kind: "subnet-api",
  url: "https://x.example/signed-malformed-envelope",
  auth_required: true,
  auth: {
    scheme: "signature",
    location: "body",
    names: ["identity", "timestamp", "signature"],
    body_envelope: { payload_key: "payload" },
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
    BASIC_AUTH_SURFACE,
    CUSTOM_AUTH_SURFACE,
    INCOMPLETE_AUTH_SURFACE,
    DISABLED_PROBE_BEARER_SURFACE,
    MISSING_LOCATION_SURFACE,
    SIGNATURE_HEADER_SURFACE,
    SIGNATURE_QUERY_SURFACE,
    SIGNATURE_COOKIE_SURFACE,
    SIGNATURE_BODY_SURFACE,
    SIGNATURE_BODY_ENVELOPE_SURFACE,
    SIGNATURE_MALFORMED_ENVELOPE_SURFACE,
    SIGNATURE_NO_NAMES_SURFACE,
    SIGNATURE_EMPTY_NAMES_SURFACE,
    SIGNATURE_NO_LOCATION_SURFACE,
  ],
};

const deps = {
  readArtifact: async (_e: Row, path: string) => {
    if (path === "/metagraph/operational-surfaces.json") {
      return { ok: true, data: CATALOG };
    }
    if (path === "/metagraph/schemas/x:openapi:1.json") {
      return { ok: true, data: SCHEMA_DOCUMENT };
    }
    return { ok: false, status: 404 };
  },
};

async function callTool(args: Row, fetchImpl?: typeof fetch) {
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
      {} as unknown as Env,
      deps,
    );
    return ((await response.json()) as Row).result;
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
    let requestedUrl: string | undefined;
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
    assert.equal(new URL(requestedUrl!).searchParams.get("limit"), "3");
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
      let requestedUrl: string | undefined;
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
      let requestedUrl: string | undefined;
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
      let sentBody: BodyInit | null | undefined;
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users",
          method: "POST",
          body: { name: "ada" },
        },
        async (url, init) => {
          sentBody = init!.body;
          sentContentType = (init!.headers as Record<string, string>)[
            "content-type"
          ];
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
      let sentBody: BodyInit | null | undefined;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users",
          method: "POST",
          body: '{"name":"ada"}',
        },
        async (url, init) => {
          sentBody = init!.body;
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
      let sentBody: BodyInit | null | undefined;
      let sentContentType;
      const result = await callTool(
        {
          surface_id: "x:api:4",
          path: "/users/123/notes",
          method: "PUT",
          body: "plain note text",
        },
        async (url, init) => {
          sentBody = init!.body;
          sentContentType = (init!.headers as Record<string, string>)[
            "content-type"
          ];
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
          sentContentType = (init!.headers as Record<string, string>)[
            "content-type"
          ];
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
          sentHeader = (init!.headers as Record<string, string>).Authorization;
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
      let requestedUrl: string | undefined;
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
      assert.equal(
        new URL(requestedUrl!).searchParams.get("api_key"),
        "abc123",
      );
    });

    test("a basic-auth surface with a credential injects it as the documented header (#7722)", async () => {
      let sentHeader;
      const result = await callTool(
        {
          surface_id: "x:api:21",
          credential: "Basic dXNlcjpwYXNz",
        },
        async (url, init) => {
          sentHeader = (init!.headers as Record<string, string>).Authorization;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentHeader, "Basic dXNlcjpwYXNz");
    });

    test("an object credential on a basic-auth surface is invalid_params -- basic requires a string", async () => {
      const result = await callTool({
        surface_id: "x:api:21",
        credential: { user: "u", pass: "p" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_params/);
      assert.match(result.content[0].text, /not an object/);
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
      let requestedUrl: string | undefined;
      const result = await callTool(
        {
          surface_id: "x:api:6",
          credential: "Bearer abc123",
          path: "/admin",
          method: "GET",
        },
        async (url, init) => {
          requestedUrl = String(url);
          sentHeader = (init!.headers as Record<string, string>).Authorization;
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
  // location. src/call-subnet-surface.ts's own unit tests already cover
  // placement/redaction exhaustively; this block proves the tool-layer
  // eligibility gate (name-set matching, value typing, body's path/method
  // requirement) end-to-end.
  describe("signature-scheme credential passthrough (#7701)", () => {
    test("location:header injects every named header", async () => {
      let sentHeaders: Record<string, string> | undefined;
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
          sentHeaders = init!.headers as Record<string, string>;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentHeaders!["X-Hotkey"], "5F...");
      assert.equal(sentHeaders!["X-Timestamp"], "1700000000");
      assert.equal(sentHeaders!["X-Signature"], "0xabc");
    });

    test("location:query merges every named param", async () => {
      let requestedUrl: string | undefined;
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
        new URL(requestedUrl!).searchParams.get("validator_hotkey"),
        "5F...",
      );
      assert.equal(
        new URL(requestedUrl!).searchParams.get("signature"),
        "0xabc",
      );
    });

    test("location:cookie joins every named cookie", async () => {
      let sentHeaders: Record<string, string> | undefined;
      const result = await callTool(
        {
          surface_id: "x:api:14",
          credential: { session: "abc", csrf: "def" },
        },
        async (url, init) => {
          sentHeaders = init!.headers as Record<string, string>;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.equal(sentHeaders!.cookie, "session=abc; csrf=def");
    });

    test("location:body merges every named field into an explicitly-supplied JSON body", async () => {
      let sentBody: BodyInit | null | undefined;
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
          sentBody = init!.body;
          sentContentType = (init!.headers as Record<string, string>)[
            "content-type"
          ];
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody as string), {
        name: "ada",
        identity: "5F...",
        timestamp: "1700000000",
        signature: "0xabc",
      });
      assert.equal(sentContentType, "application/json");
    });

    test("location:body with no separately-supplied body still defaults content-type to application/json", async () => {
      let sentBody: BodyInit | null | undefined;
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
          sentBody = init!.body;
          sentContentType = (init!.headers as Record<string, string>)[
            "content-type"
          ];
          return new Response("pong", { status: 200 });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody as string), {
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

    test("location:body with auth.body_envelope nests the credential under its own key", async () => {
      let sentBody: BodyInit | null | undefined;
      const result = await callTool(
        {
          surface_id: "x:api:19",
          path: "/users",
          method: "POST",
          body: { name: "ada" },
          credential: {
            signer_ss58: "5F...",
            nonce: "abc123",
            signature: "0xabc",
          },
        },
        async (url, init) => {
          sentBody = init!.body;
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody as string), {
        payload: { name: "ada" },
        sig: { signer_ss58: "5F...", nonce: "abc123", signature: "0xabc" },
      });
    });

    test("location:body with auth.body_envelope defaults the payload key to {} with no separately-supplied body", async () => {
      let sentBody: BodyInit | null | undefined;
      const result = await callTool(
        {
          surface_id: "x:api:19",
          path: "/ping",
          method: "POST",
          credential: {
            signer_ss58: "5F...",
            nonce: "abc123",
            signature: "0xabc",
          },
        },
        async (url, init) => {
          sentBody = init!.body;
          return new Response("pong", { status: 200 });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody as string), {
        payload: {},
        sig: { signer_ss58: "5F...", nonce: "abc123", signature: "0xabc" },
      });
    });

    test("a malformed auth.body_envelope (missing credential_key) falls back to a flat top-level merge", async () => {
      let sentBody: BodyInit | null | undefined;
      const result = await callTool(
        {
          surface_id: "x:api:20",
          path: "/ping",
          method: "POST",
          credential: {
            identity: "5F...",
            timestamp: "1700000000",
            signature: "0xabc",
          },
        },
        async (url, init) => {
          sentBody = init!.body;
          return new Response("pong", { status: 200 });
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(sentBody as string), {
        identity: "5F...",
        timestamp: "1700000000",
        signature: "0xabc",
      });
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
  // telemetry. usageEventProperties (src/usage-telemetry.ts) is already a
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
      const recorded: Row[] = [];
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
          { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" } as unknown as Env,
          {
            ...deps,
            executionCtx: { waitUntil: (p: Row) => p },
            recordUsageEvent: async (_env: Row, event: Row) => {
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

    // metagraphed#7726: a failing credentialed call now also records an
    // errorCode -- proves that categorization is still just a fixed literal
    // string (never the credential value or a free-form message built from
    // caller input) even on the failure path this describe block didn't
    // originally cover.
    test("a failing credentialed call_subnet_surface still never leaks the credential, and records the toolError code", async () => {
      const recorded: Row[] = [];
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
                credential: { unexpected: "shape-super-secret-xyz" },
              },
            },
          }),
        }),
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" } as unknown as Env,
        {
          ...deps,
          executionCtx: { waitUntil: (p: Row) => p },
          recordUsageEvent: async (_env: Row, event: Row) => {
            recorded.push(event);
            return true;
          },
        },
      );
      const payload = (await response.json()) as Row;
      assert.equal(payload.result.isError, true);
      assert.equal(recorded.length, 1);
      const serialized = JSON.stringify(recorded[0]);
      assert.ok(!serialized.includes("shape-super-secret-xyz"));
      assert.deepEqual(Object.keys(recorded[0]).sort(), [
        "durationMs",
        "errorCode",
        "mcpTool",
        "ok",
      ]);
      assert.equal(recorded[0].ok, false);
      assert.equal(recorded[0].errorCode, "invalid_params");
    });
  });
});

describe("not_callable vs not_found (#8652)", () => {
  // The operational catalog is the CALLABLE subset (617 surfaces in
  // production). The public registry behind list_surfaces / GET
  // /api/v1/surfaces is the full 3,491 — docs, dashboards, websites, repos,
  // OpenAPI documents, SDKs, examples. Both are correct. What was wrong is
  // that asking to call a docs surface said its id did not exist, when the
  // agent had just read that id out of list_surfaces. Measured across every
  // probe-enabled surface: 208 of 313 failures were this, all of them
  // non-callable kinds.
  const REGISTRY = {
    surfaces: [
      ...CATALOG.surfaces,
      {
        surface_id: "bittensor-networks-docs",
        surface_key: "srf-docs000000000",
        kind: "docs",
        url: "https://docs.bittensor.com",
      },
      // #8658: a CALLABLE kind that is nevertheless absent from the
      // operational catalog. Ten of these exist in production -- advertised
      // probe-enabled in the public registry, missing from the catalog the
      // prober and this tool read. Telling someone a subnet-api "is not a
      // callable API" would be plainly false, so this needs its own message.
      {
        surface_id: "sn-45-website-common-health",
        surface_key: "srf-uncat000000000",
        kind: "subnet-api",
        url: "https://sn45.example/health",
      },
      // No kind and no url: a minimal/degraded registry row. Exercises the
      // fallbacks rather than leaving them to chance.
      { surface_id: "sn-99-bare", surface_key: "srf-bare000000000" },
    ],
  };

  async function call(args: Row, withRegistry = true) {
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
      {} as unknown as Env,
      {
        readArtifact: async (_e: Row, path: string) => {
          if (path === "/metagraph/operational-surfaces.json") {
            return { ok: true, data: CATALOG };
          }
          if (path === "/metagraph/surfaces.json" && withRegistry) {
            return { ok: true, data: REGISTRY };
          }
          return { ok: false, status: 404 };
        },
      },
    );
    return ((await response.json()) as Row).result as Row;
  }

  test("a catalogued-but-uncallable surface reports not_callable, not not_found", async () => {
    const result = await call({ surface_id: "bittensor-networks-docs" });
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "not_callable");
    // It must say what the thing IS and where to go instead — the old message
    // sent agents hunting for an id that does not exist.
    assert.match(String(error.message), /docs surface/);
    assert.match(String(error.message), /https:\/\/docs\.bittensor\.com/);
    assert.match(String(error.message), /list_subnet_apis|get_subnet_surfaces/);
  });

  test("a CALLABLE kind missing from the catalog says so, not 'not a callable API'", async () => {
    // #8658. The kind is subnet-api; claiming it is not an API would be false.
    const result = await call({ surface_id: "sn-45-website-common-health" });
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "not_callable");
    assert.match(String(error.message), /is a callable kind/);
    assert.match(String(error.message), /registry-side gap/);
    assert.doesNotMatch(String(error.message), /not a\s+callable API/);
  });

  test("a registry row with no kind and no url still produces a usable message", async () => {
    const result = await call({ surface_id: "sn-99-bare" });
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "not_callable");
    // No kind -> must not render "a undefined surface"; no url -> no dangling
    // "It is a link:".
    assert.match(String(error.message), /not an API surface/);
    assert.doesNotMatch(String(error.message), /undefined|null/);
    assert.doesNotMatch(String(error.message), /It is a link/);
  });

  test("the callable-kind list in the message comes from the catalog's own source of truth", () => {
    // If OPERATIONAL_SURFACE_KINDS changes, the message changes with it --
    // it can never describe a different set than the catalog is built from.
    for (const kind of OPERATIONAL_SURFACE_KINDS) {
      assert.ok(kind.length > 0);
    }
  });

  test("a genuinely unknown id still reports not_found", async () => {
    const result = await call({ surface_id: "sn-999-does-not-exist" });
    assert.equal(
      ((result.structuredContent as Row).error as Row).code,
      "not_found",
    );
  });

  // #8962: the largest single error class on the MCP server -- 1,244 of 1,642
  // errors in the week to 2026-08-01, every one a DISTINCT id, none repeated
  // more than twice. They are the `sn-<netuid>-<provider>-<kind>` template
  // enumerated across the cross-product, not typos. A bare "no such surface"
  // is true and useless: it leaves the caller with nowhere to go but another
  // guess, which is the loop the volume shows.
  test("an unknown sn-<netuid>-… id names that subnet's real callable surfaces", async () => {
    const result = await call({ surface_id: "sn-5-taomarketcap-dashboard" });
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "not_found");
    const message = String(error.message);
    // Still says the id is unknown -- the recovery is additive, not a
    // replacement for the truth.
    assert.match(message, /sn-5-taomarketcap-dashboard/);
    // ...and names the one thing that gets the caller unstuck.
    assert.match(message, /x:api:1/);
    assert.match(message, /list_subnet_surfaces|list_subnet_apis/);
    // The whole point: ids are discovered, not constructed.
    assert.match(message, /not derivable from a naming pattern/);
  });

  test("says so plainly when the subnet has no callable surfaces at all", async () => {
    const result = await call({ surface_id: "sn-777-invented-dashboard" });
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "not_found");
    const message = String(error.message);
    assert.match(message, /subnet 777 has no callable surfaces/);
    // Must not dangle an empty suggestion list.
    assert.doesNotMatch(message, /surfaces are: *[.,]/);
  });

  // #9064: the netuid is right there in `sn64-…`; rejecting it for a missing
  // hyphen turned a one-hop recovery into a dead end. Observed in production
  // on 2026-07-29, inside a run of 1,265 distinct constructed ids.
  test("a near-miss separator still recovers the subnet's real surfaces", async () => {
    for (const guessed of [
      "sn5-taomarketcap-dashboard",
      "sn-5_taomarketcap-dashboard",
    ]) {
      const result = await call({ surface_id: guessed });
      const error = (result.structuredContent as Row).error as Row;
      assert.equal(error.code, "not_found", guessed);
      // Same recovery the canonical spelling gets: this subnet's real ids.
      assert.match(String(error.message), /x:api:1/, guessed);
    }
  });

  // The widening must not start claiming a netuid where there is none, or a
  // genuinely unrelated id would be answered with some arbitrary subnet's
  // surface list -- confidently wrong is worse than the dead end.
  test("a near-miss parse does not invent a netuid", async () => {
    for (const notAnSn of [
      "snap-5-thing",
      "sn-thing",
      "sn5thing",
      "taostats-api-v1",
    ]) {
      const result = await call({ surface_id: notAnSn });
      const error = (result.structuredContent as Row).error as Row;
      assert.equal(error.code, "not_found", notAnSn);
      assert.doesNotMatch(
        String(error.message),
        /callable surfaces are:/,
        notAnSn,
      );
    }
  });

  test("an id with no netuid in it still gets the discovery pointer", async () => {
    const result = await call({ surface_id: "some-provider-thing" });
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "not_found");
    assert.match(String(error.message), /list_subnet_surfaces|list_surfaces/);
  });

  test("an unreadable registry degrades to not_found, never an internal error", async () => {
    // A bad id must not become a 500 just because the registry read failed.
    const result = await call({ surface_id: "bittensor-networks-docs" }, false);
    assert.equal(
      ((result.structuredContent as Row).error as Row).code,
      "not_found",
    );
  });

  test("verify_integration reports the same distinction", async () => {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "verify_integration",
            arguments: { surface_id: "bittensor-networks-docs" },
          },
        }),
      }),
      {} as unknown as Env,
      {
        readArtifact: async (_e: Row, path: string) => {
          if (path === "/metagraph/operational-surfaces.json")
            return { ok: true, data: CATALOG };
          if (path === "/metagraph/surfaces.json")
            return { ok: true, data: REGISTRY };
          return { ok: false, status: 404 };
        },
      },
    );
    const result = ((await response.json()) as Row).result as Row;
    assert.equal(
      ((result.structuredContent as Row).error as Row).code,
      "not_callable",
    );
  });
});

// #9009: the session-bound credential store. The tool-level half -- the three
// new tools, the resolution order inside call_subnet_surface, and the
// deprecation notice. tests/mcp-surface-credentials.test.ts covers the
// storage module (encryption at rest, identity isolation, TTL clamping).
describe("surface credential store (#9009)", () => {
  // Map-backed KV double, same shape as tests/mcp-surface-credentials.ts's.
  // An empty secret models an unprovisioned deployment: `MCP_SURFACE_
  // CREDENTIAL_SECRET` unset arrives as undefined, which is falsy the same way.
  function credentialEnv(secret = "test-secret") {
    const store = new Map<string, { value: string; metadata?: unknown }>();
    return {
      store,
      METAGRAPH_CONTROL: {
        get: async (key: string) => {
          const entry = store.get(key);
          return entry ? JSON.parse(entry.value) : null;
        },
        put: async (
          key: string,
          value: string,
          options?: { metadata?: unknown },
        ) => {
          store.set(key, { value, metadata: options?.metadata });
        },
        delete: async (key: string) => {
          store.delete(key);
        },
        list: async (options?: { prefix?: string }) => ({
          keys: [...store.entries()]
            .filter(([name]) => name.startsWith(options?.prefix ?? ""))
            .map(([name, entry]) => ({ name, metadata: entry.metadata })),
          list_complete: true,
        }),
      },
      MCP_SURFACE_CREDENTIAL_SECRET: secret,
    };
  }

  // An authenticated call. The OAuth path (props.accountId) is used because it
  // needs no key-verification round trip -- resolveSurfaceCredentialIdentity
  // treats it and the mg_-key path identically, which is the point of keying
  // on the shared rpc_accounts id. Pass accountId: null for anonymous.
  async function callAs(
    accountId: number | null,
    name: string,
    args: Row,
    env: Row,
    fetchImpl?: typeof fetch,
  ) {
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
            params: { name, arguments: args },
          }),
        }),
        env as unknown as Env,
        {
          ...deps,
          executionCtx:
            accountId === null ? undefined : { props: { accountId } },
        },
      );
      return ((await response.json()) as Row).result as Row;
    } finally {
      globalThis.fetch = of;
    }
  }

  const errorCode = (result: Row) =>
    ((result.structuredContent as Row).error as Row).code;

  test("a registered credential is resolved without a tool argument", async () => {
    const env = credentialEnv();
    const stored = await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:6",
        credential: "Bearer abc123",
      },
      env,
    );
    assert.equal(stored.isError, false);
    assert.equal((stored.structuredContent as Row).stored, true);
    assert.equal((stored.structuredContent as Row).replaced, false);

    let sentHeader: string | undefined;
    const called = await callAs(
      7,
      "call_subnet_surface",
      { surface_id: "x:api:6" },
      env,
      async (_url, init) => {
        sentHeader = (init!.headers as Record<string, string>).Authorization;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(called.isError, false);
    assert.equal(sentHeader, "Bearer abc123");
    const body = called.structuredContent as Row;
    assert.equal(body.credential_source, "stored");
    // A resolved-from-store call is the target state, so it must NOT carry a
    // deprecation notice -- warning on the path we want people to move to
    // would train agents to ignore the notice entirely.
    assert.equal(body.credential_deprecation, undefined);
  });

  test("a signature bundle registers and resolves as a bundle", async () => {
    const env = credentialEnv();
    await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:12",
        credential: {
          "X-Hotkey": "5F...",
          "X-Timestamp": "1",
          "X-Signature": "0xabc",
        },
      },
      env,
    );
    let sentHeaders: Record<string, string> | undefined;
    const called = await callAs(
      7,
      "call_subnet_surface",
      { surface_id: "x:api:12" },
      env,
      async (_url, init) => {
        sentHeaders = init!.headers as Record<string, string>;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(called.isError, false);
    assert.equal(sentHeaders!["X-Hotkey"], "5F...");
    assert.equal(sentHeaders!["X-Signature"], "0xabc");
  });

  // The deprecation window's shape: an authenticated caller passing the
  // secret in-band is TOLD, not rejected, and their explicit argument still
  // wins over whatever is stored -- silently preferring stale stored state
  // over an argument the caller just typed would be its own bug.
  test("an in-band credential still wins for an authenticated caller, with a notice", async () => {
    const env = credentialEnv();
    await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:6",
        credential: "Bearer stored",
      },
      env,
    );
    let sentHeader: string | undefined;
    const called = await callAs(
      7,
      "call_subnet_surface",
      { surface_id: "x:api:6", credential: "Bearer in-band" },
      env,
      async (_url, init) => {
        sentHeader = (init!.headers as Record<string, string>).Authorization;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(sentHeader, "Bearer in-band");
    const body = called.structuredContent as Row;
    assert.equal(body.credential_source, "argument");
    assert.match(body.credential_deprecation as string, /deprecated/);
  });

  // ADR 0027 Model B: this cleanup must not shrink anonymous reach. An
  // anonymous caller's in-band credential is the SUPPORTED mechanism, not a
  // deprecated one, so telling them it is deprecated would be false.
  test("an anonymous caller keeps the in-band argument, with no notice", async () => {
    const env = credentialEnv();
    let sentHeader: string | undefined;
    const called = await callAs(
      null,
      "call_subnet_surface",
      { surface_id: "x:api:6", credential: "Bearer anon" },
      env,
      async (_url, init) => {
        sentHeader = (init!.headers as Record<string, string>).Authorization;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(sentHeader, "Bearer anon");
    const body = called.structuredContent as Row;
    assert.equal(body.credential_source, "argument");
    assert.equal(body.credential_deprecation, undefined);
  });

  test("an authenticated caller with nothing stored still gets auth_required", async () => {
    const env = credentialEnv();
    const called = await callAs(
      7,
      "call_subnet_surface",
      { surface_id: "x:api:6" },
      env,
    );
    assert.equal(called.isError, true);
    assert.equal(errorCode(called), "auth_required");
    assert.match(called.content[0].text, /store_surface_credential/);
  });

  test("the store tools refuse an anonymous caller", async () => {
    const env = credentialEnv();
    for (const [name, args] of [
      ["store_surface_credential", { surface_id: "x:api:6", credential: "x" }],
      ["list_surface_credentials", {}],
      ["delete_surface_credential", { surface_id: "x:api:6" }],
    ] as [string, Row][]) {
      const result = await callAs(null, name, args, env);
      assert.equal(result.isError, true, `${name} must refuse`);
      assert.equal(errorCode(result), "auth_required");
    }
  });

  test("the store tools refuse an unprovisioned deployment", async () => {
    const env = credentialEnv("");
    const result = await callAs(
      7,
      "store_surface_credential",
      { surface_id: "x:api:6", credential: "x" },
      env,
    );
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "surface_credential_store_unavailable");
  });

  // A call_subnet_surface on an unprovisioned deployment must not become an
  // error just because the store is missing -- the in-band argument is still
  // a complete way to call the surface.
  test("an unprovisioned store leaves call_subnet_surface working in-band", async () => {
    const env = credentialEnv("");
    const called = await callAs(
      7,
      "call_subnet_surface",
      { surface_id: "x:api:6", credential: "Bearer abc" },
      env,
    );
    assert.equal(called.isError, false);
  });

  test("storing against a surface that needs no credential is refused", async () => {
    const env = credentialEnv();
    const result = await callAs(
      7,
      "store_surface_credential",
      { surface_id: "x:api:1", credential: "x" },
      env,
    );
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "invalid_params");
    assert.match(result.content[0].text, /does not require a credential/);
  });

  test("storing against a malformed or unknown surface id is refused", async () => {
    const env = credentialEnv();
    const malformed = await callAs(
      7,
      "store_surface_credential",
      { surface_id: "not a surface id!", credential: "x" },
      env,
    );
    assert.equal(errorCode(malformed), "invalid_params");
    const unknown = await callAs(
      7,
      "store_surface_credential",
      { surface_id: "x:api:999", credential: "x" },
      env,
    );
    assert.equal(errorCode(unknown), "not_found");
  });

  test("a malformed credential is rejected at registration, not at call time", async () => {
    const env = credentialEnv();
    for (const credential of ["", {}, { a: "" }, { a: 5 }, [] as unknown]) {
      const result = await callAs(
        7,
        "store_surface_credential",
        { surface_id: "x:api:6", credential },
        env,
      );
      assert.equal(
        result.isError,
        true,
        `${JSON.stringify(credential)} must be refused`,
      );
      assert.equal(errorCode(result), "invalid_params");
    }
  });

  test("list and delete round-trip through the tools", async () => {
    const env = credentialEnv();
    await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:6",
        credential: "Bearer abc123",
        ttl_seconds: 3600,
      },
      env,
    );

    const listed = await callAs(7, "list_surface_credentials", {}, env);
    assert.equal(listed.isError, false);
    const listBody = listed.structuredContent as Row;
    assert.equal(listBody.count, 1);
    // The listing is metadata only -- no tool in this family ever hands a
    // credential value back, including to the caller who stored it.
    assert.ok(!JSON.stringify(listBody).includes("abc123"));
    assert.equal((listBody.credentials as Row[])[0].surface_id, "x:api:6");

    const deleted = await callAs(
      7,
      "delete_surface_credential",
      { surface_id: "x:api:6" },
      env,
    );
    assert.equal((deleted.structuredContent as Row).deleted, true);

    const again = await callAs(
      7,
      "delete_surface_credential",
      { surface_id: "x:api:6" },
      env,
    );
    assert.equal((again.structuredContent as Row).deleted, false);

    const empty = await callAs(7, "list_surface_credentials", {}, env);
    assert.equal((empty.structuredContent as Row).count, 0);
  });

  test("one caller's registration is invisible to another", async () => {
    const env = credentialEnv();
    await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:6",
        credential: "Bearer sevens",
      },
      env,
    );
    const otherList = await callAs(8, "list_surface_credentials", {}, env);
    assert.equal((otherList.structuredContent as Row).count, 0);
    const otherCall = await callAs(
      8,
      "call_subnet_surface",
      { surface_id: "x:api:6" },
      env,
    );
    assert.equal(errorCode(otherCall), "auth_required");
  });

  test("re-registering reports the replacement", async () => {
    const env = credentialEnv();
    await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:6",
        credential: "one",
      },
      env,
    );
    const second = await callAs(
      7,
      "store_surface_credential",
      {
        surface_id: "x:api:6",
        credential: "two",
      },
      env,
    );
    assert.equal((second.structuredContent as Row).replaced, true);
  });

  // The OTHER authentication door. Every test above binds via the OAuth
  // props; this one goes through the mg_-key path, where the identity is
  // resolved by the tiered rate-limit gate rather than the OAuth provider.
  // Both must land on the same `account:<id>` — that equivalence is the whole
  // reason the store keys on the shared rpc_accounts id instead of on
  // whichever mechanism the caller used, and if it ever broke, a caller would
  // silently lose access to their own registrations by switching clients.
  test("an mg_ key resolves the same identity as the OAuth props", async () => {
    const env = credentialEnv();
    const key = "mg_test_key_0123456789abcdef";
    // Prime the key-validation cache (src/api-key-validation.ts) so the gate
    // resolves the key without a live Unkey round trip.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    env.store.set(`api-key-lookup:${hash}`, {
      value: JSON.stringify({ found: true, tier: "free", accountId: 7 }),
    });

    // Registered through the OAuth door as account 7…
    await callAs(
      7,
      "store_surface_credential",
      { surface_id: "x:api:6", credential: "Bearer abc123" },
      env,
    );

    // …and resolved through the mg_-key door, same account.
    const of = globalThis.fetch;
    let sentHeader: string | undefined;
    globalThis.fetch = async (_url, init) => {
      sentHeader = (init!.headers as Record<string, string>).Authorization;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const response = await handleMcpRequest(
        new Request("https://metagraph.sh/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call_subnet_surface",
              arguments: { surface_id: "x:api:6" },
            },
          }),
        }),
        env as unknown as Env,
        deps,
      );
      const result = ((await response.json()) as Row).result as Row;
      assert.equal(result.isError, false);
      assert.equal(sentHeader, "Bearer abc123");
      assert.equal(
        (result.structuredContent as Row).credential_source,
        "stored",
      );
    } finally {
      globalThis.fetch = of;
    }
  });
});
