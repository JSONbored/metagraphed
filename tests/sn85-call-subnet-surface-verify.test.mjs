// SN85 (Vidaio) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7098, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN85's three *real* registry surfaces
// (registry/subnets/vidaio.json) to the tool's contract, so a future edit that
// regresses their callability is caught here.
//
// All three live-verified 2026-07-21 to return HTTP 200 application/json:
//   - sn-85-vidaio-openapi GET https://api.vidaio.io/openapi.json -> OpenAPI 3.1 doc
//   - sn-85-vidaio-health  GET https://api.vidaio.io/health       -> { status: "ok" }
//   - sn-85-vidaio-ready   GET https://api.vidaio.io/ready        -> { status: "ok" }
//
// Note on sn-85-vidaio-openapi: kind "openapi" is not in OPERATIONAL_SURFACE_KINDS
// (src/health-probe-core.mjs), so that surface is absent from the real
// public/metagraph/operational-surfaces.json and cannot be resolved by
// surface_id through the MCP tool -- it is verified direct-call only (matching
// the SN74 precedent). health/ready are subnet-api (operational) and carry no
// probe block; call_subnet_surface defaults to GET when a surface has no
// probe.method, so they are callable as-is. Fixtures below mirror the live
// shapes, keeping the test hermetic (bodies are live data -> assert stable shape).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 85;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/vidaio.json", import.meta.url)),
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

const SURFACES = [
  {
    id: "sn-85-vidaio-openapi",
    kind: "openapi",
    // "openapi" is NOT in OPERATIONAL_SURFACE_KINDS -> not in the real catalog,
    // so it cannot be resolved by surface_id through the MCP tool.
    operational: false,
    url: "https://api.vidaio.io/openapi.json",
    hasProbe: true,
    hasSchema: true,
    body: {
      openapi: "3.1.0",
      info: { title: "Vidaio API", version: "1.0.0" },
      paths: {},
    },
    assertShape: (body) => {
      assert.equal(typeof body.openapi, "string");
      assert.equal(typeof body.info, "object");
    },
  },
  {
    id: "sn-85-vidaio-health",
    kind: "subnet-api",
    operational: true,
    url: "https://api.vidaio.io/health",
    hasProbe: false,
    hasSchema: false,
    body: { status: "ok" },
    assertShape: (body) => {
      assert.equal(body.status, "ok");
    },
  },
  {
    id: "sn-85-vidaio-ready",
    kind: "subnet-api",
    operational: true,
    url: "https://api.vidaio.io/ready",
    hasProbe: false,
    hasSchema: false,
    body: { status: "ok" },
    assertShape: (body) => {
      assert.equal(body.status, "ok");
    },
  },
];

for (const spec of SURFACES) {
  describe(`SN85 Vidaio ${spec.id} call_subnet_surface verification (#7098)`, () => {
    const SURFACE = surfaceById(spec.id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${spec.id} is present`);
      assert.equal(SURFACE.kind, spec.kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.url, spec.url);
      if (spec.hasProbe) {
        assert.equal(SURFACE.probe?.enabled, true);
        // A non-HEAD probe -> call_subnet_surface issues a GET.
        assert.notEqual(SURFACE.probe?.method, "HEAD");
      } else {
        // No probe block: call_subnet_surface defaults to GET (see below).
        assert.ok(!SURFACE.probe);
      }
      if (spec.hasSchema) {
        assert.equal(typeof SURFACE.schema_url, "string");
      } else {
        assert.equal(SURFACE.schema_url, undefined);
      }
    });

    test("callSubnetSurface issues a GET to the surface's own url and returns the JSON body", async () => {
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

    if (spec.operational) {
      test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        const result = await callThroughMcpTool(SURFACE, spec.body);
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, spec.id);
        assert.equal(result.structuredContent.status_code, 200);
        spec.assertShape(result.structuredContent.body);
      });
    } else {
      test("kind is not an operational kind, so this surface is direct-call verified only", () => {
        // Documents WHY there is no MCP-tool-path test for this surface: the
        // operational catalog the tool resolves surface_id from only includes
        // OPERATIONAL_SURFACE_KINDS, which excludes "openapi".
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
