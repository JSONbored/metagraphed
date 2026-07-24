// SN56 (Gradients) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7069, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN56's *real* registry surface configs
// (registry/subnets/gradients.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// All ten surfaces listed in #7069 were verified live on 2026-07-21 against
// their exact catalogued URLs:
//   sn-56-gradients-openapi
//     GET https://api.gradients.io/docs
//     -> HTTP 200 text/html FastAPI/Scalar docs page (~1.2 KB)
//        (schema lives at schema_url https://api.gradients.io/openapi.json)
//   sn-56-gradients-latest-tournament-weights
//     GET .../v1/performance/latest-tournament-weights
//     -> HTTP 200 JSON {burn_data, text_top_miners, ...}
//   sn-56-gradients-weight-projection-static
//     GET .../v1/performance/weight-projection-static
//     -> HTTP 200 JSON {projections:[...]}
//   sn-56-gradients-last-boss-battle
//     GET .../v1/performance/last-boss-battle
//     -> HTTP 200 JSON {text_tournament_id, text_performance_differences, ...}
//   sn-56-gradients-subnet-api
//     GET .../v1/network/status
//     -> HTTP 200 JSON {number_of_jobs_*, next_training_end, job_can_be_made}
//   sn-56-gradients-healthz
//     GET .../healthz -> HTTP 200 {"ok":true}
//   sn-56-gradients-tournament-fees-api
//     GET .../tournament/fees
//     -> HTTP 200 JSON {*_tournament_fee_rao}
//   sn-56-gradients-auditing-tasks-api
//     GET .../auditing/tasks
//     -> HTTP 200 JSON array (~355 KB; exceeds MAX_RESPONSE_BYTES 262144,
//        so a live call_subnet_surface response would truncate -- fixtures
//        below stay under the cap)
//   sn-56-gradients-scores-url
//     GET .../auditing/scores-url -> HTTP 200 {"url":"https://..."}
//   sn-56-gradients-tournament-latest-details
//     GET .../tournament/latest/details
//     -> HTTP 200 JSON {text, image, environment}
// Registry already matched reality -- no registry edit needed.
//
// Note on sn-56-gradients-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.ts), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7069, a
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

const NETUID = 56;
const OPENAPI_SCHEMA = "https://api.gradients.io/openapi.json";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/gradients.json", import.meta.url),
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

