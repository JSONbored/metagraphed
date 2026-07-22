// SN43 (Graphite) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7057, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN43's four *real* registry surfaces
// (registry/subnets/graphite.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking one auth_required,
// disabling a probe, moving a URL) is caught here.
//
// All four live-verified 2026-07-22 to return HTTP 200 application/json:
//   - sn-43-graphite-ai-openapi     GET .../openapi.json           -> OpenAPI 3.1 doc
//   - sn-43-graphite-ai-subnet-api  GET .../api/v1/stats/subnet     -> { netuid: 43, ... }
//   - sn-43-graphite-health         GET .../health                 -> { status: "ok", ... }
//   - sn-43-graphite-miners-stats-api GET .../api/v1/miners/stats   -> { miners: [ ... ] }
//
// Note on sn-43-graphite-ai-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs), so that surface is
// absent from the real public/metagraph/operational-surfaces.json and cannot be
// resolved by surface_id through the MCP tool -- it is verified direct-call only
// (matching the SN74/SN85 precedent). The three subnet-api surfaces are
// operational and callable as-is. Fixtures below mirror the live response shapes
// rather than fetching them, keeping the test hermetic (the bodies are live
// data, so the test asserts the stable shape, not exact contents).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 43;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/graphite.json", import.meta.url),
    ),
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
    id: "sn-43-graphite-ai-openapi",
    kind: "openapi",
    // "openapi" is NOT in OPERATIONAL_SURFACE_KINDS -> not in the real catalog,
    // so it cannot be resolved by surface_id through the MCP tool.
    operational: false,
    url: "https://api.graphite-ai.net/openapi.json",
    hasProbe: true,
    hasSchema: true,
    body: {
      openapi: "3.1.0",
      info: { title: "SN43 Knowledge Graph API", version: "1.0.0" },
      paths: {},
    },
    assertShape: (body) => {
      assert.equal(typeof body.openapi, "string");
      assert.equal(typeof body.info, "object");
    },
  },
  {
    id: "sn-43-graphite-ai-subnet-api",
    kind: "subnet-api",
    operational: true,
    url: "https://api.graphite-ai.net/api/v1/stats/subnet",
    hasProbe: true,
    hasSchema: false,
    body: {
      netuid: 43,
      total_registered: 256,
      validators: 9,
      miners: 247,
      total_alpha_stake: 2132732.26843118,
      updated_at: 1784728394.5407817,
      available: true,
    },
    assertShape: (body) => {
      assert.equal(body.netuid, 43);
      assert.equal(typeof body.total_registered, "number");
      assert.equal(typeof body.available, "boolean");
    },
  },
  {
    id: "sn-43-graphite-health",
    kind: "subnet-api",
    operational: true,
    url: "https://api.graphite-ai.net/health",
    hasProbe: true,
    hasSchema: false,
    body: {
      status: "ok",
      entities: 195790,
      relationships: 211450,
      facts: 1135910,
    },
    assertShape: (body) => {
      assert.equal(body.status, "ok");
      assert.equal(typeof body.entities, "number");
    },
  },
  {
    id: "sn-43-graphite-miners-stats-api",
    kind: "subnet-api",
    operational: true,
    url: "https://api.graphite-ai.net/api/v1/miners/stats",
    hasProbe: true,
    hasSchema: false,
    body: {
      miners: [
        {
          uid: 1,
          contributions: 482209,
          last_contribution_at: "2026-07-18T15:43:00.013782Z",
        },
      ],
    },
    assertShape: (body) => {
      assert.ok(Array.isArray(body.miners));
      assert.equal(typeof body.miners[0].uid, "number");
    },
  },
];

for (const spec of SURFACES) {
  describe(`SN43 Graphite ${spec.id} call_subnet_surface verification (#7057)`, () => {
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
