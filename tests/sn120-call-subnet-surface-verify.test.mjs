// SN120 (Affine) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7129, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN120's four *real* registry surfaces
// (registry/subnets/affine.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking one auth_required,
// disabling a probe, moving a URL) is caught here.
//
// All four live-verified 2026-07-21 to return HTTP 200 application/json:
//   - sn-120-affine-openapi              GET .../openapi.json    -> OpenAPI 3.1 doc
//   - sn-120-affine-health               GET .../api/v1/health   -> { status: "ok", ... }
//   - sn-120-affine-scores-latest        GET .../scores/latest   -> { block_number, scores: [ ... ] }
//   - sn-120-affine-scores-weights-latest GET .../scores/weights/latest -> { block_number, weights: { ... } }
// Fixtures below mirror those live response shapes rather than fetching them,
// keeping the test hermetic (the bodies are live data, so the test asserts the
// stable shape, not exact contents).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 120;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/affine.json", import.meta.url)),
    "utf8",
  ),
);
const surfaceById = (id) => registry.surfaces.find((s) => s.id === id);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callThroughMcpTool(surface, body) {
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
    const httpResponse = await handleMcpRequest(
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
    return (await httpResponse.json()).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The four callable surfaces #7129 lists, with the kind/schema each is
// configured as and a faithful subset of its live 200 JSON body.
const SURFACES = [
  {
    id: "sn-120-affine-openapi",
    kind: "openapi",
    url: "https://api.affine.io/openapi.json",
    hasSchema: true,
    body: {
      openapi: "3.1.0",
      info: { title: "Affine API", version: "1.0.0" },
      paths: {},
    },
    assertShape: (body) => {
      assert.equal(typeof body.openapi, "string");
      assert.equal(typeof body.info, "object");
    },
  },
  {
    id: "sn-120-affine-health",
    kind: "subnet-api",
    url: "https://api.affine.io/api/v1/health",
    hasSchema: false,
    body: { status: "ok", service: "affine-api" },
    assertShape: (body) => {
      assert.equal(body.status, "ok");
    },
  },
  {
    id: "sn-120-affine-scores-latest",
    kind: "subnet-api",
    url: "https://api.affine.io/api/v1/scores/latest",
    hasSchema: false,
    body: {
      block_number: 8629773,
      calculated_at: 1784153229,
      scores: [{ uid: 96, miner_hotkey: "5ECe" }],
    },
    assertShape: (body) => {
      assert.equal(typeof body.block_number, "number");
      assert.ok(Array.isArray(body.scores));
    },
  },
  {
    id: "sn-120-affine-scores-weights-latest",
    kind: "subnet-api",
    url: "https://api.affine.io/api/v1/scores/weights/latest",
    hasSchema: false,
    body: {
      block_number: 8629773,
      config: { window_id: 8629773 },
      weights: { 96: { weight: 0.2 } },
    },
    assertShape: (body) => {
      assert.equal(typeof body.block_number, "number");
      assert.equal(typeof body.weights, "object");
    },
  },
];

for (const spec of SURFACES) {
  describe(`SN120 Affine ${spec.id} call_subnet_surface verification (#7129)`, () => {
    const SURFACE = surfaceById(spec.id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${spec.id} is present`);
      assert.equal(SURFACE.kind, spec.kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, spec.url);
      if (spec.hasSchema) {
        assert.equal(typeof SURFACE.schema_url, "string");
      } else {
        assert.equal(SURFACE.schema_url, undefined);
      }
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(spec.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      spec.assertShape(result.body);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const result = await callThroughMcpTool(SURFACE, spec.body);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, spec.id);
      assert.equal(result.structuredContent.status_code, 200);
      spec.assertShape(result.structuredContent.body);
    });
  });
}