const CALLABLE_SURFACES = [
  {
    id: "sn-56-gradients-latest-tournament-weights",
    url: "https://api.gradients.io/v1/performance/latest-tournament-weights",
    schemaUrl: OPENAPI_SCHEMA,
    body: {
      burn_data: { text_performance_diff: 0.07 },
      text_top_miners: [],
      image_top_miners: [],
      environment_top_miners: [],
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.burn_data, "object");
      assert.ok(Array.isArray(b.text_top_miners));
      assert.ok(Array.isArray(b.image_top_miners));
      assert.ok(Array.isArray(b.environment_top_miners));
    },
  },
  {
    id: "sn-56-gradients-weight-projection-static",
    url: "https://api.gradients.io/v1/performance/weight-projection-static",
    schemaUrl: OPENAPI_SCHEMA,
    body: {
      projections: [
        {
          percentage_improvement: 5.0,
          text_projection: { tournament_type: "text" },
        },
      ],
    },
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b.projections));
      assert.equal(typeof b.projections[0].percentage_improvement, "number");
    },
  },
  {
    id: "sn-56-gradients-last-boss-battle",
    url: "https://api.gradients.io/v1/performance/last-boss-battle",
    schemaUrl: OPENAPI_SCHEMA,
    body: {
      text_tournament_id: "tourn_c03a612f287687e0_20260713",
      text_performance_differences: [{ task_id: "12acb696-4c5b-4e57-800f" }],
      image_tournament_id: "tourn_image_example",
      image_performance_differences: [],
      environment_tournament_id: "tourn_env_example",
      environment_performance_differences: [],
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.text_tournament_id, "string");
      assert.ok(Array.isArray(b.text_performance_differences));
    },
  },
  {
    id: "sn-56-gradients-subnet-api",
    url: "https://api.gradients.io/v1/network/status",
    schemaUrl: undefined,
    body: {
      number_of_jobs_training: 0,
      number_of_jobs_preevaluation: 0,
      number_of_jobs_evaluating: 0,
      number_of_jobs_success: 25138,
      next_training_end: null,
      job_can_be_made: true,
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.number_of_jobs_success, "number");
      assert.equal(typeof b.job_can_be_made, "boolean");
    },
  },
  {
    id: "sn-56-gradients-healthz",
    url: "https://api.gradients.io/healthz",
    schemaUrl: undefined,
    body: { ok: true },
    assertBody: (b: Row) => {
      assert.equal(b.ok, true);
    },
  },
  {
    id: "sn-56-gradients-tournament-fees-api",
    url: "https://api.gradients.io/tournament/fees",
    schemaUrl: undefined,
    body: {
      text_tournament_fee_rao: 250000000,
      image_tournament_fee_rao: 200000000,
      environment_tournament_fee_rao: 250000000,
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.text_tournament_fee_rao, "number");
      assert.equal(typeof b.image_tournament_fee_rao, "number");
      assert.equal(typeof b.environment_tournament_fee_rao, "number");
    },
  },
  {
    id: "sn-56-gradients-auditing-tasks-api",
    url: "https://api.gradients.io/auditing/tasks",
    schemaUrl: undefined,
    // Minimal fixture of the live array shape (live body is ~355 KB).
    body: [
      {
        is_organic: true,
        task_id: "b2f6fbf8-353e-46f9-8e3c-5a6275d5ceca",
        status: "success",
        model_id: "Qwen/Qwen2.5-7B",
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].task_id, "string");
      assert.equal(typeof b[0].status, "string");
      assert.equal(typeof b[0].is_organic, "boolean");
    },
  },
  {
    id: "sn-56-gradients-scores-url",
    url: "https://api.gradients.io/auditing/scores-url",
    schemaUrl: undefined,
    body: {
      url: "https://s3.eu-central-003.backblazeb2.com/gradients-validator/latest_scores.json",
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.url, "string");
      assert.match(b.url, /^https:\/\//);
    },
  },
  {
    id: "sn-56-gradients-tournament-latest-details",
    url: "https://api.gradients.io/tournament/latest/details",
    schemaUrl: undefined,
    body: {
      text: {
        tournament_id: "tourn_c03a612f287687e0_20260713",
        tournament_type: "text",
        status: "completed",
      },
      image: { tournament_type: "image" },
      environment: { tournament_type: "environment" },
    },
    assertBody: (b: Row) => {
      assert.equal(typeof b.text, "object");
      assert.equal(typeof b.text.tournament_id, "string");
      assert.equal(typeof b.image, "object");
      assert.equal(typeof b.environment, "object");
    },
  },
];

describe("SN56 Gradients call_subnet_surface verification (#7069)", () => {
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

  describe("sn-56-gradients-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-56-gradients-openapi");
    // The catalogued URL is the FastAPI/Scalar HTML docs page, not the JSON
    // schema (schema_url points at /openapi.json separately).
    const HTML = `<!DOCTYPE html><html><head><title>FastAPI</title></head><body></body></html>`;

    test("registry surface exists, is no-auth GET HTML docs, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-56-gradients-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      // Live /docs returns text/html; probe.expect html matches reality.
      assert.equal(SURFACE.probe?.expect, "html");
      assert.equal(SURFACE.url, "https://api.gradients.io/docs");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, OPENAPI_SCHEMA);
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the HTML docs page as uncapped text", async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return new Response(HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "text/html; charset=utf-8");
      assert.equal(result.truncated, false);
      assert.equal(typeof result.body, "string");
      assert.match(result.body as string, /FastAPI/);
      assert.equal(result.parse_error, undefined);
    });
  });
});
