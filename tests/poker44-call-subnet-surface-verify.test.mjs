// SN126 (Poker44) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7134, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN126's real registry surfaces
// (registry/subnets/poker44.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking them auth_required,
// disabling their probe) is caught here.
//
// All live-verified 2026-07-21:
//   - sn-126-poker44-health            GET https://api.poker44.net/health ->
//     200 application/json {"success":true,"data":{"status":"healthy",...}}
//   - sn-126-poker44-data-artifact     GET .../api/v1/benchmark -> 200
//     application/json {"success":true,"data":{"releaseVersion":"v1.13",...}}
//   - sn-126-poker44-benchmark-releases GET .../api/v1/benchmark/releases ->
//     200 application/json {"success":true,"data":{"releases":[...]}}
//   - sn-126-poker44-benchmark-chunks  GET .../api/v1/benchmark/chunks -> the
//     bare URL is 422 (needs a sourceDate); with the tool's `query` argument
//     GET .../chunks?sourceDate=2026-07-21&limit=1 -> 200 application/json
//     {"success":true,"data":{"chunks":[...]}}. This is the additional surface
//     newly in scope per #7134; probe.enabled is false because the bare URL is
//     not health-probeable, so it gets its own block below (not the shared loop).
//   - sn-126-poker44-dashboard  HEAD https://poker44.net/dashboard -> 200 text/html
//   - sn-126-poker44-website    HEAD https://poker44.net/           -> 200 text/html
//   - sn-126-poker44-source     HEAD https://github.com/Poker44/Poker44-subnet -> 200 text/html
//   - sn-126-poker44-whitepaper HEAD https://poker44.net/Poker44_Whitepaper.pdf -> 200 application/pdf
// subnet-api + data-artifact are in OPERATIONAL_SURFACE_KINDS and are exercised
// end-to-end through the MCP tool; dashboard/website/source-repo/docs are not, so
// they are verified direct-call only (matching the SN113/SN112 precedent).
// The chunk-by-id route (GET /api/v1/benchmark/chunks/{chunkId}, also live-
// verified 2026-07-21) is path-parameterized: it has no fixed callable URL and
// so cannot be registered as a Surface (the schema requires a concrete uri), the
// same way SN112's /v1/apps/{app_id}/status route was left unregistered.
// Fixtures below mirror the live responses (trimmed), keeping the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 126;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/poker44.json", import.meta.url)),
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
  success: true,
  data: {
    status: "healthy",
    services: {
      database: { status: "connected", latency: 87 },
      redis: { status: "connected", latency: 45 },
    },
  },
};

const BENCHMARK = {
  success: true,
  data: {
    releaseVersion: "v1.13",
    schemaVersion: "shadow-training-v1",
    releaseType: "training",
    totalChunks: 383,
    totalHands: 99680,
    latestSourceDate: "2026-07-21",
  },
};

const RELEASES = {
  success: true,
  data: {
    releaseVersion: "v1.13",
    releases: [
      {
        releaseId: "e42a6250-38a0-4d28-bdb9-638deed96f96",
        sourceDate: "2026-07-21",
        chunkCount: 21,
        handCount: 5000,
      },
    ],
  },
};

const CHUNKS = {
  success: true,
  data: {
    sourceDate: "2026-07-21",
    releaseVersion: "v1.13",
    nextCursor: "069386f8-998f-4437-9402-2a4ea6e520a0",
    chunks: [
      {
        chunkId: "069386f8-998f-4437-9402-2a4ea6e520a0",
        chunkHash:
          "59a5e57ec62cc4d0f6e8eaf6bea9f73d9de849859fe025d111c033314f5f5758",
        chunkIndex: 1,
        sourceDate: "2026-07-21",
      },
    ],
  },
};

