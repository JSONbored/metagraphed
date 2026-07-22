// SN102 (ConnitoAI) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7114, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool
// wiring with synthetic surfaces -- this file pins SN102's six
// issue-scoped registry surfaces (registry/subnets/connitoai.json) to the
// tool's contract, so a future edit that regresses their callability
// (flipping to HEAD, marking them auth_required, disabling their probe)
// is caught here.
//
// All six are public no-auth GET JSON endpoints on the official cycle-api
// host. Live-verified 2026-07-21:
//   - sn-102-connito-phase-openapi: /openapi.json -> 200 application/json,
//     ~4.4 KB OpenAPI document.
//   - sn-102-connito-phase-get-phase: /get_phase -> 200 application/json,
//     current cycle/phase state.
//   - sn-102-connito-blocks-until-next-phase: /blocks_until_next_phase ->
//     200 application/json, per-phase block-range map.
//   - sn-102-connito-init-peer-id: /get_init_peer_id -> 200
//     application/json, [] (no peers registered at verification time).
//   - sn-102-connito-validator-whitelist: /get_validator_whitelist -> 200
//     application/json, array of validator ss58 addresses.
//   - sn-102-connito-phase-status: / -> 200 application/json, service
//     status + phase schedule.
// The fixtures below mirror those live responses rather than fetching
// them, keeping the test hermetic while still exercising the JSON
// parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/connitoai.json", import.meta.url),
    ),
    "utf8",
  ),
);

function surfaceById(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

const OPENAPI_URL = "https://cycle-api.connito.ai/openapi.json";

const CASES = [
  {
    id: "sn-102-connito-phase-openapi",
    url: OPENAPI_URL,
    kind: "openapi",
    schemaUrl: OPENAPI_URL,
    body: { openapi: "3.1.0", info: { title: "Connito Cycle API" } },
  },
  {
    id: "sn-102-connito-phase-get-phase",
    url: "https://cycle-api.connito.ai/get_phase",
    kind: "subnet-api",
    schemaUrl: undefined,
    body: {
      block: 8_668_719,
      cycle_length: 524,
      cycle_index: 16_543,
      phase_name: "Train",
      phase_index: 1,
    },
  },
  {
    id: "sn-102-connito-blocks-until-next-phase",
    url: "https://cycle-api.connito.ai/blocks_until_next_phase",
    kind: "subnet-api",
    schemaUrl: undefined,
    body: {
      Distribute: [8_669_056, 8_669_075, 337],
      Train: [8_669_076, 8_669_375, 357],
    },
  },
  {
    id: "sn-102-connito-init-peer-id",
    url: "https://cycle-api.connito.ai/get_init_peer_id",
    kind: "subnet-api",
    schemaUrl: undefined,
    body: [],
  },
  {
    id: "sn-102-connito-validator-whitelist",
    url: "https://cycle-api.connito.ai/get_validator_whitelist",
    kind: "subnet-api",
    schemaUrl: undefined,
    body: ["5EEinUEy3cfBCUyhbvCcYfWU713QCsDoVXqbbRLKFtEqKkC9"],
  },
  {
    id: "sn-102-connito-phase-status",
    url: "https://cycle-api.connito.ai/",
    kind: "subnet-api",
    schemaUrl: undefined,
    body: { message: "Phase service is running", cycle_length: 524 },
  },
];

for (const { id, url, kind, schemaUrl, body } of CASES) {
  describe(`SN102 ConnitoAI call_subnet_surface verification: ${id} (#7114)`, () => {
    const SURFACE = surfaceById(id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${id} is present`);
      assert.equal(SURFACE.kind, kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, url);
      assert.equal(SURFACE.schema_url, schemaUrl);
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (reqUrl, init) => {
          requestedUrl = String(reqUrl);
          requestedMethod = init.method;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assert.deepEqual(result.body, body);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 102 }],
      };
      const deps = {
        readArtifact: async (_env, path) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const reqUrl = String(input);
        if (reqUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
                arguments: { surface_id: id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, id);
        assert.equal(result.structuredContent.status_code, 200);
        assert.deepEqual(result.structuredContent.body, body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}
