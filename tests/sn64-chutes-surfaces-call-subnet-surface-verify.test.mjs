// SN64 (Chutes) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7077, MCP execute Phase 1 follow-up #7014/#7215), covering the
// 12 registry surfaces #7077 lists beyond the health endpoint --
// tests/chutes-call-subnet-surface-verify.test.mjs already pins
// sn-64-chutes-health and is deliberately not duplicated here. Like that
// file, this pins SN64's *real* registry surface config
// (registry/subnets/chutes.json) to the tool's contract, so a future edit
// that regresses callability is caught here.
//
// Every callable surface below was live-verified 2026-07-21 with a direct
// request against its curated URL:
// - 7 subnet-api surfaces returned HTTP 200 application/json; the fixtures
//   mirror each observed body's shape (real top-level field names), not
//   exact live values.
// - sn-64-chutes-openapi answered HEAD with HTTP 200 application/json,
//   matching its registry probe (method HEAD, expect json).
// - Three surfaces exposed real quirks in how the Phase 1 tool meets this
//   API, each pinned below as current behavior:
//   * sn-64-chutes-ping served its "ok" body as application/octet-stream,
//     which classifyContentType treats as binary -- the tool rejects it
//     ("unsupported content-type") even though the endpoint is healthy.
//   * sn-64-chutes-llm-stats-api returned ~19.5 MB of JSON, far over the
//     tool's 256 KiB cap -- the body comes back truncated as unparsed text
//     with a parse_error.
//   * sn-64-chutes-miner-metrics returned HTTP 200 with no content-type
//     header at all and SSE-style "data: {...}" lines (its registry probe
//     expects json) -- the tool returns the raw text with a null
//     content_type.
// - sn-64-chutes-sse (POST-shaped chat completions, bearer auth) is Phase 3
//   territory per #7077 and carries no probe block -- pinned at the
//   registry-config level only and never called.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  callSubnetSurface,
  MAX_RESPONSE_BYTES,
} from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/chutes.json", import.meta.url)),
    "utf8",
  ),
);

// The 7 no-auth GET JSON subnet-api surfaces from #7077's verify list that
// the tool handles cleanly, with a shape-faithful subset of each body
// observed live on 2026-07-21.
const JSON_SURFACES = {
  "sn-64-chutes-pricing-api": {
    tao_usd: 199.7856,
    compute_unit_estimate: { usd: 0.0000555, tao: 2.78e-7 },
  },
  "sn-64-chutes-subnet-api": {
    object: "list",
    data: [
      {
        id: "Qwen/Qwen3-32B-TEE",
        root: "Qwen/Qwen3-32B-FP8",
        price: { input: { tao: 0.00052, usd: 0.104 } },
      },
    ],
  },
  "sn-64-chutes-bounties-api": [
    {
      chute_id: "73dd32db-72a4-53c4-ae77-19ef350e287c",
      bounty_amount: 86400,
      seconds_elapsed: 65676,
      time_remaining: 20724,
    },
  ],
  "sn-64-chutes-fmv-api": { tao: 199.7856 },
  "sn-64-chutes-tao-payment-totals-api": {
    today: 1235.6,
    this_month: 82056.48,
    total: 2292987.5,
  },
  "sn-64-chutes-miner-scores-api": {
    raw_values: {
      "5CSa1rZA": {
        total_instances: 111.0,
        bounty_score: 1.0,
        instance_seconds: 3364336.45,
      },
    },
  },
  "sn-64-chutes-miner-stats-api": {
    past_hour: {
      instance_stats: [
        { miner_hotkey: "5CSa1rZA", total_instances: 46, bounty_count: 1 },
      ],
    },
  },
};

const PING_ID = "sn-64-chutes-ping";
const LLM_STATS_ID = "sn-64-chutes-llm-stats-api";
const METRICS_ID = "sn-64-chutes-miner-metrics";
const OPENAPI_ID = "sn-64-chutes-openapi";
const SSE_ID = "sn-64-chutes-sse";

// One element of the live /invocations/stats/llm array, repeated until the
// payload crosses the tool's byte cap the way the ~19.5 MB live body does.
const LLM_STATS_ELEMENT = {
  chute_id: "ac059e33-eb27-541c-b9a9-24b214036475",
  name: "Qwen/Qwen3-32B-TEE",
  date: "2026-07-21",
  total_requests: 3003966,
  total_input_tokens: 14582861496,
  total_output_tokens: 677513737,
};
// SSE-style first line observed live from /miner/metrics/ (no content-type).
const METRICS_BODY =
  'data: {"chute_id":"aea729aa-0b49-50ae-8843-b33f42d60886","compute_multiplier":0.4,"total_invocations":0}\n\n';

