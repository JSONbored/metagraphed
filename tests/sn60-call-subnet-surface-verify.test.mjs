// SN60 (Bitsec) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7073, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN60's *real* registry surface configs
// (registry/subnets/bitsec.json) to the tool's contract, so a future edit that
// regresses their callability is caught here.
//
// All ten surfaces listed in #7073 were verified live on 2026-07-21 against
// their exact catalogued URLs:
//   sn-60-bitsec-ai-openapi
//     GET https://bitsec.ai/api/openapi.json
//     -> HTTP 200 OpenAPI 3.1.0 (~44 KB; title FastAPI)
//   sn-60-bitsec-ai-subnet-api
//     GET https://bitsec.ai/api/analytics
//     -> HTTP 200 {round, screened_agents, agent_stats, projects}
//   sn-60-bitsec-agents-list
//     GET https://bitsec.ai/api/agents/
//     -> HTTP 200 array of {agent_id, version, hotkey, project_set_name, ...}
//   sn-60-bitsec-agents-evaluation-status
//     GET https://bitsec.ai/api/agents/evaluation-status
//     -> HTTP 200 {total_agents, agents_pending_evaluation, is_round_evaluated}
//   sn-60-bitsec-agents-top-with-burn
//     GET https://bitsec.ai/api/agents/top-with-burn/
//     -> HTTP 200 {agents, burn, payout_structure_pct}
//   sn-60-bitsec-agents-top
//     GET https://bitsec.ai/api/agents/top/
//     -> HTTP 200 array of {agent_id, hotkey}
//   sn-60-bitsec-analytics-validators
//     GET https://bitsec.ai/api/analytics/validators
//     -> HTTP 200 {project_set_id, validators:[...]}
//   sn-60-bitsec-jobs-leaderboard
//     GET https://bitsec.ai/api/jobs/leaderboard
//     -> HTTP 200 JSON array (may be empty between rounds)
//   sn-60-bitsec-jobs-runs-active
//     GET https://bitsec.ai/api/jobs/runs/active
//     -> HTTP 200 JSON array (~398 KB; exceeds MAX_RESPONSE_BYTES 262144,
//        so a live call_subnet_surface response would truncate -- fixtures
//        below stay under the cap)
//   sn-60-bitsec-jobs-stats
//     GET https://bitsec.ai/api/jobs/stats
//     -> HTTP 200 {agents_created_1w, top_score, real_vulns_found, daily_prize_pool}
// Registry already matched reality -- no registry edit needed.
//
// Note on sn-60-bitsec-ai-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7073, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 60;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/bitsec.json", import.meta.url)),
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

