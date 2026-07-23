// SN62 (Ridges) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7075, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN62's *real* registry surface configs
// (registry/subnets/ridges.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Live-verified 2026-07-21 (direct GET to the catalogued URLs):
//   sn-62-ridges-subnet-api
//     GET https://agent-upload.ridges.ai/retrieval/top-agents
//     -> HTTP 200 JSON array of top agents (~1 KB)
//   sn-62-ridges-openapi
//     GET https://agent-upload.ridges.ai/openapi.json
//     -> HTTP 200 OpenAPI 3.1.0, info.title "FastAPI" (~72 KB)
//   sn-62-ridges-eval-pricing
//     GET .../upload/eval-pricing
//     -> HTTP 200 {"amount_alpha_rao":...,"payment_netuid":62}
//   sn-62-ridges-benchmark-agents
//     GET .../retrieval/benchmark-agents
//     -> HTTP 200 JSON array of benchmark agents
//   sn-62-ridges-network-statistics
//     GET .../retrieval/network-statistics
//     -> HTTP 200 {score_improvement_24_hrs, agents_created_24_hrs, top_score}
//        (first attempt 429 Cloudflare; retry 200 -- host intermittently
//        rate-limits, already documented in registry notes)
//   sn-62-ridges-perfectly-solved-over-time
//     GET .../retrieval/perfectly-solved-over-time
//     -> HTTP 200 {perfectly_solved_over_times:[...]} (~70 KB; same 429 quirk)
//   sn-62-ridges-top-scores-over-time
//     GET .../retrieval/top-scores-over-time
//     -> HTTP 200 [{hour, top_score}, ...] (same 429 quirk)
//   sn-62-ridges-latest-set-info
//     GET .../scoring/latest-set-info
//     -> HTTP 200 {latest_set_id, latest_set_created_at}
//   sn-62-ridges-connected-validators
//     GET .../validator/connected-validators-info
//     -> HTTP 200 [] (empty JSON array)
// Registry already matched reality -- no registry edit needed. Additional
// OpenAPI paths listed in #7075 are out of scope for this test-only PR.
//
// Note on sn-62-ridges-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS, so it is pinned at the callSubnetSurface module
// level only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 62;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/ridges.json", import.meta.url)),
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
    id: "sn-62-ridges-subnet-api",
    url: "https://agent-upload.ridges.ai/retrieval/top-agents",
    schemaUrl: "https://agent-upload.ridges.ai/openapi.json",
    body: [
      {
        miner_hotkey: "5EsNzkZ3DwDqCsYmSJDeGXX51dQJd5broUCH6dbDjvkTcicD",
        name: "test-hope-v40-2",
        version_num: 64,
        status: "finished",
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].miner_hotkey, "string");
      assert.equal(typeof b[0].name, "string");
      assert.equal(typeof b[0].version_num, "number");
    },
  },
  {
    id: "sn-62-ridges-eval-pricing",
    url: "https://agent-upload.ridges.ai/upload/eval-pricing",
    schemaUrl: undefined,
    body: { amount_alpha_rao: 2334089434, payment_netuid: 62 },
    assertBody: (b: Row) => {
      assert.equal(typeof b.amount_alpha_rao, "number");
      assert.equal(b.payment_netuid, 62);
    },
  },
  {
    id: "sn-62-ridges-benchmark-agents",
    url: "https://agent-upload.ridges.ai/retrieval/benchmark-agents",
    schemaUrl: undefined,
    body: [
      {
        miner_hotkey: "benchmark_miner",
        name: "Polyglot Python",
        version_num: 0,
        status: "finished",
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].miner_hotkey, "string");
      assert.equal(typeof b[0].name, "string");
    },
  },
  {
    id: "sn-62-ridges-network-statistics",
    url: "https://agent-upload.ridges.ai/retrieval/network-statistics",
    schemaUrl: undefined,
    body: {
      score_improvement_24_hrs: 0.0,
      agents_created_24_hrs: 7,
      top_score: 0.4,
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.score_improvement_24_hrs, "number");
      assert.equal(typeof b.agents_created_24_hrs, "number");
      assert.equal(typeof b.top_score, "number");
    },
  },
  {
    id: "sn-62-ridges-perfectly-solved-over-time",
    url: "https://agent-upload.ridges.ai/retrieval/perfectly-solved-over-time",
    schemaUrl: undefined,
    body: {
      perfectly_solved_over_times: [
        { hour: "2025-11-27T20:30:00Z", total_solved: 0, by_family: {} },
      ],
    },
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b.perfectly_solved_over_times));
      assert.equal(typeof b.perfectly_solved_over_times[0].hour, "string");
      assert.equal(
        typeof b.perfectly_solved_over_times[0].total_solved,
        "number",
      );
    },
  },
  {
    id: "sn-62-ridges-top-scores-over-time",
    url: "https://agent-upload.ridges.ai/retrieval/top-scores-over-time",
    schemaUrl: undefined,
    body: [
      { hour: "2026-07-20T23:00:00Z", top_score: 0.0 },
      { hour: "2026-07-21T00:00:00Z", top_score: 0.3 },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].hour, "string");
      assert.equal(typeof b[0].top_score, "number");
    },
  },
  {
    id: "sn-62-ridges-latest-set-info",
    url: "https://agent-upload.ridges.ai/scoring/latest-set-info",
    schemaUrl: undefined,
    body: {
      latest_set_id: 24,
      latest_set_created_at: "2026-07-20T21:14:52.749776Z",
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.latest_set_id, "number");
      assert.equal(typeof b.latest_set_created_at, "string");
    },
  },
  {
    id: "sn-62-ridges-connected-validators",
    url: "https://agent-upload.ridges.ai/validator/connected-validators-info",
    schemaUrl: undefined,
    body: [],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
    },
  },
];

describe("SN62 Ridges call_subnet_surface verification (#7075)", () => {
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

  describe("sn-62-ridges-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-62-ridges-openapi");
    const BODY = {
      openapi: "3.1.0",
      info: { title: "FastAPI", version: "0.1.0" },
      paths: {
        "/retrieval/top-agents": {
          get: {
            summary: "Top Agents",
            operationId: "top_agents_retrieval_top_agents_get",
          },
        },
        "/upload/eval-pricing": {
          get: {
            summary: "Eval Pricing",
            operationId: "eval_pricing_upload_eval_pricing_get",
          },
        },
      },
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-62-ridges-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://agent-upload.ridges.ai/openapi.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(
        SURFACE.schema_url,
        "https://agent-upload.ridges.ai/openapi.json",
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
      assert.equal((result.body as Row).info.title, "FastAPI");
      assert.ok((result.body as Row).paths["/retrieval/top-agents"]?.get);
    });
  });
});