const SURFACES = [
  {
    id: "sn-126-poker44-health",
    kind: "subnet-api",
    operational: true,
    url: "https://api.poker44.net/health",
    method: "GET",
    contentType: "application/json; charset=utf-8",
    rawBody: JSON.stringify(HEALTH),
    expectedBody: HEALTH,
  },
  {
    id: "sn-126-poker44-data-artifact",
    kind: "data-artifact",
    operational: true,
    url: "https://api.poker44.net/api/v1/benchmark",
    method: "GET",
    contentType: "application/json; charset=utf-8",
    rawBody: JSON.stringify(BENCHMARK),
    expectedBody: BENCHMARK,
  },
  {
    id: "sn-126-poker44-benchmark-releases",
    kind: "data-artifact",
    operational: true,
    url: "https://api.poker44.net/api/v1/benchmark/releases",
    method: "GET",
    contentType: "application/json; charset=utf-8",
    rawBody: JSON.stringify(RELEASES),
    expectedBody: RELEASES,
  },
  {
    id: "sn-126-poker44-dashboard",
    kind: "dashboard",
    operational: false,
    url: "https://poker44.net/dashboard",
    method: "HEAD",
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-126-poker44-website",
    kind: "website",
    operational: false,
    url: "https://poker44.net/",
    method: "HEAD",
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-126-poker44-source",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/Poker44/Poker44-subnet",
    method: "HEAD",
    contentType: "text/html; charset=utf-8",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-126-poker44-whitepaper",
    kind: "docs",
    operational: false,
    // application/pdf classifies as "binary" in call-subnet-surface, so the tool
    // refuses to return its body -- ok:false with an "unsupported content-type"
    // error. That is the correct, honest behavior for a PDF surface; asserted
    // via the `binary` branch below rather than the string-body branch.
    binary: true,
    url: "https://poker44.net/Poker44_Whitepaper.pdf",
    method: "HEAD",
    contentType: "application/pdf",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN126 Poker44 ${spec.id} call_subnet_surface verification (#7134)`, () => {
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
      // The tool resolves the surface url through URL(), which normalizes it.
      assert.equal(requestedUrl, new URL(SURFACE.url).toString());
      assert.equal(requestedMethod, spec.method);
      if (spec.binary) {
        // A binary content-type (application/pdf) is rejected: the tool never
        // returns a binary body, only an error naming the content-type.
        assert.equal(result.ok, false);
        assert.equal(result.status_code, 200);
        assert.equal(result.content_type, spec.contentType);
        assert.match(result.error, /unsupported content-type/);
        return;
      }
      assert.equal(result.ok, true);
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
        // OPERATIONAL_SURFACE_KINDS, which excludes dashboard/website/source-repo/docs.
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}

// The benchmark-chunks surface is the additional one newly in scope per #7134.
// It differs from the loop above: its bare URL is not health-probeable (needs a
// sourceDate query param -> the bare URL is HTTP 422 live), so probe.enabled is
// false and it is callable only with the tool's `query` argument. This block
// pins that behavior explicitly.
describe("SN126 Poker44 sn-126-poker44-benchmark-chunks call_subnet_surface verification (#7134)", () => {
  const SURFACE = surfaceById("sn-126-poker44-benchmark-chunks");
  const CONTENT_TYPE = "application/json; charset=utf-8";

  test("the registry surface exists and is a query-param data-artifact (probe disabled)", () => {
    assert.ok(
      SURFACE,
      "registry surface sn-126-poker44-benchmark-chunks is present",
    );
    assert.equal(SURFACE.kind, "data-artifact");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(
      SURFACE.url,
      "https://api.poker44.net/api/v1/benchmark/chunks",
    );
    // The bare URL is not health-probeable (HTTP 422 without a sourceDate), so
    // unlike the other surfaces its probe is intentionally disabled.
    assert.equal(SURFACE.probe?.enabled, false);
    assert.equal(SURFACE.probe?.method, "GET");
  });

  test("callSubnetSurface merges the sourceDate query onto the curated url and returns the chunk listing", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      query: { sourceDate: "2026-07-21", limit: 1 },
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return new Response(JSON.stringify(CHUNKS), {
          status: 200,
          headers: { "content-type": CONTENT_TYPE },
        });
      },
    });
    assert.equal(result.ok, true);
    // The tool builds the request url from the curated base plus the query args.
    const expectedUrl = new URL(SURFACE.url);
    expectedUrl.searchParams.set("sourceDate", "2026-07-21");
    expectedUrl.searchParams.set("limit", "1");
    assert.equal(requestedUrl, expectedUrl.toString());
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, CONTENT_TYPE);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.body, CHUNKS);
  });
});
