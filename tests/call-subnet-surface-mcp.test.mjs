// MCP-level tests for the call_subnet_surface tool (metagraphed#7014, MCP
// execute Phase 1). Mirrors tests/surface-verify.test.mjs's
// verify_integration MCP-tool describe block: same catalog fixture shape,
// same fetch-mock-with-try/finally-restore pattern, same DNS-rebinding-mock
// approach for the SSRF guard. src/call-subnet-surface.mjs's own unit tests
// (tests/call-subnet-surface.test.mjs) exhaustively cover the fetch/
// redirect/body-capping logic in isolation; this file only proves the tool
// wiring (surface resolution, auth_required/probe.enabled gating, arg
// validation, error-code mapping) end-to-end through the real JSON-RPC path.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.mjs";

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
    },
  },
};

const CATALOG = {
  surfaces: [
    NO_AUTH_SURFACE,
    AUTH_SURFACE,
    DISABLED_PROBE_SURFACE,
    SCHEMA_SURFACE,
    NO_SCHEMA_SURFACE,
    SELF_SCHEMA_SURFACE,
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

    test("a method other than GET/HEAD is invalid_params", async () => {
      const result = await callTool({
        surface_id: "x:api:4",
        path: "/users/123",
        method: "POST",
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
});
