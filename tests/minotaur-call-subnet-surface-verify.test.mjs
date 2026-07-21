// SN112 (minotaur) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7123, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN112's real registry surfaces
// (registry/subnets/minotaur.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking them auth_required,
// disabling their probe) is caught here.
//
// All seven live-verified 2026-07-21:
//   - sn-112-minotaur-health     GET /health   -> 200 application/json
//     {"status":"ok","service":"app-intents-api",...}
//   - sn-112-minotaur-chains     GET /v1/chains -> 200 application/json
//     {"chains":[...],"total":3}
//   - sn-112-minotaur-apps-list  GET /v1/apps/  -> 200 application/json
//     {"apps":[...],"total":N,"catalog_fingerprint":"..."}
//   - sn-112-minotaur-network-reference GET raw.githubusercontent .../network-reference.md
//     -> 200 text/plain; charset=utf-8 (markdown served as plain text, so the
//     tool returns the body as an unparsed string).
//   - sn-112-minotaur-app-dashboard HEAD https://app.minotaursubnet.com -> 200 text/html
//   - sn-112-minotaur-website       HEAD https://minotaursubnet.com/    -> 200 text/html
//   - sn-112-minotaur-source-repo   HEAD .../subnet112/minotaur_subnet  -> 200 text/html
// The subnet-api + data-artifact kinds are in OPERATIONAL_SURFACE_KINDS and are
// exercised end-to-end through the MCP tool; dashboard/website/source-repo are
// not, so they are verified direct-call only (matching the SN87/SN85 precedent).
// Fixtures below mirror the live responses (the apps row's very large js_code
// field is elided), keeping the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 112;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/minotaur.json", import.meta.url),
    ),
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

const HEALTH = {
  status: "ok",
  service: "app-intents-api",
  image_sha: "345e48f",
  benchmark_worker: "disabled",
  solver_round_coordinator: "running",
  solver_round_role: "leader",
};

const CHAINS = {
  chains: [
    {
      chain_id: 1,
      name: "Ethereum",
      rpc_available: true,
      registry_address: "0x694F0a95D3105EcC2ad86FcaFAa1A4467F1852A6",
      app_registry_address: "0xbA70eA9857c3813A694f6CA71Fa98eA6E584dF1B",
    },
  ],
  total: 3,
};

const APPS = {
  apps: [
    {
      app_id: "app_0867cdd4effd",
      name: "DEX Aggregator V2",
      version: "1.0.0",
      intent_type: "",
    },
  ],
  total: 1,
  catalog_fingerprint: "b6f1c0a2",
};

const NETWORK_REFERENCE_MD =
  "# Network Reference — Subnet 112\n\nSingle source of truth for operator-facing addresses and endpoints.\n";

const SURFACES = [
  {
    id: "sn-112-minotaur-health",
    kind: "subnet-api",
    operational: true,
    url: "https://api.minotaursubnet.com/health",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(HEALTH),
    expectedBody: HEALTH,
  },
  {
    id: "sn-112-minotaur-chains",
    kind: "data-artifact",
    operational: true,
    url: "https://api.minotaursubnet.com/v1/chains",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(CHAINS),
    expectedBody: CHAINS,
  },
  {
    id: "sn-112-minotaur-apps-list",
    kind: "subnet-api",
    operational: true,
    url: "https://api.minotaursubnet.com/v1/apps/",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(APPS),
    expectedBody: APPS,
  },
  {
    id: "sn-112-minotaur-network-reference",
    kind: "data-artifact",
    operational: true,
    url: "https://raw.githubusercontent.com/subnet112/minotaur_subnet/develop/docs/operator/network-reference.md",
    method: "GET",
    contentType: "text/plain; charset=utf-8",
    rawBody: NETWORK_REFERENCE_MD,
    expectedBody: NETWORK_REFERENCE_MD,
  },
  {
    id: "sn-112-minotaur-app-dashboard",
    kind: "dashboard",
    operational: false,
    url: "https://app.minotaursubnet.com",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-112-minotaur-website",
    kind: "website",
    operational: false,
    url: "https://minotaursubnet.com/",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-112-minotaur-source-repo",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/subnet112/minotaur_subnet",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN112 minotaur ${spec.id} call_subnet_surface verification (#7123)`, () => {
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
      // The tool resolves the surface url through URL(), which normalizes it --
      // a bare origin like https://app.minotaursubnet.com gains a trailing slash.
      assert.equal(requestedUrl, new URL(SURFACE.url).toString());
      assert.equal(requestedMethod, spec.method);
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, spec.contentType);
      assert.equal(result.truncated, false);
      if (spec.contentType.startsWith("application/json")) {
        // JSON content-type -> body parsed into an object.
        assert.deepEqual(result.body, spec.expectedBody);
      } else {
        // Non-JSON content-type (markdown served as text/plain, HEAD) -> the
        // body is returned as an unparsed string.
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
