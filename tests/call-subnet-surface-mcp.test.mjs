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

const CATALOG = {
  surfaces: [NO_AUTH_SURFACE, AUTH_SURFACE, DISABLED_PROBE_SURFACE],
};

const deps = {
  readArtifact: async (_e, path) => {
    if (path === "/metagraph/operational-surfaces.json") {
      return { ok: true, data: CATALOG };
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
});
