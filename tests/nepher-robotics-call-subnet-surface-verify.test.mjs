// SN49 (Nepher Robotics) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7062, MCP execute Phase 1 follow-up #7014/#7215).
// Extends the health-only pin from #7379 to cover every Phase 1 surface listed
// in #7062. Auth-gated `sn-49-nepher-tournament-api` is Phase 3 territory
// (credential passthrough) -- pinned only as an auth_required rejection.
// kind "openapi" is not operational -- direct-call verified only (sn74 pattern).
// New surfaces from the issue's "additional" review section are out of scope
// (registry enrichment, separate process).
//
// Live-verified 2026-07-21 against tournament-api.nepher.ai (hermetic fixtures
// mirror stable top-level shapes):
//   openapi        HEAD /openapi.json -> 200 application/json
//   health         GET  /health -> {"status":"healthy",...}
//   current-block  GET  /api/v1/tournaments/current-block -> {current_block,network}
//   list           GET  /api/v1/tournaments/list -> {tournaments:[...]}
//   active/id      GET  /api/v1/tournaments/active/id -> {tournament_id}
//   active/ids     GET  /api/v1/tournaments/active/ids -> {tournament_ids:[...]}
//   active         GET  /api/v1/tournaments/active -> {id,task_name,...}
//   evaluations    GET  /api/v1/evaluations -> {items:[...]}
//   ready          GET  /ready -> {"status":"ready",checks:{database:"ok"}}
//   pricing        GET  /api/v1/tournaments/pricing?subnet_uid=49 -> {network,subnet_uid,...}
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 49;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/nepher-robotics.json", import.meta.url),
    ),
    "utf8",
  ),
);

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function headJsonResponse() {
  return new Response(null, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callToolWithSurface(surface, upstreamResponse) {
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
    return upstreamResponse();
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
            arguments: { surface_id: surface.id },
          },
        }),
      }),
      {},
      deps,
    );
    return (await response.json()).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const GET_JSON_SURFACES = [
  {
    id: "sn-49-nepher-tournament-health",
    url: "https://tournament-api.nepher.ai/health",
    body: {
      status: "healthy",
      service: "tournament-backend",
      version: "1.0.0",
    },
    assertBody: (b) => {
      assert.equal(b.status, "healthy");
      assert.equal(typeof b.service, "string");
    },
  },
  {
    id: "sn-49-nepher-current-block-api",
    url: "https://tournament-api.nepher.ai/api/v1/tournaments/current-block",
    body: { current_block: 8669926, network: "finney" },
    assertBody: (b) => {
      assert.equal(typeof b.current_block, "number");
      assert.equal(b.network, "finney");
    },
  },
  {
    id: "sn-49-nepher-tournaments-list-api",
    url: "https://tournament-api.nepher.ai/api/v1/tournaments/list",
    body: {
      tournaments: [
        {
          id: "30582047-5043-4097-9931-4d885a8dc939",
          task_name: "task-leatherback-lidar",
        },
      ],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.tournaments));
      assert.equal(typeof b.tournaments[0].id, "string");
      assert.equal(typeof b.tournaments[0].task_name, "string");
    },
  },
  {
    id: "sn-49-nepher-active-tournament-id-api",
    url: "https://tournament-api.nepher.ai/api/v1/tournaments/active/id",
    body: { tournament_id: "ef115bcf-db44-4272-8ff9-06e7f9288570" },
    assertBody: (b) => assert.equal(typeof b.tournament_id, "string"),
  },
  {
    id: "sn-49-nepher-active-tournament-ids-api",
    url: "https://tournament-api.nepher.ai/api/v1/tournaments/active/ids",
    body: {
      tournament_ids: [
        "ef115bcf-db44-4272-8ff9-06e7f9288570",
        "1ccb3805-015d-47cd-ba3d-49e25c08452d",
      ],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.tournament_ids));
      assert.equal(typeof b.tournament_ids[0], "string");
    },
  },
  {
    id: "sn-49-nepher-active-tournament-api",
    url: "https://tournament-api.nepher.ai/api/v1/tournaments/active",
    body: {
      id: "ef115bcf-db44-4272-8ff9-06e7f9288570",
      task_name: "task-franka-pickplace-multibase",
    },
    assertBody: (b) => {
      assert.equal(typeof b.id, "string");
      assert.equal(typeof b.task_name, "string");
    },
  },
  {
    id: "sn-49-nepher-evaluations-api",
    url: "https://tournament-api.nepher.ai/api/v1/evaluations",
    body: {
      items: [
        {
          id: "25082121-a034-42b1-a37e-93bb58c6af40",
          tournament_id: "1ccb3805-015d-47cd-ba3d-49e25c08452d",
        },
      ],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.items));
      assert.equal(typeof b.items[0].id, "string");
      assert.equal(typeof b.items[0].tournament_id, "string");
    },
  },
  {
    id: "sn-49-nepher-tournament-readiness",
    url: "https://tournament-api.nepher.ai/ready",
    body: { status: "ready", checks: { database: "ok" } },
    assertBody: (b) => {
      assert.equal(b.status, "ready");
      assert.equal(b.checks.database, "ok");
    },
  },
  {
    id: "sn-49-nepher-tournament-pricing",
    url: "https://tournament-api.nepher.ai/api/v1/tournaments/pricing?subnet_uid=49",
    body: {
      network: "finney",
      subnet_uid: 49,
      alpha_to_tao: 0.007269482,
      tao_to_usd: 201.46,
    },
    assertBody: (b) => {
      assert.equal(b.network, "finney");
      assert.equal(b.subnet_uid, 49);
      assert.equal(typeof b.alpha_to_tao, "number");
    },
  },
];

