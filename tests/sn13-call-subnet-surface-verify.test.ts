// SN13 (Data Universe) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7029, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN13's *real* registry surface configs
// (registry/subnets/data-universe.json) to the tool's contract, so a future
// edit that regresses their callability / auth gating is caught here.
//
// Live-verified 2026-07-21 (direct request to the catalogued URLs):
//   sn-13-data-universe-openapi
//     GET https://sn13.api.macrocosmos.ai/openapi.json
//     -> HTTP 200 application/json (~10 KB) OpenAPI 3.1.0
//        info.title "Data Universe Validator API"; paths includes
//        /api/v1/health, /api/v1/query_bucket/{source}, ...
//   sn-13-macrocosmos-subnet-api
//     GET/POST https://constellation.api.cloud.macrocosmos.ai/sn13.v1.Sn13Service/OnDemandData
//       (no Bearer token)
//     -> HTTP 464 empty body -- not anonymously callable; auth_required:true
//        + bearer scheme already match reality. Phase 3 credential
//        passthrough (#7016) is explicitly out of scope for this issue.
// Registry already matched reality -- no registry edit needed.
//
// Note on sn-13-data-universe-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS, so it is pinned at the callSubnetSurface module
// level only (same pattern as SN34 BitMind / SN75 Hippius).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 13;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/data-universe.json", import.meta.url),
    ),
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

async function callToolWithSurface(
  surface: Row,
  upstreamResponse: () => Response,
) {
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
    return upstreamResponse();
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

describe("SN13 Data Universe call_subnet_surface verification (#7029)", () => {
  describe("sn-13-data-universe-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-13-data-universe-openapi");
    const BODY = {
      openapi: "3.1.0",
      info: {
        title: "Data Universe Validator API",
        description:
          "API for on-demand data queries from the Data Universe network",
        version: "1.0.0",
      },
      paths: {
        "/api/v1/health": {
          get: {
            summary: "Health",
            operationId: "health_api_v1_health_get",
            responses: { 200: { description: "Successful Response" } },
          },
        },
        "/api/v1/query_bucket/{source}": {
          get: {
            summary: "Query Bucket",
            operationId: "query_bucket_api_v1_query_bucket__source__get",
          },
        },
      },
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-13-data-universe-openapi is present",
      );
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://sn13.api.macrocosmos.ai/openapi.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(
        SURFACE.schema_url,
        "https://sn13.api.macrocosmos.ai/openapi.json",
      );
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the OpenAPI 3.1.0 document as parsed JSON", async () => {
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
      assert.equal((result.body as Row).openapi, "3.1.0");
      assert.equal(
        (result.body as Row).info.title,
        "Data Universe Validator API",
      );
      assert.ok((result.body as Row).paths["/api/v1/health"]?.get);
    });
  });

  describe("sn-13-macrocosmos-subnet-api (auth required -- Phase 3 territory)", () => {
    const SURFACE = surfaceOf("sn-13-macrocosmos-subnet-api");

    test("registry surface exists and correctly declares bearer auth", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-13-macrocosmos-subnet-api is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      // Live-confirmed: anonymous GET/POST both return HTTP 464 with an empty
      // body -- not anonymously callable. auth_required:true + bearer scheme
      // match reality; credential passthrough is Phase 3 (#7016).
      assert.equal(SURFACE.auth_required, true);
      assert.equal(SURFACE.auth?.scheme, "bearer");
      assert.equal(SURFACE.auth?.location, "header");
      assert.equal(SURFACE.auth?.name, "Authorization");
      assert.equal(
        SURFACE.url,
        "https://constellation.api.cloud.macrocosmos.ai/sn13.v1.Sn13Service/OnDemandData",
      );
    });

    test("the call_subnet_surface MCP tool rejects it outright without fetching upstream", async () => {
      let upstreamFetched = false;
      const result = await callToolWithSurface(SURFACE, () => {
        upstreamFetched = true;
        return jsonResponse({});
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /auth_required/);
      assert.equal(upstreamFetched, false);
    });
  });
});
