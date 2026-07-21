// SN121 (sundae_bar) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7130, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN121's *real* registry surface configs
// (registry/subnets/sundae-bar.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking one auth_required,
// disabling a probe, changing an expect kind) is caught here.
//
// All five are public no-auth GET JSON feeds with a single fixed endpoint (no
// machine-readable schema). Each was verified live to return HTTP 200
// application/json:
//   sn-121-sundae-bar-subnet-api        GET https://api.sundaebar.ai/api/v2/validators  -> {"status":"ok"}
//   sn-121-sundae-bar-products-api       GET https://www.sundaebar.ai/api/products        -> {"data":[...]}
//   sn-121-sundae-bar-categories-api     GET https://www.sundaebar.ai/api/categories      -> [ {...} ]
//   sn-121-sundae-bar-skill-categories-api GET https://www.sundaebar.ai/api/skill-categories -> [ {...} ]
//   sn-121-sundae-bar-skill-creators-api GET https://www.sundaebar.ai/api/skill-creators  -> [ "..." ]
// HEAD returns 200 as well, so the GET probe is a superset-safe choice. The
// fixtures below mirror each live response's top-level shape rather than
// fetching it, keeping the test hermetic while still exercising the JSON
// parse-and-return path against each upstream's actual body shape (object,
// data-wrapped list, array of objects, and array of strings all covered).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 121;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/sundae-bar.json", import.meta.url),
    ),
    "utf8",
  ),
);

// Faithful subsets of each live response body's top-level shape.
const SURFACES = [
  {
    id: "sn-121-sundae-bar-subnet-api",
    url: "https://api.sundaebar.ai/api/v2/validators",
    body: { status: "ok" },
    assertBody: (b) => assert.equal(b.status, "ok"),
  },
  {
    id: "sn-121-sundae-bar-products-api",
    url: "https://www.sundaebar.ai/api/products",
    body: {
      data: [
        {
          type: "skill",
          name: "YouTube Automation",
          description: "Handle YouTube publishing metadata updates.",
        },
      ],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.data));
      assert.equal(b.data[0].type, "skill");
    },
  },
  {
    id: "sn-121-sundae-bar-categories-api",
    url: "https://www.sundaebar.ai/api/categories",
    body: [
      {
        id: "c56490ed-8793-4645-a6d6-76a2b21110bd",
        name: "Communication & Support",
        slug: "communication-support",
        subcategories: [],
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(b[0].slug, "communication-support");
    },
  },
  {
    id: "sn-121-sundae-bar-skill-categories-api",
    url: "https://www.sundaebar.ai/api/skill-categories",
    body: [
      {
        id: "f346fbc0-22c3-461f-8f16-ff37bd6dd333",
        name: "AI Tooling",
        slug: "ai-tooling",
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(b[0].slug, "ai-tooling");
    },
  },
  {
    id: "sn-121-sundae-bar-skill-creators-api",
    url: "https://www.sundaebar.ai/api/skill-creators",
    body: ["Addy Osmani", "Anthropic", "anthropics"],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0], "string");
    },
  },
];

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN121 sundae_bar call_subnet_surface verification (#7130)", () => {
  for (const fixture of SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface exists and is configured to be callable`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // HEAD 200 upstream too, but GET is what actually returns the JSON body.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, fixture.url);
      // Single fixed endpoint -- no machine-readable schema is expected.
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
        return jsonResponse(fixture.body);
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
                arguments: { surface_id: fixture.id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, fixture.id);
        assert.equal(result.structuredContent.status_code, 200);
        fixture.assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
