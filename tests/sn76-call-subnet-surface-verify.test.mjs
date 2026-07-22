// SN76 (Byzantium) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7089, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN76's *real* registry surface configs
// (registry/subnets/byzantium.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Both surfaces listed in #7089 were verified live on 2026-07-21 against their
// exact catalogued URLs:
//   sn-76-byzantium-validator-weights
//     GET https://link.byzantiumai.net/api/validator/weights
//     -> HTTP 500 with empty body (consistent across GET/HEAD retries).
//     Source route.ts documents GET as the only public validator endpoint.
//     Registry has no probe block; call_subnet_surface defaults to GET, which
//     matches the documented method. The upstream 500 is a live service fault,
//     not a wrong probe.method/expect/auth_required/url in the registry.
//   sn-76-taomarketcap-subnet-api
//     GET https://api.taomarketcap.com/public/v1/subnets/76/
//     -> HTTP 200 application/json {id:"76", netuid:76, is_active, ...}
// Registry already matched reality for config -- no registry edit needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 76;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/byzantium.json", import.meta.url),
    ),
    "utf8",
  ),
);

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callToolWithSurface(surface, upstreamResponse) {
  const catalog = {
    surfaces: [{ ...surface, surface_id: surface.id, netuid: NETUID }],
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
            arguments: { surface_id: surface.id },
          },
        }),
      }),
      {},
      deps,
    );
    return (await response.json()).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("SN76 Byzantium call_subnet_surface verification (#7089)", () => {
  describe("sn-76-byzantium-validator-weights", () => {
    const SURFACE = surfaceOf("sn-76-byzantium-validator-weights");

    test("registry surface exists; no probe block so the tool defaults to GET", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-76-byzantium-validator-weights is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      // Issue listed method as "?" -- the registry has no probe block; the tool
      // defaults to GET, matching the documented route.ts GET handler.
      assert.equal(SURFACE.probe, undefined);
      assert.equal(
        SURFACE.url,
        "https://link.byzantiumai.net/api/validator/weights",
      );
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface issues GET and surfaces the live upstream 500", async () => {
      // Live host returns HTTP 500 with an empty body (verified repeatedly).
      // The tool still returns ok:true with status_code from upstream -- it is
      // a passthrough, not a health checker.
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return new Response(null, { status: 500 });
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 500);
      assert.equal(result.body, "");
      assert.equal(result.truncated, false);
    });

    test("end-to-end MCP tools/call returns the upstream 500 status_code", async () => {
      const result = await callToolWithSurface(
        SURFACE,
        () => new Response(null, { status: 500 }),
      );
      assert.equal(result.isError, false);
      assert.equal(
        result.structuredContent.surface_id,
        "sn-76-byzantium-validator-weights",
      );
      assert.equal(result.structuredContent.status_code, 500);
    });
  });

  describe("sn-76-taomarketcap-subnet-api", () => {
    const SURFACE = surfaceOf("sn-76-taomarketcap-subnet-api");
    // Faithful subset of the live /public/v1/subnets/76/ response body.
    const BODY = {
      id: "76",
      netuid: 76,
      is_active: true,
      latest_snapshot: { id: "8668736-76", netuid: 76 },
    };

    test("registry surface exists and is configured to be callable", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-76-taomarketcap-subnet-api is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(
        SURFACE.url,
        "https://api.taomarketcap.com/public/v1/subnets/76/",
      );
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
          return jsonResponse(BODY);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assert.equal(result.body.id, "76");
      assert.equal(result.body.netuid, 76);
      assert.equal(typeof result.body.is_active, "boolean");
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const result = await callToolWithSurface(SURFACE, () =>
        jsonResponse(BODY),
      );
      assert.equal(result.isError, false);
      assert.equal(
        result.structuredContent.surface_id,
        "sn-76-taomarketcap-subnet-api",
      );
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.netuid, 76);
    });
  });
});
