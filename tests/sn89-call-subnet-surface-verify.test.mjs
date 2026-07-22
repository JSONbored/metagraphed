// SN89 (InfiniteHash) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7101, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN89's *real* no-auth GET JSON
// registry surfaces (registry/subnets/infinitehash.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-89-taomarketcap-subnet-api       GET https://api.taomarketcap.com/public/v1/subnets/89/
//     -> TaoMarketCap subnet snapshot JSON (netuid 89)
//   sn-89-infinitehash-runtime-version  GET raw.githubusercontent.com/.../runtime_version_318.json
//     -> {"specName":"node-subtensor","specVersion":318,...}
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 89;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/infinitehash.json", import.meta.url),
    ),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-89-taomarketcap-subnet-api",
    kind: "subnet-api",
    url: "https://api.taomarketcap.com/public/v1/subnets/89/",
    body: {
      id: "89",
      netuid: 89,
      is_active: true,
      latest_snapshot: { id: "8667000-89", netuid: 89 },
    },
    assertBody: (b) => {
      assert.equal(b.netuid, 89);
      assert.equal(b.latest_snapshot.netuid, 89);
    },
  },
  {
    id: "sn-89-infinitehash-runtime-version",
    kind: "data-artifact",
    url: "https://raw.githubusercontent.com/backend-developers-ltd/InfiniteHash/b0313ed2edc8c07c8312effb108e9cadd580e314/app/src/infinite_hashes/testutils/simulator/runtime_version_318.json",
    body: {
      specName: "node-subtensor",
      implName: "node-subtensor",
      authoringVersion: 1,
      specVersion: 318,
      implVersion: 1,
      apis: [],
    },
    assertBody: (b) => {
      assert.equal(b.specName, "node-subtensor");
      assert.equal(b.specVersion, 318);
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

describe("SN89 InfiniteHash call_subnet_surface verification (#7101)", () => {
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
