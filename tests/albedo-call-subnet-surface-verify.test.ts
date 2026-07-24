// SN97 (Albedo) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7058, MCP execute Phase 1 follow-up #7014/#7215; issue #7109).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN97's *real* registry surface
// config (registry/subnets/albedo.json) to the tool's contract, so a future
// edit that regresses either surface's callability (flipping to HEAD, marking
// it auth_required, disabling its probe, moving the url) is caught here.
//
// The two surfaces are the Albedo chat app's own no-auth GET endpoints:
//   sn-97-albedo-subnet-api  https://chat.albedo.tech/api/config
//   sn-97-albedo-health      https://chat.albedo.tech/health
// Both single fixed endpoints (no machine-readable schema). Live-verified
// 2026-07-21: /api/config returns HTTP 200 application/json app-config object
// (status, name "Albedo", version, features); /health returns HTTP 200
// application/json liveness object ({status: true}). The fixtures below mirror
// faithful subsets of those live responses rather than fetching them, keeping
// the tests hermetic while still exercising the tool's JSON parse-and-return
// path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const NETUID = 97;
const registry: Row = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/albedo.json", import.meta.url)),
    "utf8",
  ),
);
const surfaceById = (id: string) =>
  registry.surfaces.find((surface: Row) => surface.id === id);

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Clones the SN44/SN123/SN111 verification shape (metagraphed#7289/#7295/#7303)
// for one Albedo surface: pin the registry config, exercise callSubnetSurface
// directly, then resolve it end-to-end through the call_subnet_surface MCP tool
// by surface id.
function verifySurface({
  surfaceId,
  url,
  body,
  assertBody,
}: {
  surfaceId: string;
  url: string;
  body: unknown;
  assertBody: (body: Row) => void;
}) {
  const SURFACE = surfaceById(surfaceId);

  describe(`SN97 Albedo ${surfaceId} call_subnet_surface verification (#7058)`, () => {
    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${surfaceId} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // No-auth GET returning JSON.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, url);
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (fetchUrl, init) => {
          requestedUrl = String(fetchUrl);
          requestedMethod = init?.method;
          return jsonResponse(body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assertBody(result.body as Row);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
      };
      const deps = {
        readArtifact: async (_env: Row, path: string) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const requestUrl = String(input);
        if (requestUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
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
                arguments: { surface_id: surfaceId },
              },
            }),
          }),
          {} as unknown as Env,
          deps,
        );
        const result = ((await response.json()) as Row).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, surfaceId);
        assert.equal(result.structuredContent.status_code, 200);
        assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

// /api/config: the Albedo chat app config object.
verifySurface({
  surfaceId: "sn-97-albedo-subnet-api",
  url: "https://chat.albedo.tech/api/config",
  body: {
    status: true,
    name: "Albedo",
    version: "0.10.2",
    features: { auth: true },
  },
  assertBody: (responseBody) => {
    assert.equal(responseBody.status, true);
    assert.equal(typeof responseBody.name, "string");
  },
});

// /health: a liveness object.
verifySurface({
  surfaceId: "sn-97-albedo-health",
  url: "https://chat.albedo.tech/health",
  body: { status: true },
  assertBody: (responseBody) => {
    assert.equal(responseBody.status, true);
  },
});
