// SN100 (Plaτform) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7112, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN100's *real* registry surface configs
// (registry/subnets/pla-form.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking one auth_required,
// disabling a probe, changing an expect kind) is caught here.
//
// All three issue-scoped surfaces are public no-auth GET JSON. Verified live
// 2026-07-21:
//   sn-100-platform-network-openapi
//     GET https://chain.joinbase.ai/openapi.json
//     -> OpenAPI 3.1.0, title "BASE Challenge Proxy", 27 paths
//   sn-100-platform-network-subnet-api
//     GET https://chain.joinbase.ai/v1/registry
//     -> {network, api_version, master_uid, challenges:[...]}
//   sn-100-joinbase-validators-public
//     GET https://chain.joinbase.ai/v1/validators/public
//     -> {validators:[...], timestamp}
// Fixtures mirror each live response's top-level shape (hermetic).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 100;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/pla-form.json", import.meta.url),
    ),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-100-platform-network-openapi",
    kind: "openapi",
    url: "https://chain.joinbase.ai/openapi.json",
    schemaUrl: "https://chain.joinbase.ai/openapi.json",
    body: {
      openapi: "3.1.0",
      info: { title: "BASE Challenge Proxy", version: "1.0" },
      paths: {
        "/v1/registry": {
          get: { summary: "Get Registry" },
        },
      },
    },
    assertBody: (b) => {
      assert.equal(b.openapi, "3.1.0");
      assert.equal(b.info.title, "BASE Challenge Proxy");
      assert.ok(b.paths["/v1/registry"]);
    },
  },
  {
    id: "sn-100-platform-network-subnet-api",
    kind: "subnet-api",
    url: "https://chain.joinbase.ai/v1/registry",
    schemaUrl: undefined,
    body: {
      network: "base",
      api_version: "1.0",
      master_uid: 0,
      challenges: [
        {
          slug: "agent-challenge",
          name: "Agent Challenge",
          emission_percentage: 100,
        },
      ],
    },
    assertBody: (b) => {
      assert.equal(b.network, "base");
      assert.equal(b.api_version, "1.0");
      assert.ok(Array.isArray(b.challenges));
      assert.equal(b.challenges[0].slug, "agent-challenge");
    },
  },
  {
    id: "sn-100-joinbase-validators-public",
    kind: "subnet-api",
    url: "https://chain.joinbase.ai/v1/validators/public",
    schemaUrl: undefined,
    body: {
      validators: [
        {
          hotkey: "5CiY7qfpeFM9y44s6J6RQbET8RQ5rPKd4tkvqh4HxSZSgsCv",
          uid: 1,
          status: "offline",
          online: false,
          capabilities: ["cpu", "gpu"],
        },
      ],
      timestamp: "2026-07-21T05:00:00.000000Z",
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.validators));
      assert.equal(typeof b.validators[0].hotkey, "string");
      assert.equal(typeof b.validators[0].uid, "number");
      assert.ok(typeof b.timestamp === "string");
    },
  },
];

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN100 Plaτform call_subnet_surface verification (#7112)", () => {
  for (const spec of SURFACES) {
    const surface = registry.surfaces.find((s) => s.id === spec.id);

    test(`${spec.id} exists and is configured to be callable`, () => {
      assert.ok(surface, `registry surface ${spec.id} is present`);
      assert.equal(surface.kind, spec.kind);
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      assert.equal(surface.url, spec.url);
      assert.equal(surface.schema_url, spec.schemaUrl);
    });

    test(`${spec.id}: callSubnetSurface returns JSON via the surface url + GET`, async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(spec.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      spec.assertBody(result.body);
    });

    test(`${spec.id}: end-to-end through call_subnet_surface MCP tool`, async () => {
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
        return jsonResponse(spec.body);
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
                arguments: { surface_id: spec.id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, spec.id);
        assert.equal(result.structuredContent.status_code, 200);
        spec.assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
