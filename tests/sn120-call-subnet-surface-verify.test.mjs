// SN120 (Affine) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7129, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN120's *real* registry surface config
// (registry/subnets/affine.json) to the tool's contract, so a future edit that
// regresses callability (flipping to HEAD, marking a surface auth_required,
// disabling its probe, or moving a URL) is caught here.
//
// Verified live 2026-07-21 against api.affine.io. All four listed surfaces
// return HTTP 200 application/json:
//   - sn-120-affine-openapi                -> OpenAPI 3.1 doc, title "Affine API"
//   - sn-120-affine-health                 -> {"status":"ok","service":"affine-api"}
//   - sn-120-affine-scores-latest          -> {block_number, calculated_at, scores[]}
//   - sn-120-affine-scores-weights-latest  -> {block_number, config, weights}
// The three subnet-api endpoints 405 on HEAD, so the probe correctly declares
// GET; openapi.json serves 200 on both GET and HEAD. The fixtures below mirror
// each live response's top-level shape rather than fetching it, keeping the
// test hermetic while still exercising the JSON parse-and-return path against
// the upstream's actual field set.
//
// Note on scope: only the `subnet-api` surfaces flow through the MCP tool's
// surface_id resolver -- operational-surfaces.json (the catalog the tool reads)
// is built solely from OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs),
// which excludes the `openapi` kind. The openapi surface is therefore verified
// through callSubnetSurface directly, the same request the tool would make.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/affine.json", import.meta.url)),
    "utf8",
  ),
);
const surfaceById = (id) => registry.surfaces.find((s) => s.id === id);

// Faithful subsets of the live api.affine.io responses (observed 2026-07-21).
const BODIES = {
  "sn-120-affine-openapi": {
    openapi: "3.1.0",
    info: {
      title: "Affine API",
      description: "RESTful API for Affine validator infrastructure",
      version: "1.0.0",
    },
    paths: {
      "/api/v1/scores/latest": { get: {} },
      "/api/v1/scores/weights/latest": { get: {} },
      "/api/v1/health": { get: {} },
    },
  },
  "sn-120-affine-health": { status: "ok", service: "affine-api" },
  "sn-120-affine-scores-latest": {
    block_number: 8629773,
    calculated_at: 1784153229,
    scores: [
      {
        miner_hotkey: "5ECeJJpEMjW4pxM9eGyJ5ua3Sebfyr8kcVwLAdaiJLUC8pkW",
        uid: 96,
        model_revision: "ff6eb4bcff3e7c6b8c0e097bc0cffa4fa2ba8e01",
        overall_score: 1.0,
      },
    ],
  },
  "sn-120-affine-scores-weights-latest": {
    block_number: 8629773,
    config: {
      window_id: 8629773,
      win_margin: 0.03,
      win_min_dominant_envs: 1,
      win_not_worse_tolerance: 0.02,
    },
    weights: { 96: { weight: 0.2 }, 145: { weight: 0.2 } },
  },
};

function jsonResponse(id) {
  return new Response(JSON.stringify(BODIES[id]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// The four surfaces named in the issue, with a per-surface assertion on the
// returned body so a fixture that stopped matching the live shape is obvious.
const SURFACES = [
  {
    id: "sn-120-affine-openapi",
    kind: "openapi",
    url: "https://api.affine.io/openapi.json",
    mcpResolvable: false,
    assertBody: (b) => {
      assert.equal(b.openapi, "3.1.0");
      assert.equal(b.info.title, "Affine API");
      assert.ok("/api/v1/scores/latest" in b.paths);
    },
  },
  {
    id: "sn-120-affine-health",
    kind: "subnet-api",
    url: "https://api.affine.io/api/v1/health",
    mcpResolvable: true,
    assertBody: (b) => {
      assert.equal(b.status, "ok");
      assert.equal(b.service, "affine-api");
    },
  },
  {
    id: "sn-120-affine-scores-latest",
    kind: "subnet-api",
    url: "https://api.affine.io/api/v1/scores/latest",
    mcpResolvable: true,
    assertBody: (b) => {
      assert.equal(typeof b.block_number, "number");
      assert.ok(Array.isArray(b.scores));
      assert.equal(typeof b.scores[0].miner_hotkey, "string");
    },
  },
  {
    id: "sn-120-affine-scores-weights-latest",
    kind: "subnet-api",
    url: "https://api.affine.io/api/v1/scores/weights/latest",
    mcpResolvable: true,
    assertBody: (b) => {
      assert.equal(typeof b.block_number, "number");
      assert.equal(typeof b.config.window_id, "number");
      assert.equal(typeof b.weights, "object");
    },
  },
];

describe("SN120 Affine call_subnet_surface verification (#7129)", () => {
  for (const s of SURFACES) {
    describe(s.id, () => {
      const surface = surfaceById(s.id);

      test("registry surface exists and is configured to be callable", () => {
        assert.ok(surface, `registry surface ${s.id} is present`);
        assert.equal(surface.kind, s.kind);
        assert.equal(surface.auth_required, false);
        assert.equal(surface.public_safe, true);
        assert.equal(surface.probe?.enabled, true);
        // Live: the subnet-api endpoints 405 on HEAD, so the probe must GET.
        assert.equal(surface.probe?.method, "GET");
        assert.equal(surface.probe?.expect, "json");
        assert.equal(surface.url, s.url);
      });

      test("callSubnetSurface returns the real JSON body using the surface's url + GET", async () => {
        let requestedUrl;
        let requestedMethod;
        const result = await callSubnetSurface(surface, {
          isUnsafeUrl: async () => false,
          fetchImpl: async (url, init) => {
            requestedUrl = String(url);
            requestedMethod = init.method;
            return jsonResponse(s.id);
          },
        });
        assert.equal(result.ok, true);
        assert.equal(requestedUrl, surface.url);
        assert.equal(requestedMethod, "GET");
        assert.equal(result.status_code, 200);
        assert.equal(result.content_type, "application/json");
        assert.equal(result.truncated, false);
        s.assertBody(result.body);
      });
    });
  }

  test("only the subnet-api surfaces are exposed through the MCP surface_id catalog", () => {
    // operational-surfaces.json (the tool's resolver source) excludes the
    // openapi kind; guard that assumption so the MCP cases below stay honest.
    assert.equal(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"), true);
    assert.equal(OPERATIONAL_SURFACE_KINDS.includes("openapi"), false);
  });

  for (const s of SURFACES.filter((x) => x.mcpResolvable)) {
    test(`end-to-end through call_subnet_surface, resolved by surface id: ${s.id}`, async () => {
      const surface = surfaceById(s.id);
      // operational-surfaces.json flattens each registry surface's `id` to a
      // top-level `surface_id`; build that catalog shape from the real surface.
      const catalog = {
        surfaces: [{ ...surface, surface_id: surface.id, netuid: 120 }],
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
        return jsonResponse(s.id);
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
                arguments: { surface_id: s.id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, s.id);
        assert.equal(result.structuredContent.status_code, 200);
        s.assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