describe("SN49 Nepher Robotics call_subnet_surface verification (#7062)", () => {
  for (const fixture of GET_JSON_SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface exists and is configured to be callable`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, fixture.url);
      assert.equal(SURFACE.schema_url, undefined);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body using the surface's own url + GET`, async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(fixture.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body);
    });

    test(`${fixture.id}: end-to-end through the call_subnet_surface MCP tool, resolved by surface id`, async () => {
      const result = await callToolWithSurface(SURFACE, () =>
        jsonResponse(fixture.body),
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, fixture.id);
      assert.equal(result.structuredContent.status_code, 200);
      fixture.assertBody(result.structuredContent.body);
    });
  }

  describe("sn-49-nepher-tournament-openapi (direct-call only, HEAD probe)", () => {
    const SURFACE = surfaceOf("sn-49-nepher-tournament-openapi");

    test("registry surface exists, is no-auth HEAD, and carries its captured schema", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-49-nepher-tournament-openapi is present",
      );
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // Live HEAD /openapi.json -> 200 application/json (body empty on HEAD).
      assert.equal(SURFACE.probe?.method, "HEAD");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(
        SURFACE.url,
        "https://tournament-api.nepher.ai/openapi.json",
      );
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(
        SURFACE.schema_url,
        "https://tournament-api.nepher.ai/openapi.json",
      );
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface issues HEAD against the OpenAPI url and returns 200", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return headJsonResponse();
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "HEAD");
      assert.equal(result.status_code, 200);
      assert.match(result.content_type, /^application\/json/i);
    });
  });

  describe("sn-49-nepher-tournament-api (auth required -- Phase 3 territory)", () => {
    const SURFACE = surfaceOf("sn-49-nepher-tournament-api");

    test("registry surface exists and correctly declares bearer auth", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-49-nepher-tournament-api is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, true);
      assert.equal(SURFACE.auth?.scheme, "bearer");
      assert.equal(SURFACE.url, "https://tournament-api.nepher.ai");
      assert.equal(
        SURFACE.schema_url,
        "https://tournament-api.nepher.ai/openapi.json",
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
