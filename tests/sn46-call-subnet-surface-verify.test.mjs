// SN46 (Zipcode) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7060, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN46's *real* registry surface configs
// (registry/subnets/zipcode.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Live-verified 2026-07-21 (direct GET to the catalogued URLs):
//   sn-46-zipcode-openapi
//     GET https://zipcode.ai/openapi.json
//     -> HTTP 200 application/json (~71 KB) OpenAPI 3.0.0
//        info.title "Zip Code Portal API"
//   sn-46-zipcode-dashboard-openapi
//     GET https://zipcode.ai/api/dashboard/docs
//     -> HTTP 200 application/json (~3 KB) OpenAPI 3.0.0
//        info.title "RESI Subnet 46 API"
//   sn-46-zipcode-subnet-api
//     GET https://zipcode.ai/api/dashboard/stats
//     -> HTTP 200 {"stats":{totalModels, topScore, dailyTaoEmissions, ...}}
//   sn-46-zipcode-emissions-api
//     GET https://zipcode.ai/api/dashboard/stats/emissions
//     -> HTTP 200 {"dailyEmissions":127.5,"subnet":46,"blockHeight":...}
// Registry already matched reality -- no registry edit needed.
//
// Note on the two openapi surfaces: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs), so those surfaces are
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7060, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so they are pinned here at the callSubnetSurface module level only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 46;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/zipcode.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callToolWithSurface(surface, body) {
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
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 0 }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    return jsonResponse(body);
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

const CALLABLE_SURFACES = [
  {
    id: "sn-46-zipcode-subnet-api",
    url: "https://zipcode.ai/api/dashboard/stats",
    body: {
      stats: {
        totalModels: 1513,
        topScore: 0.8833657291930344,
        dailyTaoEmissions: 12.569092949,
        taoPriceUsd: 196.64,
      },
    },
    assertBody: (b) => {
      assert.equal(typeof b.stats, "object");
      assert.equal(typeof b.stats.totalModels, "number");
      assert.equal(typeof b.stats.topScore, "number");
      assert.equal(typeof b.stats.dailyTaoEmissions, "number");
    },
  },
  {
    id: "sn-46-zipcode-emissions-api",
    url: "https://zipcode.ai/api/dashboard/stats/emissions",
    body: { dailyEmissions: 127.5, subnet: 46, blockHeight: 4523680 },
    assertBody: (b) => {
      assert.equal(typeof b.dailyEmissions, "number");
      assert.equal(b.subnet, 46);
      assert.equal(typeof b.blockHeight, "number");
    },
  },
];

describe("SN46 Zipcode call_subnet_surface verification (#7060)", () => {
  for (const fixture of CALLABLE_SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface is callable`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, fixture.url);
      assert.equal(SURFACE.schema_url, undefined);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body`, async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(fixture.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body);
    });

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const result = await callToolWithSurface(SURFACE, fixture.body);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, fixture.id);
      assert.equal(result.structuredContent.status_code, 200);
      fixture.assertBody(result.structuredContent.body);
    });
  }

  describe("openapi surfaces (direct-call only)", () => {
    test('kind "openapi" is not an operational kind', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    const OPENAPI_SURFACES = [
      {
        id: "sn-46-zipcode-openapi",
        url: "https://zipcode.ai/openapi.json",
        schemaUrl: "https://zipcode.ai/openapi.json",
        body: {
          openapi: "3.0.0",
          info: { title: "Zip Code Portal API", version: "1.0.0" },
          paths: {
            "/api/dashboard/docs": {
              get: { summary: "Dashboard OpenAPI docs" },
            },
          },
        },
        assertBody: (b) => {
          assert.equal(b.openapi, "3.0.0");
          assert.equal(b.info.title, "Zip Code Portal API");
          assert.ok(b.paths["/api/dashboard/docs"]?.get);
        },
      },
      {
        id: "sn-46-zipcode-dashboard-openapi",
        url: "https://zipcode.ai/api/dashboard/docs",
        schemaUrl: "https://zipcode.ai/api/dashboard/docs",
        body: {
          openapi: "3.0.0",
          info: { title: "RESI Subnet 46 API", version: "1.0.0" },
          paths: {},
        },
        assertBody: (b) => {
          assert.equal(b.openapi, "3.0.0");
          assert.equal(b.info.title, "RESI Subnet 46 API");
          assert.equal(typeof b.paths, "object");
        },
      },
    ];

    for (const fixture of OPENAPI_SURFACES) {
      const SURFACE = surfaceOf(fixture.id);

      test(`${fixture.id}: registry surface exists, is no-auth GET, carries schema`, () => {
        assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
        assert.equal(SURFACE.kind, "openapi");
        assert.equal(SURFACE.auth_required, false);
        assert.equal(SURFACE.probe?.enabled, true);
        assert.equal(SURFACE.probe?.method, "GET");
        assert.equal(SURFACE.probe?.expect, "json");
        assert.equal(SURFACE.url, fixture.url);
        assert.equal(SURFACE.schema_status, "machine-readable");
        assert.equal(SURFACE.schema_url, fixture.schemaUrl);
      });

      test(`${fixture.id}: callSubnetSurface returns the OpenAPI document as parsed JSON`, async () => {
        let requestedUrl;
        let requestedMethod;
        const result = await callSubnetSurface(SURFACE, {
          isUnsafeUrl: async () => false,
          fetchImpl: async (url, init) => {
            requestedUrl = String(url);
            requestedMethod = init.method;
            return jsonResponse(fixture.body);
          },
        });
        assert.equal(result.ok, true);
        assert.equal(requestedUrl, SURFACE.url);
        assert.equal(requestedMethod, "GET");
        assert.equal(result.status_code, 200);
        assert.equal(result.truncated, false);
        fixture.assertBody(result.body);
      });
    }
  });
});
