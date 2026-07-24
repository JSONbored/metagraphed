// SN77 (Liquidity) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7090, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN77's *real* no-auth GET JSON
// registry surfaces (registry/subnets/liquidity.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-77-liquidity-subnet-api  GET https://77.creativebuilds.io/pools
//     -> {"success":true,"pools":[{address,totalWeight,voters,...},...]}
//   sn-77-liquidity-weights     GET https://77.creativebuilds.io/weights
//     -> {"success":true,"weights":{<ss58>:<number>,...}}
// Additional /allVotes /allHolders endpoints are live but omitted here to
// keep this verify file focused on the primary pools + weights pair.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 77;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/liquidity.json", import.meta.url),
    ),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-77-liquidity-subnet-api",
    kind: "subnet-api",
    url: "https://77.creativebuilds.io/pools",
    body: {
      success: true,
      pools: [
        {
          address: "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc",
          totalWeight: 8009.747977122886,
          voters: [
            {
              address: "5GxxsUeYRyJSJKCuPeG1jZZiCummHJttmTNsfgDRSfxVnhGi",
              weight: 7958.9,
            },
          ],
        },
      ],
    },
    assertBody: (b: Row) => {
      assert.equal(b.success, true);
      assert.ok(Array.isArray(b.pools));
      assert.equal(
        b.pools[0].address,
        "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc",
      );
    },
  },
  {
    id: "sn-77-liquidity-weights",
    kind: "data-artifact",
    url: "https://77.creativebuilds.io/weights",
    body: {
      success: true,
      weights: {
        "5HTCrP74fixyUg9nyrJ5CUzY7goNQ8NGs38BbY6F3owYnPEN": 1.8483249844423514e-8,
      },
      cached: true,
    },
    assertBody: (b: Row) => {
      assert.equal(b.success, true);
      assert.ok(typeof b.weights === "object");
      assert.ok(
        Object.prototype.hasOwnProperty.call(
          b.weights,
          "5HTCrP74fixyUg9nyrJ5CUzY7goNQ8NGs38BbY6F3owYnPEN",
        ),
      );
    },
  },
];

function surfaceOf(id: string) {
  return registry.surfaces.find((surface: Row) => surface.id === id);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN77 Liquidity call_subnet_surface verification (#7090)", () => {
  for (const fixture of SURFACES) {
    test(`${fixture.id}: registry surface is callable`, () => {
      const surface = surfaceOf(fixture.id)!;
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
      const surface = surfaceOf(fixture.id)!;
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return jsonResponse(fixture.body);
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body as Row);
    });

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const surface = surfaceOf(fixture.id)!;
      const catalog = {
        surfaces: [{ ...surface, surface_id: surface.id, netuid: NETUID }],
      };
      const deps = {
        readArtifact: async (_env: Row, path: string) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        return jsonResponse(fixture.body);
      }) as typeof fetch;
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
          mockEnv(),
          deps,
        );
        const result = ((await response.json()) as Row).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, fixture.id);
        assert.equal(result.structuredContent.status_code, 200);
        fixture.assertBody(result.structuredContent.body as Row);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
