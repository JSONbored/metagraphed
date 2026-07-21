// SN68 (NOVA) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7081, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN68's *real* registry surface configs
// (registry/subnets/nova.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking one auth_required,
// disabling a probe) is caught here.
//
// Both surfaces listed in #7081 were verified live on 2026-07-21 against their
// exact catalogued URLs:
//   sn-68-nova-score-share-openapi
//     GET https://vali-score-share-api.metanova-labs.ai/openapi.json
//     -> HTTP 200 application/json, OpenAPI 3.1.0 object
//        (openapi, info.title "Boltz score sharing API", paths, components)
//   sn-68-nova-score-share-molecules
//     GET https://vali-score-share-api.metanova-labs.ai/api/v1/molecules
//     -> HTTP 200 application/json
//        {items:[{name, epoch, target_averages}, ...], total, page, page_size, total_pages}
// The fixtures below mirror each live response's shape rather than fetching
// it, keeping the test hermetic while still exercising the JSON
// parse-and-return path. (Molecule lists are live data, so the tests assert
// the stable shape, not exact contents.)
//
// Note on sn-68-nova-score-share-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7081, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only --
// no MCP-tool-path test fakes a catalog entry production does not have.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 68;
const MOLECULES_ID = "sn-68-nova-score-share-molecules";
const OPENAPI_ID = "sn-68-nova-score-share-openapi";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/nova.json", import.meta.url)),
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

describe("SN68 NOVA call_subnet_surface verification (#7081)", () => {
  describe(MOLECULES_ID, () => {
    const SURFACE = surfaceOf(MOLECULES_ID);
    // Faithful subset of the live /api/v1/molecules response shape.
    const BODY = {
      items: [
        {
          name: "rxn:3:60338:11684:128438",
          epoch: 24009,
          target_averages: {
            Q9UQM7: { score: 0.092 },
          },
        },
      ],
      total: 1,
      page: 1,
      page_size: 50,
      total_pages: 1,
    };

    test("registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${MOLECULES_ID} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // No-auth GET returning JSON.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(
        SURFACE.url,
        "https://vali-score-share-api.metanova-labs.ai/api/v1/molecules",
      );
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
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
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      // Live molecule list -- assert the stable shape, not exact contents.
      assert.ok(Array.isArray(result.body.items));
      assert.equal(typeof result.body.items[0].name, "string");
      assert.equal(typeof result.body.items[0].epoch, "number");
      assert.equal(typeof result.body.total, "number");
      assert.equal(typeof result.body.page, "number");
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      // operational-surfaces.json flattens each registry surface's `id` to a
      // top-level `surface_id`; build that catalog shape from the real surface.
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
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
        return jsonResponse(BODY);
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
                arguments: { surface_id: MOLECULES_ID },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, MOLECULES_ID);
        assert.equal(result.structuredContent.status_code, 200);
        assert.ok(Array.isArray(result.structuredContent.body.items));
        assert.equal(typeof result.structuredContent.body.total, "number");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe(`${OPENAPI_ID} (direct-call only)`, () => {
    const SURFACE = surfaceOf(OPENAPI_ID);
    // Faithful subset of the live openapi.json response's top-level shape.
    const BODY = {
      openapi: "3.1.0",
      info: {
        title: "Boltz score sharing API",
        version: "0.1.0",
      },
      paths: {
        "/api/v1/molecules": {
          get: { summary: "List Molecules" },
        },
      },
      components: {},
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, `registry surface ${OPENAPI_ID} is present`);
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(
        SURFACE.url,
        "https://vali-score-share-api.metanova-labs.ai/openapi.json",
      );
      // #7081 says this surface has a captured schema; pin that linkage.
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(
        SURFACE.schema_url,
        "https://vali-score-share-api.metanova-labs.ai/openapi.json",
      );
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      // Documents WHY there is no MCP-tool-path test for this surface: the
      // operational catalog the tool resolves from only includes these kinds.
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
      assert.equal(result.body.info.title, "Boltz score sharing API");
      assert.equal(
        result.body.paths["/api/v1/molecules"].get.summary,
        "List Molecules",
      );
    });
  });
});
