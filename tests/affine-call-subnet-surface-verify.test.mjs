// SN120 (Affine) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7129, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN120's real registry surfaces
// (registry/subnets/affine.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking them auth_required,
// disabling their probe) is caught here.
//
// All eight live-verified 2026-07-21:
//   - sn-120-affine-openapi              GET https://api.affine.io/openapi.json
//     -> 200 application/json (OpenAPI 3.1.0 schema, 10 paths).
//   - sn-120-affine-health               GET .../api/v1/health -> 200
//     application/json {"status":"ok","service":"affine-api"}
//   - sn-120-affine-data-artifact        GET .../api/v1/rank/current -> 200
//     application/json {"window":{"champion":{...},...}}
//   - sn-120-affine-scores-latest        GET .../api/v1/scores/latest -> 200
//     application/json {"block_number":...,"scores":[...]}
//   - sn-120-affine-scores-weights-latest GET .../api/v1/scores/weights/latest
//     -> 200 application/json {"block_number":...,"config":{...},"weights":{...}}
//   - sn-120-affine-config               GET .../api/v1/config -> 200
//     application/json {"configs":{"validator_burn_percentage":0}}
//   - sn-120-affine-website     HEAD https://www.affine.io/ -> 200 text/html
//   - sn-120-affine-source-repo HEAD .../AffineFoundation/affine-cortex -> 200 text/html
// subnet-api + data-artifact are in OPERATIONAL_SURFACE_KINDS and are exercised
// end-to-end through the MCP tool; openapi/website/source-repo are not, so they
// are verified direct-call only (matching the SN85 openapi / SN87 website
// precedent).
// The 4 additional paths named in #7129 (`/api/v1/miners/uid/{uid}`,
// `/api/v1/miners/hotkey/{hotkey}`, `/api/v1/scores/uid/{uid}`,
// `/api/v1/config/{key}`) are all path-parameterized: they have no fixed
// callable URL and so cannot be registered as Surfaces (the schema requires a
// concrete uri), the same way SN112's /v1/apps/{app_id}/status route was left
// unregistered -- hence this is a test-only PR.
// Fixtures below mirror the live responses (large objects trimmed to observed
// fields), keeping the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 120;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/affine.json", import.meta.url)),
    "utf8",
  ),
);
const surfaceById = (id) => registry.surfaces.find((s) => s.id === id);

function upstreamResponse(spec) {
  return new Response(spec.method === "HEAD" ? null : spec.rawBody, {
    status: 200,
    headers: { "content-type": spec.contentType },
  });
}

async function callThroughMcpTool(surface, spec) {
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
      {},
      deps,
    );
    return (await httpResponse.json()).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Trimmed to the OpenAPI envelope fields actually observed; the 10 paths are
// elided for brevity (the tool returns whatever the schema serves, verbatim).
const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Affine API",
    description: "RESTful API for Affine validator infrastructure",
    version: "1.0.0",
  },
};

const HEALTH = { status: "ok", service: "affine-api" };

// rank/current returns a large window object; trimmed to the champion identity.
const RANK_CURRENT = {
  window: {
    champion: {
      uid: 96,
      hotkey: "5ECeJJpEMjW4pxM9eGyJ5ua3Sebfyr8kcVwLAdaiJLUC8pkW",
      revision: "ff6eb4bcff3e7c6b8c0e097bc0cffa4fa2ba8e01",
    },
  },
};

// scores/latest returns a long scores[] array; trimmed to one representative row.
const SCORES_LATEST = {
  block_number: 8629773,
  calculated_at: 1784153229,
  scores: [
    {
      miner_hotkey: "5ECeJJpEMjW4pxM9eGyJ5ua3Sebfyr8kcVwLAdaiJLUC8pkW",
      uid: 96,
      model_revision: "ff6eb4bcff3e7c6b8c0e097bc0cffa4fa2ba8e01",
    },
  ],
};

// scores/weights/latest; weights map trimmed to one representative entry.
const SCORES_WEIGHTS_LATEST = {
  block_number: 8629773,
  config: {
    window_id: 8629773,
    win_margin: 0.03,
    win_min_dominant_envs: 1,
    win_not_worse_tolerance: 0.02,
  },
  weights: { 96: { weight: 0.2 } },
};

const CONFIG = { configs: { validator_burn_percentage: 0 } };

const SURFACES = [
  {
    id: "sn-120-affine-openapi",
    kind: "openapi",
    operational: false,
    url: "https://api.affine.io/openapi.json",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(OPENAPI),
    expectedBody: OPENAPI,
  },
  {
    id: "sn-120-affine-health",
    kind: "subnet-api",
    operational: true,
    url: "https://api.affine.io/api/v1/health",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(HEALTH),
    expectedBody: HEALTH,
  },
  {
    id: "sn-120-affine-data-artifact",
    kind: "data-artifact",
    operational: true,
    url: "https://api.affine.io/api/v1/rank/current",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(RANK_CURRENT),
    expectedBody: RANK_CURRENT,
  },
  {
    id: "sn-120-affine-scores-latest",
    kind: "subnet-api",
    operational: true,
    url: "https://api.affine.io/api/v1/scores/latest",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(SCORES_LATEST),
    expectedBody: SCORES_LATEST,
  },
  {
    id: "sn-120-affine-scores-weights-latest",
    kind: "subnet-api",
    operational: true,
    url: "https://api.affine.io/api/v1/scores/weights/latest",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(SCORES_WEIGHTS_LATEST),
    expectedBody: SCORES_WEIGHTS_LATEST,
  },
  {
    id: "sn-120-affine-config",
    kind: "data-artifact",
    operational: true,
    url: "https://api.affine.io/api/v1/config",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(CONFIG),
    expectedBody: CONFIG,
  },
  {
    id: "sn-120-affine-website",
    kind: "website",
    operational: false,
    url: "https://www.affine.io/",
    method: "HEAD",
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-120-affine-source-repo",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/AffineFoundation/affine-cortex",
    method: "HEAD",
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN120 Affine ${spec.id} call_subnet_surface verification (#7129)`, () => {
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
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return upstreamResponse(spec);
        },
      });
      assert.equal(result.ok, true);
      // The tool resolves the surface url through URL(), which normalizes it.
      assert.equal(requestedUrl, new URL(SURFACE.url).toString());
      assert.equal(requestedMethod, spec.method);
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, spec.contentType);
      assert.equal(result.truncated, false);
      if (spec.contentType.startsWith("application/json")) {
        // JSON content-type -> body parsed into an object.
        assert.deepEqual(result.body, spec.expectedBody);
      } else {
        // Non-JSON content-type (HEAD html) -> unparsed string.
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
        // OPERATIONAL_SURFACE_KINDS, which excludes openapi/website/source-repo.
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
