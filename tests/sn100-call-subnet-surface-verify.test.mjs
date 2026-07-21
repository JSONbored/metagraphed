// SN100 (Plaτform) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7112, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN100's *real* registry surface config
// (registry/subnets/pla-form.json) to the tool's contract, so a future edit that
// regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth Plaτform challenge registry API
// (sn-100-platform-network-subnet-api, GET https://chain.joinbase.ai/v1/registry,
// JSON, single fixed endpoint -- no schema). Live-verified 2026-07-21 to return
// HTTP 200 application/json { network: "base", api_version: "1.0", master_uid: 0,
// challenges: [...] }. The fixture below mirrors that live response rather than
// fetching it, keeping the test hermetic while still exercising the JSON
// parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-100-platform-network-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/pla-form.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

// A faithful subset of the live https://chain.joinbase.ai/v1/registry response body.
const BODY = {
  network: "base",
  api_version: "1.0",
  master_uid: 0,
  challenges: [
    {
      slug: "agent-challenge",
      name: "Agent Challenge",
      status: "active",
    },
  ],
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN100 Plaτform call_subnet_surface verification (#7112)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    // No-auth GET returning JSON.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://chain.joinbase.ai/v1/registry");
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return upstreamResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal(result.body.network, "base");
    assert.equal(result.body.api_version, "1.0");
    assert.ok(Array.isArray(result.body.challenges));
    assert.equal(result.body.challenges[0].slug, "agent-challenge");
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 100 }],
    };
    const deps = {
      readArtifact: async (_env, path) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return upstreamResponse();
    };
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
              arguments: { surface_id: SURFACE_ID },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.network, "base");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
