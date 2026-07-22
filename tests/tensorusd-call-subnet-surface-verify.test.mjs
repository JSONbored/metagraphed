// SN113 (TensorUSD) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7124, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN113's real registry surfaces
// (registry/subnets/tensorusd.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking them auth_required,
// disabling their probe) is caught here.
//
// All seven live-verified 2026-07-21:
//   - sn-113-tensorusd-subnet-api       GET https://api.tensorusd.com/health ->
//     200 application/json {"status":"healthy","components":{...},"system":{...}}
//   - sn-113-tensorusd-agent-api-health GET https://agent-api.tensorusd.com/health
//     -> 200 application/json {"success":true,"data":{"status":"ok","env":"prod"}}
//   - sn-113-tensorusd-vault-abi        GET raw.githubusercontent .../abis/tusdt_vault.json
//     -> 200 text/plain; charset=utf-8. NB the payload is JSON but raw.github
//     serves it as text/plain, so the tool returns it as an unparsed STRING.
//   - sn-113-tensorusd-llms-txt         GET https://docs.tensorusd.com/llms.txt ->
//     200 text/markdown; charset=utf-8 -> also returned as an unparsed string.
//   - sn-113-tensorusd-website HEAD https://tensorusd.com/                  -> 200 text/html
//   - sn-113-tensorusd-docs    HEAD https://docs.tensorusd.com/components/subnet -> 200 text/html
//   - sn-113-tensorusd-source  HEAD https://github.com/TensorUSD/subnet      -> 200 text/html
// subnet-api + data-artifact are in OPERATIONAL_SURFACE_KINDS and are exercised
// end-to-end through the MCP tool; website/docs/source-repo are not, so they are
// verified direct-call only (matching the SN87/SN85 precedent).
// Fixtures below mirror the live responses (the vault ABI is trimmed), keeping
// the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 113;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/tensorusd.json", import.meta.url),
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
  status: "healthy",
  components: { database: { connected: true, state: "connected" } },
  system: { uptime: 1218652 },
};

const AGENT_HEALTH = {
  success: true,
  data: { status: "ok", env: "prod" },
};

// Served as text/plain by raw.githubusercontent, so the tool returns the raw
// string -- kept verbatim here rather than as an object for that reason.
const VAULT_ABI_TEXT =
  '{\n  "source": {\n    "hash": "0xa135116bbbf8fc61ee0777817b706c4960f444c9df80724643bc7d335f60434c",\n    "language": "ink!"\n  }\n}\n';

const LLMS_TXT = "# TensorUSD\n\n## TensorUSD\n\n- [Introduction: TensorUSD]\n";

const SURFACES = [
  {
    id: "sn-113-tensorusd-subnet-api",
    kind: "subnet-api",
    operational: true,
    url: "https://api.tensorusd.com/health",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(HEALTH),
    expectedBody: HEALTH,
  },
  {
    id: "sn-113-tensorusd-agent-api-health",
    kind: "subnet-api",
    operational: true,
    url: "https://agent-api.tensorusd.com/health",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(AGENT_HEALTH),
    expectedBody: AGENT_HEALTH,
  },
  {
    id: "sn-113-tensorusd-vault-abi",
    kind: "data-artifact",
    operational: true,
    url: "https://raw.githubusercontent.com/TensorUSD/subnet/main/tensorusd/common/abis/tusdt_vault.json",
    method: "GET",
    contentType: "text/plain; charset=utf-8",
    rawBody: VAULT_ABI_TEXT,
    expectedBody: VAULT_ABI_TEXT,
  },
  {
    id: "sn-113-tensorusd-llms-txt",
    kind: "data-artifact",
    operational: true,
    url: "https://docs.tensorusd.com/llms.txt",
    method: "GET",
    contentType: "text/markdown; charset=utf-8",
    rawBody: LLMS_TXT,
    expectedBody: LLMS_TXT,
  },
  {
    id: "sn-113-tensorusd-website",
    kind: "website",
    operational: false,
    url: "https://tensorusd.com/",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-113-tensorusd-docs",
    kind: "docs",
    operational: false,
    url: "https://docs.tensorusd.com/components/subnet",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-113-tensorusd-source",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/TensorUSD/subnet",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN113 TensorUSD ${spec.id} call_subnet_surface verification (#7124)`, () => {
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
        // Non-JSON content-type -> unparsed string, even when (as with the vault
        // ABI) the payload itself happens to be JSON.
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
        // OPERATIONAL_SURFACE_KINDS, which excludes website/docs/source-repo.
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
