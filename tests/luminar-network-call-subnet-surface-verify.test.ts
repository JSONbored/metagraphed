// SN87 (Luminar Network) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7099, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN87's real registry surfaces
// (registry/subnets/luminar-network.json) to the tool's contract, so a future
// edit that regresses their callability is caught here.
//
// Both live-verified 2026-07-21:
//   - sn-87-luminar-health  GET https://luminar.network/healthz -> HTTP 200
//     text/plain body "ok". kind "subnet-api" is operational, and the surface
//     carries no probe block, so call_subnet_surface defaults to GET and the
//     surface is resolvable by surface_id through the MCP tool. Because the
//     upstream serves text/plain, the tool returns the body as an unparsed
//     string rather than a parsed object.
//   - sn-87-luminar-website HEAD https://luminar.network/ -> HTTP 200 text/html.
//     kind "website" is NOT in OPERATIONAL_SURFACE_KINDS, so it is absent from
//     the real operational-surfaces.json and verified direct-call only (matching
//     the SN85 openapi precedent). Its probe.method is HEAD, so the tool issues
//     a HEAD request and returns an empty body.
// Fixtures below mirror the live responses, keeping the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 87;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/luminar-network.json", import.meta.url),
    ),
    "utf8",
  ),
);
const surfaceById = (id: string) =>
  registry.surfaces.find((s: Row) => s.id === id);

function upstreamResponse(spec: Row) {
  return new Response(spec.method === "HEAD" ? null : spec.rawBody, {
    status: 200,
    headers: { "content-type": spec.contentType },
  });
}

async function callThroughMcpTool(surface: Row, spec: Row) {
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
    return upstreamResponse(spec);
  }) as typeof fetch;
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
      mockEnv(),
      deps,
    );
    return ((await httpResponse.json()) as Row).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const SURFACES = [
  {
    id: "sn-87-luminar-health",
    kind: "subnet-api",
    operational: true,
    url: "https://luminar.network/healthz",
    method: "GET",
    hasProbe: false,
    contentType: "text/plain",
    rawBody: "ok",
    expectedBody: "ok",
  },
  {
    id: "sn-87-luminar-website",
    kind: "website",
    operational: false,
    url: "https://luminar.network/",
    method: "HEAD",
    hasProbe: true,
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN87 Luminar Network ${spec.id} call_subnet_surface verification (#7099)`, () => {
    const SURFACE = surfaceById(spec.id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${spec.id} is present`);
      assert.equal(SURFACE.kind, spec.kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.url, spec.url);
      assert.equal(SURFACE.schema_url, undefined);
      if (spec.hasProbe) {
        assert.equal(SURFACE.probe?.enabled, true);
        assert.equal(SURFACE.probe?.method, spec.method);
      } else {
        // No probe block: call_subnet_surface defaults to GET.
        assert.ok(!SURFACE.probe);
      }
    });

    test(`callSubnetSurface issues a ${spec.method} to the surface's own url and returns the body`, async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return upstreamResponse(spec);
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, spec.method);
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, spec.contentType);
      assert.equal(result.truncated, false);
      // Non-JSON content-type -> body returned as an unparsed string.
      assert.equal(typeof result.body, "string");
      assert.equal(result.body, spec.expectedBody);
    });

    if (spec.operational) {
      test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        const result = await callThroughMcpTool(SURFACE, spec);
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, spec.id);
        assert.equal(result.structuredContent.status_code, 200);
        assert.equal(result.structuredContent.body, spec.expectedBody);
      });
    } else {
      test("kind is not an operational kind, so this surface is direct-call verified only", () => {
        // Documents WHY there is no MCP-tool-path test for this surface: the
        // operational catalog the tool resolves surface_id from only includes
        // OPERATIONAL_SURFACE_KINDS, which excludes "website".
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
