// SN51 (lium.io) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7064, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN51's *real* registry surface configs
// (registry/subnets/lium-io.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Live-verified 2026-07-21 (direct GET to the catalogued URLs):
//   sn-51-lium-io-openapi
//     GET https://lium.io/api/openapi.json
//     -> HTTP 200 application/json (~256 KB) OpenAPI 3.1.0
//        info.title "Lium Backend API"; live body is just over
//        MAX_RESPONSE_BYTES (262144), so a live call_subnet_surface
//        response would truncate -- fixtures below stay under the cap.
//   sn-51-lium-io-machines-api
//     GET https://lium.io/api/machines
//     -> HTTP 200 application/json array of GPU machine types (~21 KB)
//   sn-51-lium-health
//     GET https://lium.io/api/version
//     -> HTTP 200 {"started_at":"...","uptime_seconds":...}
//   sn-51-lium-reclaims-api
//     GET https://lium.io/api/reclaims
//     -> HTTP 200 application/json array (~416 KB; exceeds
//        MAX_RESPONSE_BYTES -- same truncation note as openapi)
//   sn-51-lium-machines-capacity-api
//     GET https://lium.io/api/machines/capacity
//     -> HTTP 200 array of {base_model, buckets} (~2 KB)
//   sn-51-lium-executors-count
//     GET https://lium.io/api/executors/count
//     -> HTTP 200 {"count":110}
//   sn-51-lium-executors-total-count
//     GET https://lium.io/api/executors/total-count
//     -> HTTP 200 {"total_count":369}
//   sn-51-lium-latest-set-weights
//     GET https://lium.io/api/latest-set-weights
//     -> HTTP 200 {validator_key, netuid:51, uids, weights, ...}
// Registry already matched reality -- no registry edit needed.
//
// Note on sn-51-lium-io-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.ts), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7064, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 51;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/lium-io.json", import.meta.url)),
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

const CALLABLE_SURFACES = [
  {
    id: "sn-51-lium-io-machines-api",
    url: "https://lium.io/api/machines",
    schemaUrl: "https://lium.io/api/openapi.json",
    body: [
      {
        name: "NVIDIA A30",
        price: 0.1,
        rental_rate: 0.0,
        total_gpu_count: 0,
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].name, "string");
      assert.equal(typeof b[0].price, "number");
      assert.equal(typeof b[0].total_gpu_count, "number");
    },
  },
  {
    id: "sn-51-lium-health",
    url: "https://lium.io/api/version",
    schemaUrl: "https://lium.io/api/openapi.json",
    body: {
      started_at: "2026-07-20T10:41:48.463468+00:00",
      uptime_seconds: 70500,
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.started_at, "string");
      assert.equal(typeof b.uptime_seconds, "number");
    },
  },
  {
    id: "sn-51-lium-reclaims-api",
    url: "https://lium.io/api/reclaims",
    schemaUrl: "https://lium.io/api/openapi.json",
    // Minimal fixture of the live array shape (live body is ~416 KB).
    body: [
      {
        id: "244bf52e-1273-406f-ad6f-187b803c8495",
        reclaim_id: 698,
        status: "approved",
        executor_id: "6a6e11bf-e507-4f96-9595-76050547e9f8",
        collateral_amount: 1.5,
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].id, "string");
      assert.equal(typeof b[0].reclaim_id, "number");
      assert.equal(typeof b[0].status, "string");
      assert.equal(typeof b[0].executor_id, "string");
    },
  },
  {
    id: "sn-51-lium-machines-capacity-api",
    url: "https://lium.io/api/machines/capacity",
    schemaUrl: "https://lium.io/api/openapi.json",
    body: [
      {
        base_model: "B300",
        buckets: {
          1: { max_cap: 10, unrented_count: 0, hourly_rate: 5.1 },
        },
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].base_model, "string");
      assert.equal(typeof b[0].buckets, "object");
    },
  },
  {
    id: "sn-51-lium-executors-count",
    url: "https://lium.io/api/executors/count",
    schemaUrl: undefined,
    body: { count: 110 },
    assertBody: (b: Row) => {
      assert.equal(typeof b.count, "number");
    },
  },
  {
    id: "sn-51-lium-executors-total-count",
    url: "https://lium.io/api/executors/total-count",
    schemaUrl: undefined,
    body: { total_count: 369 },
    assertBody: (b: Row) => {
      assert.equal(typeof b.total_count, "number");
    },
  },
  {
    id: "sn-51-lium-latest-set-weights",
    url: "https://lium.io/api/latest-set-weights",
    schemaUrl: undefined,
    body: {
      validator_key: "5F7X5UpKSr26KU3jKfpLmT8kuKtBNyHhEnfS8xtxPCqCb13p",
      netuid: 51,
      uids: [0, 16, 18],
      weights: [0.1, 0.2, 0.3],
      version_key: 1,
      current_block: 1234567,
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.validator_key, "string");
      assert.equal(b.netuid, 51);
      assert.ok(Array.isArray(b.uids));
      assert.ok(Array.isArray(b.weights));
    },
  },
];

describe("SN51 lium.io call_subnet_surface verification (#7064)", () => {
  for (const fixture of CALLABLE_SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface is callable`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, fixture.url);
      assert.equal(SURFACE.schema_url, fixture.schemaUrl);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body`, async () => {
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

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const result = await callToolWithSurface(SURFACE, fixture.body);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, fixture.id);
      assert.equal(result.structuredContent.status_code, 200);
      fixture.assertBody(result.structuredContent.body as Row);
    });
  }

  describe("sn-51-lium-io-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-51-lium-io-openapi");
    // Minimal fixture mirroring the live OpenAPI 3.1.0 document's stable
    // identity fields (full live body is ~256 KB and just over the tool cap).
    const BODY = {
      openapi: "3.1.0",
      info: { title: "Lium Backend API", version: "1.0.0" },
      paths: {
        "/version": {
          get: {
            summary: "Version",
            operationId: "version_version_get",
            responses: { 200: { description: "Successful Response" } },
          },
        },
        "/machines": {
          get: {
            summary: "Machines",
            operationId: "machines_machines_get",
            responses: { 200: { description: "Successful Response" } },
          },
        },
      },
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-51-lium-io-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://lium.io/api/openapi.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://lium.io/api/openapi.json");
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
      assert.equal((result.body as Row).info.title, "Lium Backend API");
      assert.ok((result.body as Row).paths["/version"]?.get);
      assert.ok((result.body as Row).paths["/machines"]?.get);
    });
  });
});
