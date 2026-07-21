// SN98 (ForeverMoney) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7110, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN98's real registry surfaces
// (registry/subnets/forevermoney.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking them
// auth_required, disabling their probe) is caught here.
//
// All five live-verified 2026-07-21:
//   - sn-98-forevermoney-vaults-tvl-api GET
//     https://dashboard.forevermoney.ai/api/vaults/tvl
//     -> HTTP 502 application/json; charset=utf-8 Cloudflare Bad Gateway JSON
//        ({type,title,status:502,error_code:502,error_name:"origin_bad_gateway",
//         cloudflare_error:true,retryable:true, ...}) — same outage already
//         tracked in curation.gap_notes; the tool is a passthrough and returns
//         that status + body rather than inventing success (SN70 precedent).
//   - sn-98-forevermoney-min-compute-spec GET
//     raw.githubusercontent.com/.../min_compute.yml
//     -> 200 text/plain; charset=utf-8 YAML (starts with "version: '1.0'").
//   - sn-98-forevermoney-liquidity-manager-abi GET
//     raw.githubusercontent.com/.../LiquidityManager.json
//     -> 200 text/plain; charset=utf-8. NB the payload is JSON but raw.github
//     serves it as text/plain, so the tool returns it as an unparsed STRING.
//   - sn-98-forevermoney-website HEAD https://forevermoney.ai/ -> 200 text/html
//   - sn-98-forevermoney-source  HEAD github.com/SN98-ForeverMoney/forever-money
//     -> 200 text/html
// subnet-api + data-artifact are in OPERATIONAL_SURFACE_KINDS and are exercised
// end-to-end through the MCP tool; website/source-repo are not, so they are
// verified direct-call only (matching the SN113/SN87 precedent).
// Fixtures below mirror the live responses (ABI trimmed), keeping the test
// hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 98;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/forevermoney.json", import.meta.url),
    ),
    "utf8",
  ),
);
const surfaceById = (id) => registry.surfaces.find((s) => s.id === id);

function upstreamResponse(spec) {
  return new Response(spec.method === "HEAD" ? null : spec.rawBody, {
    status: spec.status,
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

// Faithful copy of the live Cloudflare 502 Bad Gateway JSON shape observed
// 2026-07-21 on dashboard.forevermoney.ai/api/vaults/tvl (volatile
// ray_id/timestamp/instance omit).
const CF_502_BODY = {
  type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/",
  title: "Error 502: Bad gateway",
  status: 502,
  error_code: 502,
  error_name: "origin_bad_gateway",
  cloudflare_error: true,
  retryable: true,
};

const MIN_COMPUTE_TXT =
  "version: '1.0'\n\ncompute_spec:\n\n  miner:\n\n    cpu:\n      min_cores: 2\n";

// Served as text/plain by raw.githubusercontent, so the tool returns the raw
// string -- kept verbatim here rather than as an object for that reason.
const ABI_TXT =
  '{"abi":[{"type":"constructor","inputs":[{"name":"initialOwner","type":"address","internalType":"address"}],"stateMutability":"nonpayable"}]}\n';

const SURFACES = [
  {
    id: "sn-98-forevermoney-vaults-tvl-api",
    kind: "subnet-api",
    operational: true,
    url: "https://dashboard.forevermoney.ai/api/vaults/tvl",
    method: "GET",
    status: 502,
    contentType: "application/json; charset=utf-8",
    rawBody: JSON.stringify(CF_502_BODY),
    expectedBody: CF_502_BODY,
  },
  {
    id: "sn-98-forevermoney-min-compute-spec",
    kind: "data-artifact",
    operational: true,
    url: "https://raw.githubusercontent.com/SN98-ForeverMoney/forever-money/main/min_compute.yml",
    method: "GET",
    status: 200,
    contentType: "text/plain; charset=utf-8",
    rawBody: MIN_COMPUTE_TXT,
    expectedBody: MIN_COMPUTE_TXT,
  },
  {
    id: "sn-98-forevermoney-liquidity-manager-abi",
    kind: "data-artifact",
    operational: true,
    url: "https://raw.githubusercontent.com/SN98-ForeverMoney/forever-money/7acfc5422a4e1714670275bf8dc2b32c1f815756/validator/utils/abis/LiquidityManager.json",
    method: "GET",
    status: 200,
    contentType: "text/plain; charset=utf-8",
    rawBody: ABI_TXT,
    expectedBody: ABI_TXT,
  },
  {
    id: "sn-98-forevermoney-website",
    kind: "website",
    operational: false,
    url: "https://forevermoney.ai/",
    method: "HEAD",
    status: 200,
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-98-forevermoney-source",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/SN98-ForeverMoney/forever-money",
    method: "HEAD",
    status: 200,
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN98 ForeverMoney ${spec.id} call_subnet_surface verification (#7110)`, () => {
    const SURFACE = surfaceById(spec.id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${spec.id} is present`);
      assert.equal(SURFACE.kind, spec.kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.url, spec.url);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, spec.method);
    });

    test(`callSubnetSurface issues a ${spec.method} to the surface's own url and returns the live status/body`, async () => {
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
      // Passthrough: network/fetch succeeded; non-2xx (e.g. live TVL 502) is
      // surfaced as status_code + body, not as tool-level ok:false.
      assert.equal(result.ok, true);
      // The tool resolves the surface url through URL(), which normalizes it.
      assert.equal(requestedUrl, new URL(SURFACE.url).toString());
      assert.equal(requestedMethod, spec.method);
      assert.equal(result.status_code, spec.status);
      assert.equal(result.content_type, spec.contentType);
      assert.equal(result.truncated, false);
      if (spec.contentType.startsWith("application/json")) {
        assert.deepEqual(result.body, spec.expectedBody);
      } else {
        // Non-JSON content-type -> unparsed string, even when (as with the
        // LiquidityManager ABI) the payload itself happens to be JSON.
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
        assert.equal(result.structuredContent.status_code, spec.status);
        assert.deepEqual(result.structuredContent.body, spec.expectedBody);
      });
    } else {
      test("kind is not an operational kind, so this surface is direct-call verified only", () => {
        // Documents WHY there is no MCP-tool-path test for this surface: the
        // operational catalog the tool resolves surface_id from only includes
        // OPERATIONAL_SURFACE_KINDS, which excludes website/source-repo.
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
