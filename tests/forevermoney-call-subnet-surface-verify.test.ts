// SN98 (ForeverMoney) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7110, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN98's real registry surfaces
// (registry/subnets/forevermoney.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking them
// auth_required, disabling their probe) is caught here.
//
// Live-verified 2026-07-21:
//   - sn-98-forevermoney-min-compute-spec  GET raw.githubusercontent .../min_compute.yml
//     -> 200 text/plain; charset=utf-8 (YAML hardware spec)
//   - sn-98-forevermoney-liquidity-manager-abi GET raw.githubusercontent .../LiquidityManager.json
//     -> 200 text/plain; charset=utf-8 (JSON ABI served as text/plain, so the tool
//     returns the raw STRING, matching the TensorUSD vault-ABI precedent)
//   - sn-98-forevermoney-vaults-tvl-api GET dashboard.forevermoney.ai/api/vaults/tvl
//     -> HTTP 502 (Cloudflare bad gateway) -- still the backend-specific outage
//     already tracked in curation.gap_notes; registry config assertions only below
//   - website / source-repo HEAD forevermoney.ai + github.com/... -> 200
// subnet-api + data-artifact are in OPERATIONAL_SURFACE_KINDS; website/source-repo
// are direct-call verified only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
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
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 0 }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    return upstreamResponse(spec);
  }) as typeof fetch;
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
      mockEnv(),
      deps,
    );
    return ((await httpResponse.json()) as Row).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const MIN_COMPUTE_TEXT =
  'version: \'1.0\'\n\ncompute_spec:\n\n  miner:\n\n    cpu:\n      min_cores: 2            # Minimum number of CPU cores\n      min_speed: 2.0          # Minimum speed per core (GHz)\n      recommended_cores: 4    # Recommended number of CPU cores\n      recommended_speed: 2.5  # Recommended speed per core (GHz)\n      architecture: "x86_64"  # Architecture type (e.g., x86_64, arm64)\n\n    gpu:\n      required: False         # Does the application require a GPU?\n\n    memory:\n      min_ram: 4           # Minimum RAM (GB)\n      min_swap: 4          # Minimum swap space (GB)\n      recommended_swap: 8  # Recommended swap space (GB)\n      ram_type: "DDR4"     # RAM type (e.g., DDR4, DDR3, etc.)\n\n    storage:\n      min_space: 10           # Minimum free storage space (GB)\n      recommended_space: 20  # Recommended free storage space (GB)\n\n  validator:\n\n    cpu:\n      min_cores: 4            # Minimum number of CPU cores\n      min_speed: 2.0          # Minimum speed per core (GHz)\n      recommended_cores: 8    # Recommended number of CPU cores\n      recommended_speed: 2.5  # Recommended speed per core (GHz)\n      architecture: "x86_64"  # Architecture type (e.g., x86_64, arm64)\n\n    gpu:\n      required: False         # Does the application require a GPU?\n\n    memory:\n      min_ram: 8          # Minimum RAM (GB)\n      min_swap: 4          # Minimum swap space (GB)\n      recommended_swap: 8  # Recommended swap space (GB)\n      ram_type: "DDR4"     # RAM type (e.g., DDR4, DDR3, etc.)\n\n    storage:\n      min_space: 40           # Minimum free storage space (GB)\n      recommended_space: 80  # Recommended free storage space (GB)\n\nnetwork_spec:\n  bandwidth:\n    download: 100  # Minimum download bandwidth (Mbps)\n    upload: 20     # Minimum upload bandwidth (Mbps)\n';

// Served as text/plain by raw.githubusercontent, so the tool returns the raw
// string -- trimmed fixture (full live body is ~132 KiB).
const ABI_TEXT =
  '{"abi":[{"type":"constructor","inputs":[{"name":"initialOwner","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},{"type":"function","n\n';

const SURFACES = [
  {
    id: "sn-98-forevermoney-min-compute-spec",
    kind: "data-artifact",
    operational: true,
    url: "https://raw.githubusercontent.com/SN98-ForeverMoney/forever-money/main/min_compute.yml",
    method: "GET",
    contentType: "text/plain; charset=utf-8",
    rawBody: MIN_COMPUTE_TEXT,
    expectedBody: MIN_COMPUTE_TEXT,
  },
  {
    id: "sn-98-forevermoney-liquidity-manager-abi",
    kind: "data-artifact",
    operational: true,
    url: "https://raw.githubusercontent.com/SN98-ForeverMoney/forever-money/7acfc5422a4e1714670275bf8dc2b32c1f815756/validator/utils/abis/LiquidityManager.json",
    method: "GET",
    contentType: "text/plain; charset=utf-8",
    rawBody: ABI_TEXT,
    expectedBody: ABI_TEXT,
  },
  {
    id: "sn-98-forevermoney-website",
    kind: "website",
    operational: false,
    url: "https://forevermoney.ai/",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-98-forevermoney-source",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/SN98-ForeverMoney/forever-money",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
];

describe("SN98 ForeverMoney vaults-tvl-api live status (#7110)", () => {
  const SURFACE = surfaceById("sn-98-forevermoney-vaults-tvl-api");

  test("the registry surface exists and stays probe-enabled despite the live 502", () => {
    assert.ok(
      SURFACE,
      "registry surface sn-98-forevermoney-vaults-tvl-api is present",
    );
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(
      SURFACE.url,
      "https://dashboard.forevermoney.ai/api/vaults/tvl",
    );
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    // Live 2026-07-21: GET url still returns HTTP 502 (Cloudflare bad gateway)
    // while the dashboard host itself is live — matches curation.gap_notes.
  });
});

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

    test(`callSubnetSurface issues a ${spec.method} to the surface's own url and returns the body`, async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return upstreamResponse(spec);
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, new URL(SURFACE.url).toString());
      assert.equal(requestedMethod, spec.method);
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, spec.contentType);
      assert.equal(result.truncated, false);
      if (spec.contentType.startsWith("application/json")) {
        assert.deepEqual(result.body, spec.expectedBody);
      } else {
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
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
