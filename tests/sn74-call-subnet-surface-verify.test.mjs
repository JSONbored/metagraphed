// SN74 (Gittensor) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7087, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN74's *real* registry surface configs
// (registry/subnets/gittensor.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking one
// auth_required, disabling a probe) is caught here.
//
// All five surfaces listed in #7087 were verified live on 2026-07-20 against
// their exact catalogued URLs:
//   gittensory-mcp               POST https://api.loopover.ai/mcp             -> HTTP 401 application/json {"error":"unauthorized"}
//                                (anonymous GET returns the same 401 body; auth_required:true is correct)
//   gittensory-mcp-compatibility GET  https://api.loopover.ai/v1/mcp/compatibility -> HTTP 200 application/json
//                                {status, service, apiVersion, mcp, compatibilityWarnings, breakingChanges, generatedAt}
//   sn-74-gittensor-openapi      GET  https://api.gittensor.io/swagger-json   -> HTTP 200 application/json,
//                                OpenAPI 3.0.0 object (paths, info, tags, servers, components), ~15 KB
//   sn-74-gittensor-subnet-api   GET  https://api.gittensor.io/miners         -> HTTP 200 application/json,
//                                array of 168 miner records ({uid, hotkey, githubUsername, ...}), ~175 KB
//   sn-74-gittensor-health       GET  https://api.gittensor.io/               -> HTTP 200 text/html; charset=utf-8,
//                                12-byte plain body "Hello World!"
// The fixtures below mirror each live response's shape rather than fetching
// it, keeping the test hermetic while still exercising the JSON
// parse-and-return, non-JSON text, and auth_required-rejection paths against
// each upstream's actual observed behavior. (Miner lists and version info are
// live data, so the tests assert the stable shape, not exact contents.)
//
// Note on sn-74-gittensor-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7087, a
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

const NETUID = 74;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/gittensor.json", import.meta.url),
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

// Builds the operational-surfaces.json catalog shape from a real registry
// surface (the artifact flattens each surface's `id` to a top-level
// `surface_id`) and calls the tool through the real JSON-RPC path.
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