async function callToolWithSurface(surface, body) {
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
    // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 0 }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    return jsonResponse(body);
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

const CALLABLE_SURFACES = [
  {
    id: "sn-60-bitsec-ai-subnet-api",
    url: "https://bitsec.ai/api/analytics",
    body: {
      round: { name: "v3.1.5", phase: "SUBMISSION" },
      screened_agents: 0,
      agent_stats: {},
      projects: [],
    },
    assertBody: (b) => {
      assert.equal(typeof b.round, "object");
      assert.equal(typeof b.round.name, "string");
      assert.equal(typeof b.round.phase, "string");
    },
  },
  {
    id: "sn-60-bitsec-agents-list",
    url: "https://bitsec.ai/api/agents/",
    body: [
      {
        agent_id: 2507,
        version: 481,
        hotkey: "5CdU34yGd1pAVL1WJLPzgs1FjgcPiPcsH5VXuu9pwpHrP6qR",
        project_set_name: "v3.1.5",
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].agent_id, "number");
      assert.equal(typeof b[0].hotkey, "string");
    },
  },
  {
    id: "sn-60-bitsec-agents-evaluation-status",
    url: "https://bitsec.ai/api/agents/evaluation-status",
    body: {
      total_agents: 0,
      agents_pending_evaluation: 0,
      is_round_evaluated: false,
    },
    assertBody: (b) => {
      assert.equal(typeof b.total_agents, "number");
      assert.equal(typeof b.agents_pending_evaluation, "number");
      assert.equal(typeof b.is_round_evaluated, "boolean");
    },
  },
  {
    id: "sn-60-bitsec-agents-top-with-burn",
    url: "https://bitsec.ai/api/agents/top-with-burn/",
    body: {
      agents: [
        {
          agent_id: 1989,
          hotkey: "5HKBGxzXqJmobmbgRsK5HHva6vmKv1tARFR4dES3kAex1XzK",
        },
      ],
      burn: {},
      payout_structure_pct: [],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.agents));
      assert.equal(typeof b.agents[0].agent_id, "number");
      assert.equal(typeof b.agents[0].hotkey, "string");
    },
  },
  {
    id: "sn-60-bitsec-agents-top",
    url: "https://bitsec.ai/api/agents/top/",
    body: [
      {
        agent_id: 113,
        hotkey: "5CXLwkK1Scd1uiMUrXYjJUTTPxqqyH2FTJQNLp9uXQhA9rhR",
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].agent_id, "number");
      assert.equal(typeof b[0].hotkey, "string");
    },
  },
  {
    id: "sn-60-bitsec-analytics-validators",
    url: "https://bitsec.ai/api/analytics/validators",
    body: {
      project_set_id: 16,
      validators: [{ name: "Bitsec", pending_agents_count: 0 }],
    },
    assertBody: (b) => {
      assert.equal(typeof b.project_set_id, "number");
      assert.ok(Array.isArray(b.validators));
      assert.equal(typeof b.validators[0].name, "string");
    },
  },
  {
    id: "sn-60-bitsec-jobs-leaderboard",
    url: "https://bitsec.ai/api/jobs/leaderboard",
    // Live response may be an empty array between rounds; pin the array shape.
    body: [
      {
        user: "example",
        agent: 1,
        score: 0.9,
        hotkey: "5CXLwkK1Scd1uiMUrXYjJUTTPxqqyH2FTJQNLp9uXQhA9rhR",
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].score, "number");
      assert.equal(typeof b[0].hotkey, "string");
    },
  },
  {
    id: "sn-60-bitsec-jobs-runs-active",
    url: "https://bitsec.ai/api/jobs/runs/active",
    // Minimal fixture of the live array shape (live body is ~398 KB).
    body: [
      {
        validator_id: 3,
        status: "cancelled",
        started_at: null,
        completed_at: null,
        miner_id: 2,
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].validator_id, "number");
      assert.equal(typeof b[0].status, "string");
      assert.equal(typeof b[0].miner_id, "number");
    },
  },
  {
    id: "sn-60-bitsec-jobs-stats",
    url: "https://bitsec.ai/api/jobs/stats",
    body: {
      agents_created_1w: 478,
      top_score: null,
      real_vulns_found: 0,
      daily_prize_pool: "$1,000",
    },
    assertBody: (b) => {
      assert.equal(typeof b.agents_created_1w, "number");
      assert.equal(typeof b.real_vulns_found, "number");
      assert.equal(typeof b.daily_prize_pool, "string");
    },
  },
];

describe("SN60 Bitsec call_subnet_surface verification (#7073)", () => {
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
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body`, async () => {
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

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const result = await callToolWithSurface(SURFACE, fixture.body);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, fixture.id);
      assert.equal(result.structuredContent.status_code, 200);
      fixture.assertBody(result.structuredContent.body);
    });
  }

  describe("sn-60-bitsec-ai-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-60-bitsec-ai-openapi");
    // Faithful subset of the live openapi.json response's top-level shape.
    const BODY = {
      openapi: "3.1.0",
      info: { title: "FastAPI", version: "0.1.0" },
      paths: {
        "/api/analytics": {
          get: { summary: "Analytics", tags: ["analytics"] },
        },
      },
      components: {},
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-60-bitsec-ai-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://bitsec.ai/api/openapi.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://bitsec.ai/api/openapi.json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the OpenAPI 3.1 document as parsed JSON", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(BODY);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.truncated, false);
      assert.equal(result.body.openapi, "3.1.0");
      assert.equal(result.body.info.title, "FastAPI");
      assert.ok(result.body.paths["/api/analytics"]?.get);
    });
  });
});
