// SN78 (Vocence) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7091, MCP execute Phase 1 follow-up #7014/#7215). Pins SN78's
// *real* registry surfaces (registry/subnets/vocence.json) to the tool's
// contract so a future edit that regresses their callability is caught here.
//
// Live-verified 2026-07-21:
//   - sn-78-vocence-subnet-api GET https://api.vocence.ai/health
//     -> 200 application/json {"status":"ok","service":"vocence-developer-api"}
//   - sn-78-vocence-openapi GET https://api.vocence.ai/openapi.json
//     -> 200 application/json OpenAPI 3.1.0 (title: Vocence Developer API)
//
// openapi is not in OPERATIONAL_SURFACE_KINDS, so it is direct-call verified
// only. Auth-gated developer-API routes from the issue addendum stay out of
// scope (401 without a bearer token).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 78;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/vocence.json", import.meta.url)),
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
    id: "sn-78-vocence-subnet-api",
    kind: "subnet-api",
    operational: true,
    url: "https://api.vocence.ai/health",
    hasProbe: true,
    hasSchema: false,
    body: { status: "ok", service: "vocence-developer-api" },
    assertShape: (body) => {
      assert.equal(body.status, "ok");
      assert.equal(typeof body.service, "string");
    },
  },
  {
    id: "sn-78-vocence-openapi",
    kind: "openapi",
    operational: false,
    url: "https://api.vocence.ai/openapi.json",
    hasProbe: true,
    hasSchema: true,
    body: {
      openapi: "3.1.0",
      info: { title: "Vocence Developer API", version: "0.1.0" },
      paths: {},
    },
    assertShape: (body) => {
      assert.equal(typeof body.openapi, "string");
      assert.equal(typeof body.info, "object");
    },
  },
];

for (const spec of SURFACES) {
  describe(`SN78 Vocence ${spec.id} call_subnet_surface verification (#7091)`, () => {
    const SURFACE = surfaceById(spec.id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${spec.id} is present`);
      assert.equal(SURFACE.kind, spec.kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.url, spec.url);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
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
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
