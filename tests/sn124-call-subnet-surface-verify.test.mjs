// SN124 (Swarm) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7132, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN124's *real* no-auth GET JSON
// registry surfaces (registry/subnets/swarm.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-124-swarm-health          GET https://api.swarm124.com/health
//     -> {"status":"healthy"}
//   sn-124-swarm-leaderboard-api GET https://api.swarm124.com/leaderboard
//     -> {"entries":[{rank,model_id,uid,family_id,...},...]}
// kings/diagnostics returns 422 without lineage_id (not verified working);
// kings/active and min_compute are omitted here to keep this verify focused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 124;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/swarm.json", import.meta.url)),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-124-swarm-health",
    kind: "subnet-api",
    url: "https://api.swarm124.com/health",
    body: { status: "healthy" },
    assertBody: (b) => {
      assert.equal(b.status, "healthy");
    },
  },
  {
    id: "sn-124-swarm-leaderboard-api",
    kind: "subnet-api",
    url: "https://api.swarm124.com/leaderboard",
    body: {
      entries: [
        {
          rank: 1,
          model_id: 707,
          uid: 190,
          family_id: "cf_interceptor",
        },
      ],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.entries));
      assert.equal(b.entries[0].rank, 1);
      assert.equal(b.entries[0].family_id, "cf_interceptor");
    },
  },
];

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN124 Swarm call_subnet_surface verification (#7132)", () => {
  for (const fixture of SURFACES) {
    test(`${fixture.id}: registry surface is callable`, () => {
      const surface = surfaceOf(fixture.id);
      assert.ok(surface, `registry surface ${fixture.id} is present`);
      assert.equal(surface.kind, fixture.kind);
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      assert.equal(surface.url, fixture.url);
      assert.equal(surface.schema_url, undefined);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body`, async () => {
      const surface = surfaceOf(fixture.id);
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(fixture.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body);
    });

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const surface = surfaceOf(fixture.id);
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
        return jsonResponse(fixture.body);
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
                arguments: { surface_id: fixture.id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, fixture.id);
        assert.equal(result.structuredContent.status_code, 200);
        fixture.assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
