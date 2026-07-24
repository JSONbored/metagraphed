// SN75 (Hippius) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7088, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN75's *real* registry surface configs
// (registry/subnets/hippius.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking one
// auth_required, disabling a probe) is caught here.
//
// All four surfaces listed in #7088 were verified live on 2026-07-21 against
// their exact catalogued URLs:
//   sn-75-hippius-openapi
//     GET https://api.hippius.com/swagger.json
//     -> HTTP 200 application/json, Swagger 2.0 object
//        (swagger, info, host, schemes, paths, ...), ~164 KB
//   sn-75-hippius-models-subnet-api
//     GET https://api.hippius.com/api/models/
//     -> HTTP 200 application/json
//        {page, page_size, total, results:[{project, repo, digest, ...}, ...]}
//   sn-75-hippius-health
//     GET https://api.hippius.com/api/registry/health/
//     -> HTTP 200 application/json {"ok":true,"latency_ms":...}
//   sn-75-hippius-storage-control-health
//     GET https://api.hippius.com/api/storage-control/health/
//     -> HTTP 200 application/json {"status":"ok"}
// The fixtures below mirror each live response's shape rather than fetching
// it, keeping the test hermetic while still exercising the JSON
// parse-and-return path. (Model lists and latency_ms are live data, so the
// tests assert the stable shape, not exact contents.)
//
// Note on sn-75-hippius-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.ts), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7088, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only --
// no MCP-tool-path test fakes a catalog entry production does not have.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 75;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/hippius.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceOf(id: string) {
  return registry.surfaces.find((surface: Row) => surface.id === id);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callToolWithSurface(surface: Row, body: unknown) {
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
    // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 0 }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    return jsonResponse(body);
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
            arguments: { surface_id: surface.id },
          },
        }),
      }),
      mockEnv(),
      deps,
    );
    return ((await response.json()) as Row).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The three subnet-api surfaces that ARE in the operational catalog.
const CALLABLE_SURFACES = [
  {
    id: "sn-75-hippius-models-subnet-api",
    url: "https://api.hippius.com/api/models/",
    body: {
      page: 1,
      page_size: 25,
      total: 6505,
      results: [
        {
          project: "cascade",
          repo: "ckpt-example",
          digest: "sha256:abc",
        },
      ],
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.page, "number");
      assert.equal(typeof b.total, "number");
      assert.ok(Array.isArray(b.results));
      assert.equal(typeof b.results[0].project, "string");
      assert.equal(typeof b.results[0].digest, "string");
    },
  },
  {
    id: "sn-75-hippius-health",
    url: "https://api.hippius.com/api/registry/health/",
    body: { ok: true, latency_ms: 133 },
    assertBody: (b: Row) => {
      assert.equal(b.ok, true);
      assert.equal(typeof b.latency_ms, "number");
    },
  },
  {
    id: "sn-75-hippius-storage-control-health",
    url: "https://api.hippius.com/api/storage-control/health/",
    body: { status: "ok" },
    assertBody: (b: Row) => {
      assert.equal(b.status, "ok");
    },
  },
];

describe("SN75 Hippius call_subnet_surface verification (#7088)", () => {
  for (const fixture of CALLABLE_SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface exists and is configured to be callable`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // No-auth GET returning JSON.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, fixture.url);
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body using the surface's own url + GET`, async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return jsonResponse(fixture.body);
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body as Row);
    });

    test(`${fixture.id}: end-to-end through the call_subnet_surface MCP tool, resolved by surface id`, async () => {
      const result = await callToolWithSurface(SURFACE, fixture.body);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, fixture.id);
      assert.equal(result.structuredContent.status_code, 200);
      fixture.assertBody(result.structuredContent.body as Row);
    });
  }

  describe("sn-75-hippius-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-75-hippius-openapi");
    // Faithful subset of the live swagger.json response's top-level shape.
    // Live host serves Swagger 2.0 (not OpenAPI 3.x).
    const BODY = {
      swagger: "2.0",
      info: { title: "Hippius API" },
      host: "api.hippius.com",
      paths: {
        "/api/registry/health/": {
          get: { operationId: "api_registry_health_retrieve" },
        },
      },
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-75-hippius-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.url, "https://api.hippius.com/swagger.json");
      // #7088 says this surface has a captured schema; pin that linkage.
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://api.hippius.com/swagger.json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      // Documents WHY there is no MCP-tool-path test for this surface: the
      // operational catalog the tool resolves from only includes these kinds.
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the Swagger 2.0 document as parsed JSON", async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return jsonResponse(BODY);
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.truncated, false);
      assert.equal((result.body as Row).swagger, "2.0");
      assert.equal((result.body as Row).info.title, "Hippius API");
      assert.equal(
        (result.body as Row).paths["/api/registry/health/"].get.operationId,
        "api_registry_health_retrieve",
      );
    });
  });
});