describe("SN74 Gittensor call_subnet_surface verification (#7087)", () => {
  describe("gittensory-mcp-compatibility", () => {
    const SURFACE = surfaceOf("gittensory-mcp-compatibility");
    // Faithful subset of the live response's top-level shape.
    const BODY = {
      status: "ok",
      service: "loopover-api",
      apiVersion: "0.1.0",
      mcp: { packageName: "@loopover/mcp" },
      compatibilityWarnings: [],
      breakingChanges: [],
      generatedAt: "2026-07-20T00:00:00.000Z",
    };

    test("registry surface exists and is configured to be callable", () => {
      assert.ok(
        SURFACE,
        "registry surface gittensory-mcp-compatibility is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // No-auth GET returning JSON.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, "https://api.loopover.ai/v1/mcp/compatibility");
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
      assert.equal(result.body.status, "ok");
      assert.equal(result.body.service, "loopover-api");
      assert.equal(typeof result.body.mcp.packageName, "string");
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const result = await callToolWithSurface(SURFACE, () =>
        jsonResponse(BODY),
      );
      assert.equal(result.isError, false);
      assert.equal(
        result.structuredContent.surface_id,
        "gittensory-mcp-compatibility",
      );
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.status, "ok");
    });
  });

  describe("sn-74-gittensor-subnet-api (miners)", () => {
    const SURFACE = surfaceOf("sn-74-gittensor-subnet-api");
    // Faithful subset of the live response: a JSON array of miner records.
    const BODY = [
      {
        uid: 64,
        hotkey: "5HBY7Hm6L4mMhPq9zzGZXDpcNEDKAdkDZuknnp8wbRac3ghS",
        githubUsername: "minion1227",
      },
    ];

    test("registry surface exists and is configured to be callable", () => {
      assert.ok(
        SURFACE,
        "registry surface sn-74-gittensor-subnet-api is present",
      );
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.url, "https://api.gittensor.io/miners");
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the real JSON array body using the surface's own url + GET", async () => {
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
      // Live miner list -- assert the stable record shape, not exact contents.
      assert.ok(Array.isArray(result.body));
      assert.equal(typeof result.body[0].uid, "number");
      assert.equal(typeof result.body[0].hotkey, "string");
      assert.equal(typeof result.body[0].githubUsername, "string");
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const result = await callToolWithSurface(SURFACE, () =>
        jsonResponse(BODY),
      );
      assert.equal(result.isError, false);
      assert.equal(
        result.structuredContent.surface_id,
        "sn-74-gittensor-subnet-api",
      );
      assert.equal(result.structuredContent.status_code, 200);
      assert.ok(Array.isArray(result.structuredContent.body));
    });
  });

  describe("sn-74-gittensor-health (API root)", () => {
    const SURFACE = surfaceOf("sn-74-gittensor-health");
    // The live root returns a plain 12-byte text body, not JSON.
    const LIVE_TEXT = "Hello World!";

    function healthResponse() {
      return new Response(LIVE_TEXT, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    test("registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, "registry surface sn-74-gittensor-health is present");
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      // The live body is text/html, so the non-JSON "any" expectation is
      // deliberate -- pin it so nobody "fixes" it to json and breaks probes.
      assert.equal(SURFACE.probe?.expect, "any");
      assert.equal(SURFACE.url, "https://api.gittensor.io/");
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the plain-text body uncapped and unparsed", async () => {
      let requestedUrl;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url) => {
          requestedUrl = String(url);
          return healthResponse();
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "text/html; charset=utf-8");
      assert.equal(result.truncated, false);
      // Text path: returned as the raw string, no JSON parse attempted.
      assert.equal(result.body, LIVE_TEXT);
      assert.equal(result.parse_error, undefined);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const result = await callToolWithSurface(SURFACE, healthResponse);
      assert.equal(result.isError, false);
      assert.equal(
        result.structuredContent.surface_id,
        "sn-74-gittensor-health",
      );
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body, LIVE_TEXT);
    });
  });

  describe("sn-74-gittensor-openapi (direct-call only)", () => {
    const SURFACE = surfaceOf("sn-74-gittensor-openapi");
    // Faithful subset of the live swagger-json response's top-level shape.
    const BODY = {
      openapi: "3.0.0",
      paths: { "/": { get: { operationId: "AppController_getHello" } } },
      info: { title: "Gittensor API" },
      components: {},
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(SURFACE, "registry surface sn-74-gittensor-openapi is present");
      assert.equal(SURFACE.kind, "openapi");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.url, "https://api.gittensor.io/swagger-json");
      // #7087 says this surface has a captured schema; pin that linkage.
      assert.equal(SURFACE.schema_status, "machine-readable");
      assert.equal(SURFACE.schema_url, "https://api.gittensor.io/swagger-json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      // Documents WHY there is no MCP-tool-path test for this surface: the
      // operational catalog the tool resolves from only includes these kinds.
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the OpenAPI 3.0 document as parsed JSON", async () => {
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
      assert.equal(result.body.openapi, "3.0.0");
      assert.equal(
        result.body.paths["/"].get.operationId,
        "AppController_getHello",
      );
    });
  });

  describe("gittensory-mcp (auth required -- Phase 3 territory)", () => {
    const SURFACE = surfaceOf("gittensory-mcp");

    test("registry surface exists and correctly declares custom auth", () => {
      assert.ok(SURFACE, "registry surface gittensory-mcp is present");
      assert.equal(SURFACE.kind, "subnet-api");
      // Live-confirmed: anonymous GET and JSON-RPC POST both return HTTP 401
      // {"error":"unauthorized"}, so auth_required:true matches reality.
      assert.equal(SURFACE.auth_required, true);
      assert.equal(SURFACE.auth?.scheme, "custom");
      // POST-only JSON-RPC endpoint; recurring read probes stay disabled.
      assert.equal(SURFACE.probe?.enabled, false);
      assert.equal(SURFACE.url, "https://api.loopover.ai/mcp");
    });

    test("the call_subnet_surface MCP tool rejects it outright without fetching upstream", async () => {
      // In production this surface never even reaches the auth gate: the
      // operational catalog filters out probe.enabled:false surfaces, so the
      // tool answers not_found. This test injects the real registry config
      // into a catalog fixture to pin the earlier line of defense: even if it
      // were resolvable, auth_required:true blocks the call before any fetch.
      let upstreamFetched = false;
      const result = await callToolWithSurface(SURFACE, () => {
        upstreamFetched = true;
        return jsonResponse({});
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /auth_required/);
      assert.equal(upstreamFetched, false);
    });
  });
});
