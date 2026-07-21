// SN78 (Vocence) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7091, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN78's real registry surfaces
// (registry/subnets/vocence.json) to the tool's contract, so a future edit that
// regresses their callability (flipping to HEAD, marking them auth_required,
// disabling their probe) is caught here.
//
// All five live-verified 2026-07-21:
//   - sn-78-vocence-subnet-api GET https://api.vocence.ai/health -> 200
//     application/json {"status":"ok","service":"vocence-developer-api"}.
//     kind "subnet-api" is operational -> exercised end-to-end through the tool.
//   - sn-78-vocence-llms-txt   GET https://www.vocence.ai/llms.txt -> 200
//     text/plain; charset=utf-8. kind "data-artifact" is operational too, but the
//     text/plain content-type means the tool returns the body as an unparsed
//     string rather than a parsed object.
//   - sn-78-vocence-openapi    GET https://api.vocence.ai/openapi.json -> 200
//     application/json (OpenAPI 3.1.0, "Vocence Developer API"). kind "openapi"
//     is NOT in OPERATIONAL_SURFACE_KINDS, so it is verified direct-call only.
//   - sn-78-vocence-website     HEAD https://www.vocence.ai/            -> 200 text/html
//   - sn-78-vocence-source-repo HEAD .../vocence-78/vocence             -> 200 text/html
//     Both non-operational kinds too; their probe.method is HEAD, so the tool
//     issues a HEAD request and returns an empty body.
// Fixtures below mirror the live responses (the OpenAPI doc is trimmed to its
// envelope), keeping the test hermetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 78;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/vocence.json", import.meta.url)),
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

const HEALTH = { status: "ok", service: "vocence-developer-api" };

const OPENAPI_DOC = {
  openapi: "3.1.0",
  info: { title: "Vocence Developer API", version: "1.0.0" },
  paths: {},
  components: {},
  tags: [],
};

const LLMS_TXT =
  "# Vocence\n\n> Decentralized voice AI — text-to-speech, voice cloning, voice design, streaming speech-to-text, music generation, and real-time voice agents.\n";

const SURFACES = [
  {
    id: "sn-78-vocence-subnet-api",
    kind: "subnet-api",
    operational: true,
    url: "https://api.vocence.ai/health",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(HEALTH),
    expectedBody: HEALTH,
  },
  {
    id: "sn-78-vocence-llms-txt",
    kind: "data-artifact",
    operational: true,
    url: "https://www.vocence.ai/llms.txt",
    method: "GET",
    contentType: "text/plain; charset=utf-8",
    rawBody: LLMS_TXT,
    expectedBody: LLMS_TXT,
  },
  {
    id: "sn-78-vocence-openapi",
    kind: "openapi",
    operational: false,
    url: "https://api.vocence.ai/openapi.json",
    method: "GET",
    contentType: "application/json",
    rawBody: JSON.stringify(OPENAPI_DOC),
    expectedBody: OPENAPI_DOC,
  },
  {
    id: "sn-78-vocence-website",
    kind: "website",
    operational: false,
    url: "https://www.vocence.ai/",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
  {
    id: "sn-78-vocence-source-repo",
    kind: "source-repo",
    operational: false,
    url: "https://github.com/vocence-78/vocence",
    method: "HEAD",
    contentType: "text/html",
    rawBody: null,
    expectedBody: "",
  },
];

for (const spec of SURFACES) {
  describe(`SN78 Vocence ${spec.id} call_subnet_surface verification (#7091)`, () => {
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
        // Non-JSON content-type (llms.txt as text/plain, HEAD) -> unparsed string.
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
        // OPERATIONAL_SURFACE_KINDS, which excludes openapi/website/source-repo.
        assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(spec.kind));
        assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
      });
    }
  });
}
