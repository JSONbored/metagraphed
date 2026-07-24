// SN127 (Astrid) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7135, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN127's real registry surfaces
// (registry/subnets/astrid.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking them auth_required,
// disabling their probe) is caught here.
//
// All five live-verified 2026-07-21:
//   - sn-127-astrid-subnet-api  GET .../public/arena/completed-competitions ->
//     HTTP 200 application/json {"competitions":[...]}. kind "subnet-api" is
//     operational, so it also resolves by surface_id through the MCP tool.
//   - sn-127-astrid-data-artifact  GET .../public/competitions/{id}/wallet-activity
//     -> HTTP 200 application/json {"totals":{...},"orders":[...],"positions":[...],
//     "trades":[...]}. kind "data-artifact" is operational too.
//   - sn-127-astrid-arena-dashboard HEAD https://arena.astrid.global -> 200 text/html
//   - sn-127-astrid-website        HEAD https://astrid.global/       -> 200 text/html
//   - sn-127-astrid-source         HEAD .../astridintelligence/sn-127 -> 200 text/html
//     The last three are NOT in OPERATIONAL_SURFACE_KINDS, so they are absent
//     from operational-surfaces.json and verified direct-call only (matching the
//     SN87/SN85 precedent). Their probe.method is HEAD, so the tool issues a HEAD
//     request and returns an empty body.
// Fixtures below mirror the live responses, keeping the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const NETUID = 127;

const registry: Row = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/astrid.json", import.meta.url)),
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
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 0 }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    return upstreamResponse(spec);
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
      {} as unknown as Env,
      deps,
    );
    return ((await httpResponse.json()) as Row).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const COMPLETED_COMPETITIONS = {
  competitions: [
    {
      competitionId: "190482a8-70b8-463d-b6c5-d1808bc7db9f",
      status: "completed",
    },
  ],
};

const WALLET_ACTIVITY = {
  totals: { orders: 3390, positions: 1649, trades: 3328 },
  orders: [],
  positions: [],
  trades: [],
};

const SURFACES = [
  {
    id: "sn-127-astrid-subnet-api",
    kind: "subnet-api",
    operational: true,
    url: "https://arena-api.astrid.global/public/arena/completed-competitions",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(COMPLETED_COMPETITIONS),
    expectedBody: COMPLETED_COMPETITIONS,
  },
  {
    id: "sn-127-astrid-data-artifact",
    kind: "data-artifact",
    operational: true,
    url: "https://arena-api.astrid.global/public/competitions/190482a8-70b8-463d-b6c5-d1808bc7db9f/wallet-activity",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(WALLET_ACTIVITY),
    expectedBody: WALLET_ACTIVITY,
  },
  {
    id: "sn-127-astrid-arena-dashboard",
    kind: "dashboard",
    operational: false,
    url: "https://arena.astrid.global",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-127-astrid-website",
    kind: "website",
    operational: false,
    url: "https://astrid.global/",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-127-astrid-source",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/astridintelligence/sn-127",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN127 Astrid ${spec.id} call_subnet_surface verification (#7135)`, () => {
    const SURFACE = surfaceById(spec.id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${spec.id} is present`);
      assert.equal(SURFACE.kind, spec.kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.url, spec.url);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, spec.method);
    });

    test(`callSubnetSurface issues a ${spec.method} to the surface's own url and returns the body`, async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init?.method;
          return upstreamResponse(spec);
        },
      });
      assert.equal(result.ok, true);
      // The tool resolves the surface url through URL(), which normalizes it --
      // a bare origin like https://arena.astrid.global gains a trailing slash.
      assert.equal(requestedUrl, new URL(SURFACE.url).toString());
      assert.equal(requestedMethod, spec.method);
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, spec.contentType);
      assert.equal(result.truncated, false);
      if (spec.contentType === "application/json") {
        // JSON content-type -> body parsed into an object.
        assert.deepEqual(result.body, spec.expectedBody);
      } else {
        // Non-JSON content-type -> body returned as an unparsed string.
        assert.equal(typeof result.body, "string");
        assert.equal(result.body, spec.expectedBody);
      }
    });

    if (spec.operational) {
      test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        const result = await callThroughMcpTool(SURFACE, spec);
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, spec.id);
        assert.equal(result.structuredContent.status_code, 200);
        assert.deepEqual(result.structuredContent.body, spec.expectedBody);
      });
    } else {
      test("kind is not an operational kind, so this surface is direct-call verified only", () => {
        // Documents WHY there is no MCP-tool-path test for this surface: the
        // operational catalog the tool resolves surface_id from only includes
        // OPERATIONAL_SURFACE_KINDS, which excludes dashboard/website/source-repo.
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