function surfaceById(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN64 Chutes call_subnet_surface verification beyond health (#7077)", () => {
  test("the 10 no-auth GET subnet-api surfaces are present and configured to be callable", () => {
    for (const id of [
      ...Object.keys(JSON_SURFACES),
      PING_ID,
      LLM_STATS_ID,
      METRICS_ID,
    ]) {
      const surface = surfaceById(id);
      assert.ok(surface, `registry surface ${id} is present`);
      assert.equal(surface.kind, "subnet-api", id);
      assert.equal(surface.auth_required, false, id);
      assert.equal(surface.probe?.enabled, true, id);
      assert.equal(surface.probe?.method, "GET", id);
      // /ping is registered with expect any; the others expect json.
      assert.equal(surface.probe?.expect, id === PING_ID ? "any" : "json", id);
    }
  });

  test("the OpenAPI surface probes via HEAD and doubles as its own schema_url", () => {
    const surface = surfaceById(OPENAPI_ID);
    assert.ok(surface, `registry surface ${OPENAPI_ID} is present`);
    assert.equal(surface.kind, "openapi");
    assert.equal(surface.auth_required, false);
    assert.equal(surface.probe?.enabled, true);
    assert.equal(surface.probe?.method, "HEAD");
    assert.equal(surface.probe?.expect, "json");
    assert.equal(surface.url, "https://api.chutes.ai/openapi.json");
    assert.equal(surface.schema_url, surface.url);
  });

  test("the bearer-auth SSE surface is pinned as Phase 3 territory, not callable today", () => {
    const surface = surfaceById(SSE_ID);
    assert.ok(surface, `registry surface ${SSE_ID} is present`);
    assert.equal(surface.kind, "sse");
    assert.equal(surface.auth_required, true);
    // No probe block -- the build's prober has nothing to call unauthenticated.
    assert.equal(surface.probe, undefined);
    assert.equal(surface.url, "https://llm.chutes.ai/v1/chat/completions");
  });

  test("callSubnetSurface returns each clean JSON surface's body using its own url + GET", async () => {
    for (const [id, body] of Object.entries(JSON_SURFACES)) {
      const surface = surfaceById(id);
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(body);
        },
      });
      assert.equal(result.ok, true, id);
      assert.equal(requestedUrl, surface.url, id);
      assert.equal(requestedMethod, "GET", id);
      assert.equal(result.status_code, 200, id);
      assert.equal(result.content_type, "application/json", id);
      assert.equal(result.truncated, false, id);
      assert.deepEqual(result.body, body, id);
    }
  });

  test("callSubnetSurface answers HEAD for the OpenAPI surface with an empty body", async () => {
    const surface = surfaceById(OPENAPI_ID);
    let requestedMethod;
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        requestedMethod = init.method;
        // Live HEAD answered 200 application/json with no body.
        return new Response(null, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(requestedMethod, "HEAD");
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.body, "");
  });

  test("callSubnetSurface currently rejects /ping's application/octet-stream body", async () => {
    const surface = surfaceById(PING_ID);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        // Live: HTTP 200, body "ok", served as application/octet-stream.
        new Response("ok", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    // The endpoint is healthy, but octet-stream classifies as binary, so the
    // Phase 1 tool refuses to return it -- pinned so a future content-type
    // fix (upstream or in classifyContentType) is a visible change.
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      "unsupported content-type: application/octet-stream",
    );
    assert.equal(result.status_code, 200);
  });

  test("callSubnetSurface truncates the oversized /invocations/stats/llm body", async () => {
    const surface = surfaceById(LLM_STATS_ID);
    const elements = [];
    while (JSON.stringify(elements).length <= MAX_RESPONSE_BYTES) {
      elements.push(LLM_STATS_ELEMENT);
    }
    const oversized = JSON.stringify(elements);
    assert.ok(oversized.length > MAX_RESPONSE_BYTES);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        new Response(oversized, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    // Live body was ~19.5 MB -- far over MAX_RESPONSE_BYTES -- so the real
    // surface always comes back truncated: unparsed text plus a parse_error.
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, true);
    assert.equal(typeof result.body, "string");
    assert.ok(result.parse_error);
  });

  test("callSubnetSurface returns /miner/metrics/'s content-type-less stream as raw text", async () => {
    const surface = surfaceById(METRICS_ID);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () => {
        // Live: HTTP 200, SSE-style "data:" lines, and no content-type
        // header at all. A ReadableStream body keeps Response from
        // synthesizing one.
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(METRICS_BODY));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, null);
    // Unknown content-type is not binary, so the body comes back as the raw
    // text -- despite the registry probe expecting json from this URL.
    assert.equal(result.body, METRICS_BODY);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // Operational subnet-api surfaces only -- the openapi kind stays out of
    // the operational-surfaces catalog, and the sse surface is auth-gated.
    const catalog = {
      surfaces: Object.keys(JSON_SURFACES).map((id) => ({
        ...surfaceById(id),
        surface_id: id,
        netuid: 64,
      })),
    };
    const deps = {
      readArtifact: async (_env, path) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const originalFetch = globalThis.fetch;
    try {
      for (const [id, body] of Object.entries(JSON_SURFACES)) {
        globalThis.fetch = async (input) => {
          const url = String(input);
          if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
            return new Response(JSON.stringify({ Status: 0 }), {
              headers: { "content-type": "application/dns-json" },
            });
          }
          return jsonResponse(body);
        };
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
        assert.equal(result.isError, false, id);
        assert.equal(result.structuredContent.surface_id, id, id);
        assert.equal(result.structuredContent.status_code, 200, id);
        assert.deepEqual(result.structuredContent.body, body, id);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
