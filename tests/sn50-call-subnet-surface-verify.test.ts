// SN50 (Synth) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7063, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN50's *real* registry surface configs
// (registry/subnets/synth.json) to the tool's contract, so a future edit that
// regresses their callability is caught here.
//
// All three surfaces listed in #7063 were verified live on 2026-07-21 against
// their exact catalogued URLs:
//   sn-50-synth-openapi
//     GET https://api.synthdata.co/swagger.json
//     -> HTTP 200 application/json, Swagger 2.0 (~144 KB)
//        (swagger, info, paths, definitions)
//   sn-50-synth-subnet-api
//     GET https://api.synthdata.co/v2/leaderboard/latest
//     -> HTTP 200 application/json array of
//        {updated_at, neuron_uid, rewards, coldkey, ip_address}
//   sn-50-synth-meta-leaderboard
//     GET https://api.synthdata.co/v2/meta-leaderboard/latest
//     -> HTTP 200 application/json array of the same record shape
// Registry already matched reality -- no registry edit needed.
//
// Note on sn-50-synth-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.ts), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7063, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 50;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/synth.json", import.meta.url)),
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
    id: "sn-50-synth-subnet-api",
    url: "https://api.synthdata.co/v2/leaderboard/latest",
    body: [
      {
        updated_at: "2026-07-21T07:10:00Z",
        neuron_uid: 126,
        rewards: 0.0051936796,
        coldkey: "",
        ip_address: "",
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].neuron_uid, "number");
      assert.equal(typeof b[0].rewards, "number");
      assert.equal(typeof b[0].updated_at, "string");
    },
  },
  {
    id: "sn-50-synth-meta-leaderboard",
    url: "https://api.synthdata.co/v2/meta-leaderboard/latest",
    body: [
      {
        updated_at: "2026-07-21T07:10:00Z",
        neuron_uid: 122,
        rewards: 56.326527,
        coldkey: "5GCAYtugf3bna4FUKJwbx8xtwAJ7Grh6u4RBbZParKVwY1ta",
        ip_address: "/ipv4/133.125.95.228:8100",
      },
    ],
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].neuron_uid, "number");
      assert.equal(typeof b[0].rewards, "number");
      assert.equal(typeof b[0].coldkey, "string");
    },
  },
];

describe("SN50 Synth call_subnet_surface verification (#7063)", () => {
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

  describe("sn-50-synth-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-50-synth-openapi");
    // Faithful subset of the live swagger.json response's top-level shape.
    const BODY = {
      swagger: "2.0",
      info: {
        title: "Synth API",
        description:
          "Synth API offers programmatic access to probabilistic price forecasts",
      },
      paths: {
        "/v2/leaderboard/latest": {
          get: { summary: "Leaderboard - Latest" },
        },
      },
      definitions: {},
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-50-synth-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://api.synthdata.co/swagger.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://api.synthdata.co/swagger.json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
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
      assert.equal((result.body as Row).info.title, "Synth API");
      assert.ok((result.body as Row).paths["/v2/leaderboard/latest"]?.get);
    });
  });
});
