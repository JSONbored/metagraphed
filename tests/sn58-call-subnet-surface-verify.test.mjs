// SN58 (Handshake58) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7071, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN58's *real* registry surface configs
// (registry/subnets/handshake58.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// All six surfaces listed in #7071 were verified live on 2026-07-21 against
// their exact catalogued URLs (using each surface's own declared probe method):
//   sn-58-handshake58-openapi
//     HEAD https://handshake58.com/openapi.json -> HTTP 200 application/json
//     (GET also returns OpenAPI 3.0.3 "Handshake58 DRAIN Protocol API", ~11 KB)
//   sn-58-handshake58-provider-directory-api
//     HEAD https://handshake58.com/api/mcp/providers -> HTTP 200 application/json
//   sn-58-handshake58-skills-api
//     HEAD https://handshake58.com/api/skills?status=published
//     -> HTTP 200 application/json
//   sn-58-handshake58-subnet-api
//     GET https://handshake58.com/api/agent
//     -> HTTP 200 {name, tagline, description, requirements, ...}
//   sn-58-handshake58-validator-registry-api
//     GET https://handshake58.com/api/validator/registry
//     -> HTTP 200 {version, updated, providers, count, onlineCount, ...}
//     (no probe block in the registry -- call_subnet_surface defaults to GET)
//   sn-58-handshake58-directory-providers
//     GET https://handshake58.com/api/directory/providers
//     -> HTTP 200 {success, providers, count} (~274 KB; exceeds
//        MAX_RESPONSE_BYTES 262144 -- a live call would truncate; fixtures
//        below stay under the cap)
// Registry already matched reality -- no registry edit needed.
//
// Note on sn-58-handshake58-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS, so it is absent from operational-surfaces.json
// and cannot be resolved through the tool in production. Per #7071, a direct
// request is equally valid verification -- pinned at callSubnetSurface only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 58;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/handshake58.json", import.meta.url),
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
    // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
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

const HEAD_SURFACES = [
  {
    id: "sn-58-handshake58-provider-directory-api",
    url: "https://handshake58.com/api/mcp/providers",
    schemaUrl: "https://handshake58.com/openapi.json",
  },
  {
    id: "sn-58-handshake58-skills-api",
    url: "https://handshake58.com/api/skills?status=published",
    schemaUrl: undefined,
  },
];

const GET_SURFACES = [
  {
    id: "sn-58-handshake58-subnet-api",
    url: "https://handshake58.com/api/agent",
    hasProbe: true,
    schemaUrl: undefined,
    body: {
      name: "Handshake58",
      tagline:
        "Payments for AI Agents — No API keys, no credit cards, no subscriptions.",
      description: "Service marketplace with USDC micropayments.",
    },
    assertBody: (b) => {
      assert.equal(b.name, "Handshake58");
      assert.equal(typeof b.tagline, "string");
      assert.equal(typeof b.description, "string");
    },
  },
  {
    id: "sn-58-handshake58-validator-registry-api",
    url: "https://handshake58.com/api/validator/registry",
    // Issue listed method as "?" -- the registry has no probe block; the tool
    // defaults to GET, which matches the live verified behavior.
    hasProbe: false,
    schemaUrl: undefined,
    body: {
      version: "2.0",
      updated: "2026-07-21T07:42:05.321Z",
      providers: [
        { id: "cmnc8yq7x0000snn8oehdmm2i", name: "Community-Targon" },
      ],
      count: 1,
      onlineCount: 1,
    },
    assertBody: (b) => {
      assert.equal(b.version, "2.0");
      assert.ok(Array.isArray(b.providers));
      assert.equal(typeof b.providers[0].name, "string");
      assert.equal(typeof b.count, "number");
    },
  },
  {
    id: "sn-58-handshake58-directory-providers",
    url: "https://handshake58.com/api/directory/providers",
    hasProbe: true,
    schemaUrl: undefined,
    // Minimal fixture (live body is ~274 KB and over the tool cap).
    body: {
      success: true,
      providers: [
        {
          id: "cmlifn7ej000014mirsdbroyx",
          name: "Miner 5",
          apiUrl: "https://example.railway.app",
        },
      ],
      count: 1,
    },
    assertBody: (b) => {
      assert.equal(b.success, true);
      assert.ok(Array.isArray(b.providers));
      assert.equal(typeof b.providers[0].name, "string");
      assert.equal(typeof b.count, "number");
    },
  },
];

describe("SN58 Handshake58 call_subnet_surface verification (#7071)", () => {
  for (const fixture of HEAD_SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface is callable via HEAD`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // Live HEAD returns 200 application/json; pin the declared method.
      assert.equal(SURFACE.probe?.method, "HEAD");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, fixture.url);
      assert.equal(SURFACE.schema_url, fixture.schemaUrl);
    });

    test(`${fixture.id}: callSubnetSurface issues HEAD and returns ok without a body`, async () => {
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
      assert.equal(result.content_type, "application/json");
      // HEAD responses have no body; the tool returns an empty string.
      assert.equal(result.body, "");
      assert.equal(result.truncated, false);
    });

    test(`${fixture.id}: end-to-end MCP tools/call uses HEAD by surface id`, async () => {
      let requestedMethod;
      const originalFetch = globalThis.fetch;
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
      };
      const deps = {
        readArtifact: async (_env, path) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        requestedMethod = init?.method;
        return headJsonResponse();
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
        assert.equal(requestedMethod, "HEAD");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  for (const fixture of GET_SURFACES) {
    const SURFACE = surfaceOf(fixture.id);

    test(`${fixture.id}: registry surface is callable via GET`, () => {
      assert.ok(SURFACE, `registry surface ${fixture.id} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.url, fixture.url);
      assert.equal(SURFACE.schema_url, fixture.schemaUrl);
      if (fixture.hasProbe) {
        assert.equal(SURFACE.probe?.enabled, true);
        assert.equal(SURFACE.probe?.method, "GET");
        assert.equal(SURFACE.probe?.expect, "json");
      } else {
        // Validator registry has no probe block; tool defaults to GET.
        assert.equal(SURFACE.probe, undefined);
      }
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body using GET`, async () => {
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
      const result = await callToolWithSurface(SURFACE, () =>
        jsonResponse(fixture.body),
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, fixture.id);
      assert.equal(result.structuredContent.status_code, 200);
      fixture.assertBody(result.structuredContent.body);
    });
  }

  describe("sn-58-handshake58-openapi (direct-call only, HEAD)", () => {
    const SURFACE = surfaceOf("sn-58-handshake58-openapi");

    test("registry surface exists, is no-auth HEAD, and carries its captured schema", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-58-handshake58-openapi is present",
      );
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "HEAD");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://handshake58.com/openapi.json");
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://handshake58.com/openapi.json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface issues HEAD against the schema URL and returns ok", async () => {
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
      assert.equal(result.content_type, "application/json");
      assert.equal(result.body, "");
    });
  });
});
