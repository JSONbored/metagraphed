// SN70 (NexisGen) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7083, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN70's *real* registry surface configs
// (registry/subnets/nexisgen.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking one
// auth_required, disabling a probe) is caught here.
//
// Both surfaces listed in #7083 were verified live on 2026-07-21 against their
// exact catalogued URLs. Origin was down behind Cloudflare on every attempt:
//   sn-70-nexisgen-validator-api-healthz  GET https://api.nexisgen.ai/healthz
//     -> HTTP 502 application/json; charset=utf-8 Cloudflare Bad Gateway JSON
//        ({type,title,status:502,error_code:502,error_name:"origin_bad_gateway",
//         cloudflare_error:true,retryable:true, ...})
//   sn-70-nexisgen-openapi                GET https://api.nexisgen.ai/openapi.json
//     -> same HTTP 502 Cloudflare Bad Gateway JSON body shape
// Registry already matched reality for a healthy origin (URL, GET/json probe,
// auth_required false, openapi schema linkage) -- no registry edit needed.
// The tool is a safety-checked passthrough: it returns that status + body
// rather than inventing success. Fixtures below mirror the live 502 shape
// (stable fields only; ray_id/timestamp omit) rather than fetching it.
//
// Note on sn-70-nexisgen-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.ts), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7083, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only --
// no MCP-tool-path test fakes a catalog entry production does not have.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 70;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/nexisgen.json", import.meta.url),
    ),
    "utf8",
  ),
);

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

// Faithful copy of the live Cloudflare 502 Bad Gateway JSON shape observed
// 2026-07-21 on both api.nexisgen.ai endpoints (volatile ray_id/timestamp
// omitted).
const CF_502_BODY = {
  type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/",
  title: "Error 502: Bad gateway",
  status: 502,
  error_code: 502,
  error_name: "origin_bad_gateway",
  cloudflare_error: true,
  retryable: true,
};
const STATUS = 502;
const CONTENT_TYPE = "application/json; charset=utf-8";

function upstreamResponse() {
  return new Response(JSON.stringify(CF_502_BODY), {
    status: STATUS,
    headers: { "content-type": CONTENT_TYPE },
  });
}

async function callToolWithSurface(surface) {
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

describe("SN70 NexisGen call_subnet_surface verification (#7083)", () => {
  describe("sn-70-nexisgen-validator-api-healthz", () => {
    const SURFACE = surfaceOf("sn-70-nexisgen-validator-api-healthz");

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-70-nexisgen-validator-api-healthz is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://api.nexisgen.ai/healthz");
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the live 502 JSON body using the surface's own url + GET", async () => {
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
      // Passthrough: network/fetch succeeded; HTTP 502 is surfaced as
      // status_code + parsed body, not as tool-level ok:false.
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 502);
      assert.equal(result.content_type, CONTENT_TYPE);
      assert.equal(result.truncated, false);
      assert.equal(result.body.status, 502);
      assert.equal(result.body.error_name, "origin_bad_gateway");
      assert.equal(result.body.cloudflare_error, true);
      assert.equal(result.body.retryable, true);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const result = await callToolWithSurface(SURFACE);
      assert.equal(result.isError, false);
      assert.equal(
        result.structuredContent.surface_id,
        "sn-70-nexisgen-validator-api-healthz",
      );
      assert.equal(result.structuredContent.status_code, 502);
      assert.equal(
        result.structuredContent.body.error_name,
        "origin_bad_gateway",
      );
    });
  });

  describe("sn-70-nexisgen-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-70-nexisgen-openapi");

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-70-nexisgen-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://api.nexisgen.ai/openapi.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://api.nexisgen.ai/openapi.json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the live 502 JSON body using the surface's own url + GET", async () => {
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
      assert.equal(result.status_code, 502);
      assert.equal(result.content_type, CONTENT_TYPE);
      assert.equal(result.truncated, false);
      assert.equal(result.body.title, "Error 502: Bad gateway");
      assert.equal(result.body.error_code, 502);
      assert.equal(result.body.cloudflare_error, true);
    });
  });
});
