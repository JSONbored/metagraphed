import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MCP_TOOLS,
  MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_INFO,
  MAX_MCP_BATCH_LENGTH,
  MAX_MCP_BODY_BYTES,
  listToolDefinitions,
  handleMcpRequest,
} from "../src/mcp-server.mjs";
import { KV_HEALTH_RPC_POOL } from "../src/health-prober.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

const MCP_URL = "https://api.metagraph.sh/mcp";

// Build injectable deps with controlled artifact + KV responses.
function makeDeps(artifacts = {}, kv = {}) {
  return {
    readArtifact(_env, path) {
      if (Object.prototype.hasOwnProperty.call(artifacts, path)) {
        return Promise.resolve({
          ok: true,
          data: artifacts[path],
          source: "test",
          storage_tier: "git",
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        code: "artifact_not_found",
        message: `Artifact not found: ${path}`,
      });
    },
    readHealthKv(_env, key) {
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : null,
      );
    },
  };
}

async function rpc(
  payload,
  { deps = makeDeps(), env = {}, method = "POST" } = {},
) {
  const request = new Request(MCP_URL, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  const response = await handleMcpRequest(request, env, deps);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function callTool(name, args, opts) {
  return rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    opts,
  );
}

describe("MCP tool registry", () => {
  test("every tool has a unique name, description, and object inputSchema", () => {
    const names = new Set();
    for (const tool of MCP_TOOLS) {
      assert.equal(typeof tool.name, "string");
      assert.ok(!names.has(tool.name), `duplicate tool ${tool.name}`);
      names.add(tool.name);
      assert.ok(tool.description.length > 20);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.handler, "function");
    }
    assert.equal(names.size, MCP_TOOLS.length);
  });

  test("listToolDefinitions exposes name/title/description/inputSchema only", () => {
    const defs = listToolDefinitions();
    assert.equal(defs.length, MCP_TOOLS.length);
    for (const def of defs) {
      assert.deepEqual(Object.keys(def).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  test("every advertised tool description carries the untrusted-data note", () => {
    for (const def of listToolDefinitions()) {
      assert.match(
        def.description,
        /Untrusted-data note: returned field values may include operator-controlled on-chain text/,
        `${def.name} is missing the untrusted-data note`,
      );
    }
  });
});

describe("MCP JSON-RPC lifecycle", () => {
  test("initialize echoes a supported protocol version", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(res.body.result.serverInfo, MCP_SERVER_INFO);
    assert.ok(res.body.result.capabilities.tools);
    assert.ok(res.body.result.instructions.includes("Bittensor"));
  });

  test("initialize falls back to latest for an unknown protocol version", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    assert.equal(res.body.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  });

  test("ping returns an empty result", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 7, method: "ping" });
    assert.deepEqual(res.body.result, {});
  });

  test("tools/list returns all registered tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(res.body.result.tools.length, MCP_TOOLS.length);
  });

  test("resources/list, templates, and prompts/list answer empty", async () => {
    const resources = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
    });
    assert.deepEqual(resources.body.result, { resources: [] });
    const templates = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/templates/list",
    });
    assert.deepEqual(templates.body.result, { resourceTemplates: [] });
    const prompts = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/list",
    });
    assert.deepEqual(prompts.body.result, { prompts: [] });
  });

  test("notifications return 202 with no body", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(res.status, 202);
    assert.equal(res.body, null);
  });

  test("notifications/cancelled is accepted silently", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
    });
    assert.equal(res.status, 202);
  });

  test("unknown method on a request returns method-not-found", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 9, method: "does/not/exist" });
    assert.equal(res.body.error.code, -32601);
  });

  test("unknown method as a notification is dropped (202)", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "does/not/exist" });
    assert.equal(res.status, 202);
  });

  test("invalid jsonrpc envelope returns invalid-request", async () => {
    const res = await rpc({ id: 1, method: "ping" });
    assert.equal(res.body.error.code, -32600);
  });

  test("invalid envelope without id is dropped as a notification", async () => {
    const res = await rpc({ method: "ping" });
    assert.equal(res.status, 202);
  });
});

describe("MCP transport handling", () => {
  test("GET is rejected with 405 and an Allow header", async () => {
    const res = await rpc(null, { method: "GET" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
    assert.equal(res.body.error.code, -32600);
  });

  test("non-JSON body returns a parse error", async () => {
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await handleMcpRequest(request, {}, makeDeps());
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, -32700);
  });

  test("a batch processes each message and drops notifications", async () => {
    const res = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].id, 1);
    assert.equal(res.body[1].id, 2);
  });

  test("a notification-only batch returns 202", async () => {
    const res = await rpc([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    assert.equal(res.status, 202);
  });

  test("an empty batch is an invalid request", async () => {
    const res = await rpc([]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, -32600);
  });

  test("an oversized batch is rejected before processing messages", async () => {
    const calls = [];
    const deps = {
      ...makeDeps(),
      readArtifact(_env, path) {
        calls.push(path);
        return Promise.resolve({ ok: true, data: {} });
      },
    };
    const res = await rpc(
      Array.from({ length: MAX_MCP_BATCH_LENGTH + 1 }, (_, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/list",
      })),
      { deps },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, -32600);
    assert.match(res.body.error.message, /batch length exceeds/);
    assert.deepEqual(calls, []);
  });

  test("an oversized decoded body is rejected before JSON parsing", async () => {
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `"${"x".repeat(MAX_MCP_BODY_BYTES)}"`,
    });
    const response = await handleMcpRequest(request, {}, makeDeps());
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, -32600);
  });

  test("the MCP rate limiter is enforced before body parsing", async () => {
    let rateLimitKey;
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
      },
      body: "{not json",
    });
    const response = await handleMcpRequest(
      request,
      {
        MCP_RATE_LIMITER: {
          async limit({ key }) {
            rateLimitKey = key;
            return { success: false };
          },
        },
      },
      makeDeps(),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(rateLimitKey, "203.0.113.7");
    const body = await response.json();
    assert.match(body.error.message, /Too many MCP requests/);
  });

  test("handleMcpRequest defaults deps to an empty object", async () => {
    const request = new Request(MCP_URL, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const response = await handleMcpRequest(request, {});
    assert.equal(response.status, 200);
  });
});

describe("MCP tools (injected deps)", () => {
  const deps = makeDeps(
    {
      "/metagraph/search.json": {
        documents: [
          {
            type: "subnet",
            netuid: 7,
            slug: "allways",
            title: "Allways",
            subtitle: "Bitcoin data",
            tokens: ["bitcoin", "data", "api"],
          },
          {
            type: "subnet",
            netuid: 12,
            slug: "compute",
            title: "Compute",
            subtitle: "GPU compute",
            tokens: ["gpu", "compute"],
          },
          {
            type: "provider",
            netuid: null,
            slug: "p",
            title: "Provider",
            tokens: ["bitcoin"],
          },
        ],
      },
      "/metagraph/agent-catalog.json": {
        subnets: [
          {
            netuid: 7,
            slug: "allways",
            name: "Allways",
            categories: ["bitcoin", "data"],
            service_kinds: ["subnet-api", "openapi"],
            callable_count: 13,
            integration_readiness: 100,
          },
          {
            netuid: 12,
            slug: "compute",
            name: "Compute",
            categories: ["gpu"],
            service_kinds: ["subnet-api"],
            callable_count: 0,
          },
        ],
      },
      "/metagraph/agent-catalog/7.json": {
        netuid: 7,
        services: [{ surface_id: "7:subnet-api:allways", kind: "subnet-api" }],
      },
      "/metagraph/overview/7.json": { netuid: 7, name: "Allways" },
      "/metagraph/health/subnets/7.json": {
        netuid: 7,
        summary: { status: "ok" },
      },
      "/metagraph/schemas/7:subnet-api:allways.json": {
        surface_id: "7:subnet-api:allways",
        openapi: "3.1.0",
      },
      "/metagraph/registry-summary.json": { completeness: 0.42 },
      "/metagraph/rpc/pools.json": {
        pools: {
          0: {
            endpoints: [
              {
                id: "a",
                url: "wss://a.example",
                provider: "x",
                kind: "subtensor-rpc",
                score: 90,
                pool_eligible: true,
                latency_ms: 120,
              },
              {
                id: "b",
                url: "wss://b.example",
                provider: "y",
                kind: "subtensor-rpc",
                score: 95,
                pool_eligible: true,
                latency_ms: 80,
              },
              {
                id: "c",
                url: "wss://c.example",
                provider: "z",
                kind: "subtensor-rpc",
                score: 99,
                pool_eligible: false,
              },
            ],
          },
          // Same physical endpoint 'b' also appears in a second pool — must be
          // deduped, not returned twice.
          1: {
            endpoints: [
              {
                id: "b",
                url: "wss://b.example",
                provider: "y",
                kind: "subtensor-wss",
                score: 95,
                pool_eligible: true,
                latency_ms: 80,
              },
            ],
          },
        },
      },
    },
    {
      [KV_HEALTH_RPC_POOL]: {
        endpoints: [
          { id: "b", status: "ok", latency_ms: 70, consecutive_failures: 0 },
        ],
      },
    },
  );

  test("search_subnets ranks subnet documents by term overlap", async () => {
    const res = await callTool(
      "search_subnets",
      { query: "bitcoin data", limit: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.results[0].netuid, 7);
    assert.ok(out.results[0].url.includes("/api/v1/subnets/7/overview"));
    assert.ok(out.results.every((r) => r.netuid !== null));
  });

  test("search_subnets clamps the limit and reports zero matches", async () => {
    const res = await callTool(
      "search_subnets",
      { query: "nonexistentxyz", limit: 999 },
      { deps },
    );
    assert.equal(res.body.result.structuredContent.count, 0);
  });

  test("search_subnets requires a non-empty query", async () => {
    const res = await callTool("search_subnets", { query: "   " }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("query"));
  });

  test("find_subnets_by_capability returns only callable subnets", async () => {
    const res = await callTool(
      "find_subnets_by_capability",
      { capability: "bitcoin" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.count, 1);
    assert.equal(out.results[0].netuid, 7);
    // integration_readiness is surfaced so agents can rank/filter buildability
    assert.equal(
      typeof out.results[0].integration_readiness,
      "number",
      "find_subnets_by_capability results must carry integration_readiness",
    );
  });

  test("find_subnets_by_capability with no match returns empty", async () => {
    const res = await callTool(
      "find_subnets_by_capability",
      { capability: "gpu" },
      { deps },
    );
    // netuid 12 has gpu but callable_count 0 -> excluded
    assert.equal(res.body.result.structuredContent.count, 0);
  });

  test("get_subnet returns the overview artifact", async () => {
    const res = await callTool("get_subnet", { netuid: 7 }, { deps });
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("get_subnet rejects a non-integer netuid", async () => {
    const res = await callTool("get_subnet", { netuid: "seven" }, { deps });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet surfaces an artifact-unavailable error", async () => {
    const res = await callTool("get_subnet", { netuid: 999 }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("artifact_not_found"));
  });

  test("get_subnet_health is live-only — ignores the static artifact, reports unknown when the live store is cold", async () => {
    // `deps` carries a static /metagraph/health/subnets/7.json (summary.status
    // "ok"), but current health is live-only: the retired static artifact must
    // never be served, so a cold live store yields `unknown`, not stale "ok".
    const res = await callTool("get_subnet_health", { netuid: 7 }, { deps });
    assert.equal(res.body.result.structuredContent.summary.status, "unknown");
  });

  test("list_subnet_apis returns the per-subnet services", async () => {
    const res = await callTool("list_subnet_apis", { netuid: 7 }, { deps });
    assert.equal(res.body.result.structuredContent.service_count, 1);
  });

  test("get_api_schema fetches a schema by surface_id", async () => {
    const res = await callTool(
      "get_api_schema",
      { surface_id: "7:subnet-api:allways" },
      { deps },
    );
    assert.equal(res.body.result.structuredContent.openapi, "3.1.0");
  });

  test("get_api_schema returns the full captured document + auth metadata", async () => {
    const schemaDeps = makeDeps({
      "/metagraph/schemas/chutes.json": {
        surface_id: "chutes",
        auth_required: true,
        auth_schemes: ["apiKey"],
        document: {
          openapi: "3.1.0",
          paths: { "/v1/chat": {}, "/v1/models": {} },
          components: { securitySchemes: { ApiKeyHeader: { type: "apiKey" } } },
        },
      },
    });
    const res = await callTool(
      "get_api_schema",
      { surface_id: "chutes" },
      { deps: schemaDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.auth_required, true);
    assert.deepEqual(out.auth_schemes, ["apiKey"]);
    assert.ok(out.document, "must return the captured OpenAPI document");
    assert.deepEqual(Object.keys(out.document.paths), [
      "/v1/chat",
      "/v1/models",
    ]);
  });

  test("get_api_schema rejects path-traversal surface ids", async () => {
    const res = await callTool(
      "get_api_schema",
      { surface_id: "../secrets" },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("invalid"));
  });

  test("get_fixture returns a captured live sample by surface_id (#352)", async () => {
    const fixtureDeps = makeDeps({
      "/metagraph/fixtures/allways-api-health.json": {
        surface_id: "allways-api-health",
        netuid: 7,
        kind: "subnet-api",
        request: { method: "GET", url: "https://api.all-ways.io/health" },
        response: { status: 200, body: { ok: true } },
      },
    });
    const res = await callTool(
      "get_fixture",
      { surface_id: "allways-api-health" },
      { deps: fixtureDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.response.status, 200);
    assert.deepEqual(out.response.body, { ok: true });
    assert.equal(out.request.method, "GET");
  });

  test("get_fixture rejects path-traversal surface ids (#352)", async () => {
    const res = await callTool(
      "get_fixture",
      { surface_id: "../secrets" },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("invalid"));
  });

  test("get_agent_catalog returns the global catalog with no netuid", async () => {
    const res = await callTool("get_agent_catalog", {}, { deps });
    assert.ok(Array.isArray(res.body.result.structuredContent.subnets));
  });

  test("get_agent_catalog returns a per-subnet catalog with a netuid", async () => {
    const res = await callTool("get_agent_catalog", { netuid: 7 }, { deps });
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("get_best_rpc_endpoint dedupes, exposes url/network, applies live health", async () => {
    const res = await callTool("get_best_rpc_endpoint", { limit: 5 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.live_health, true);
    // 'a' and 'b' are pool_eligible ('c' is not); 'b' appears in two pools but
    // must be deduped -> exactly 2 eligible. 'b' gets live latency 70.
    assert.equal(out.eligible_count, 2);
    assert.equal(out.endpoints.filter((e) => e.id === "b").length, 1);
    assert.equal(out.endpoints[0].id, "b");
    assert.equal(out.endpoints[0].latency_ms, 70);
    assert.equal(out.endpoints[0].url, "wss://b.example");
    assert.equal(out.endpoints[0].network, "finney");
    // The bogus pool-key network ("0"/"1") must never leak.
    assert.ok(out.endpoints.every((e) => e.network === "finney"));
  });

  test("get_best_rpc_endpoint works without a live KV snapshot", async () => {
    const noKvDeps = makeDeps(
      {
        "/metagraph/rpc/pools.json": {
          pools: {
            0: { endpoints: [{ id: "a", pool_eligible: true, score: 1 }] },
          },
        },
      },
      {},
    );
    const res = await callTool("get_best_rpc_endpoint", {}, { deps: noKvDeps });
    assert.equal(res.body.result.structuredContent.live_health, false);
    assert.equal(res.body.result.structuredContent.eligible_count, 1);
  });

  test("get_best_rpc_endpoint tolerates a pools artifact with no pools", async () => {
    const emptyDeps = makeDeps({ "/metagraph/rpc/pools.json": {} }, {});
    const res = await callTool(
      "get_best_rpc_endpoint",
      {},
      { deps: emptyDeps },
    );
    assert.equal(res.body.result.structuredContent.eligible_count, 0);
  });

  test("registry_summary returns the summary artifact", async () => {
    const res = await callTool("registry_summary", {}, { deps });
    assert.equal(res.body.result.structuredContent.completeness, 0.42);
  });
});

describe("MCP edge cases", () => {
  test("a request method behaves as a notification when sent without an id", async () => {
    // Covers the isNotification short-circuit on otherwise-valid methods.
    for (const method of [
      "initialize",
      "ping",
      "tools/list",
      "resources/list",
    ]) {
      const res = await rpc({ jsonrpc: "2.0", method });
      assert.equal(res.status, 202, `${method} as notification`);
    }
  });

  test("tools/call without an id is dropped as a notification", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "registry_summary", arguments: {} },
    });
    assert.equal(res.status, 202);
  });

  test("get_subnet rejects a negative netuid", async () => {
    const res = await callTool("get_subnet", { netuid: -1 });
    assert.equal(res.body.result.isError, true);
  });

  test("a non-string tool name yields an unknown-tool error result", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: 42 },
    });
    assert.equal(res.body.result.isError, true);
  });

  test("a readArtifact rejection surfaces as a JSON-RPC internal error", async () => {
    const throwingDeps = {
      readArtifact() {
        return Promise.reject(new Error("kv exploded"));
      },
      readHealthKv() {
        return Promise.resolve(null);
      },
    };
    const res = await callTool("registry_summary", {}, { deps: throwingDeps });
    assert.equal(res.body.error.code, -32603);
    assert.ok(res.body.error.message.includes("kv exploded"));
  });

  test("artifact failure without code/message uses default messaging", async () => {
    const bareDeps = {
      readArtifact() {
        return Promise.resolve({ ok: false });
      },
      readHealthKv() {
        return Promise.resolve(null);
      },
    };
    const res = await callTool("registry_summary", {}, { deps: bareDeps });
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("artifact_unavailable"));
  });

  test("a null artifact result is treated as unavailable", async () => {
    const nullDeps = {
      readArtifact() {
        return Promise.resolve(null);
      },
      readHealthKv() {
        return Promise.resolve(null);
      },
    };
    const res = await callTool("get_subnet", { netuid: 7 }, { deps: nullDeps });
    assert.equal(res.body.result.isError, true);
  });

  test("get_best_rpc_endpoint works when no readHealthKv dep is provided", async () => {
    const depsNoKvFn = {
      readArtifact() {
        return Promise.resolve({
          ok: true,
          data: {
            pools: {
              0: { endpoints: [{ id: "a", pool_eligible: true, score: 5 }] },
            },
          },
        });
      },
    };
    const res = await callTool(
      "get_best_rpc_endpoint",
      {},
      { deps: depsNoKvFn },
    );
    assert.equal(res.body.result.structuredContent.live_health, false);
    assert.equal(res.body.result.structuredContent.endpoints[0].id, "a");
  });
});

describe("MCP end-to-end through the Worker dispatch", () => {
  test("POST /mcp tools/call resolves real artifacts from the local env", async () => {
    const env = createLocalArtifactEnv();
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_subnet_apis", arguments: { netuid: 7 } },
      }),
    });
    const response = await handleRequest(request, env, {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.result.structuredContent.service_count >= 1);
  });
});

describe("MCP AI tools (semantic_search + ask)", () => {
  // Minimal AI bindings: embed → 1024-d vector, vector query → subnet matches,
  // completion → cited answer. Kill-switch on so aiEnabled() is satisfied.
  function aiEnv() {
    return {
      METAGRAPH_ENABLE_AI: "true",
      AI: {
        run(model, input) {
          if (Array.isArray(input?.text) || typeof input?.text === "string") {
            const n = Array.isArray(input.text) ? input.text.length : 1;
            return Promise.resolve({
              data: Array.from({ length: n }, () => new Array(1024).fill(0.02)),
            });
          }
          return Promise.resolve({ response: "Subnet 1 exposes an API [1]." });
        },
      },
      VECTORIZE: {
        query() {
          return Promise.resolve({
            matches: [
              {
                id: "subnet:1",
                score: 0.88,
                metadata: {
                  type: "subnet",
                  netuid: 1,
                  slug: "sn-1",
                  title: "Apex",
                  subtitle: "text generation",
                  url: "https://api.metagraph.sh/api/v1/subnets/1/overview",
                },
              },
            ],
          });
        },
      },
    };
  }

  test("semantic_search returns isError without the AI layer", async () => {
    const res = await callTool("semantic_search", { query: "images" });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ai_unavailable/);
  });

  test("ask returns isError without the AI layer", async () => {
    const res = await callTool("ask", { question: "which subnet?" });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ai_unavailable/);
  });

  test("semantic_search returns ranked matches when AI is enabled", async () => {
    const res = await callTool(
      "semantic_search",
      { query: "generate text", limit: 5 },
      { env: aiEnv() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false);
    const out = res.body.result.structuredContent;
    assert.equal(out.query, "generate text");
    assert.equal(out.results[0].netuid, 1);
  });

  test("ask returns a grounded answer with citations when AI is enabled", async () => {
    const res = await callTool(
      "ask",
      { question: "Which subnet exposes an API?" },
      { env: aiEnv() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false);
    const out = res.body.result.structuredContent;
    assert.ok(out.answer.length > 0);
    assert.equal(out.citations[0].netuid, 1);
  });

  test("semantic_search applies the AI rate limiter before embedding", async () => {
    const env = aiEnv();
    let limiterKey;
    let aiRuns = 0;
    env.AI.run = () => {
      aiRuns += 1;
      return Promise.resolve({ data: [new Array(1024).fill(0.02)] });
    };
    env.AI_RATE_LIMITER = {
      async limit({ key }) {
        limiterKey = key;
        return { success: false };
      },
    };

    const res = await callTool(
      "semantic_search",
      { query: "generate text" },
      { env },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /rate_limited/);
    assert.equal(limiterKey, "semantic:anonymous");
    assert.equal(aiRuns, 0);
  });

  test("ask applies the AI rate limiter to each JSON-RPC batch item", async () => {
    const env = aiEnv();
    let limiterCalls = 0;
    let aiRuns = 0;
    env.AI.run = () => {
      aiRuns += 1;
      return Promise.resolve({ response: "should not run" });
    };
    env.AI_RATE_LIMITER = {
      async limit({ key }) {
        limiterCalls += 1;
        assert.equal(key, "ask:anonymous");
        return { success: false };
      },
    };

    const res = await rpc(
      Array.from({ length: MAX_MCP_BATCH_LENGTH }, (_, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: {
          name: "ask",
          arguments: { question: `Which subnet? ${index}` },
        },
      })),
      { env },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.length, MAX_MCP_BATCH_LENGTH);
    assert.equal(limiterCalls, MAX_MCP_BATCH_LENGTH);
    assert.equal(aiRuns, 0);
    for (const response of res.body) {
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /rate_limited/);
    }
  });

  test("semantic_search rejects a blank query with a clean tool error", async () => {
    const res = await callTool(
      "semantic_search",
      { query: "   " },
      { env: aiEnv() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params|non-empty/);
  });
});

describe("MCP goal-shaped tools (find_subnet_for_task + how_do_i_call)", () => {
  const searchAndCatalog = {
    "/metagraph/search.json": {
      documents: [
        {
          id: "subnet:7",
          type: "subnet",
          netuid: 7,
          slug: "sn-7",
          title: "Data Universe",
          subtitle: "data scraping and storage",
          tokens: ["data", "scraping", "storage"],
          categories: ["data"],
          service_kinds: ["subnet-api"],
        },
        {
          id: "subnet:8",
          type: "subnet",
          netuid: 8,
          slug: "sn-8",
          title: "Unrelated",
          subtitle: "something else",
          tokens: ["unrelated"],
        },
      ],
    },
    "/metagraph/agent-catalog.json": {
      subnets: [
        {
          netuid: 7,
          name: "Data Universe",
          slug: "sn-7",
          categories: ["data"],
          integration_readiness: 70,
          callable_count: 2,
          service_kinds: ["subnet-api"],
          base_url: "https://api.data.io",
          health: "operational",
        },
      ],
    },
  };

  test("find_subnet_for_task returns callable matches by keyword (no AI)", async () => {
    const res = await callTool(
      "find_subnet_for_task",
      { task: "scrape data", limit: 5 },
      { deps: makeDeps(searchAndCatalog) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false);
    const out = res.body.result.structuredContent;
    assert.equal(out.discovery, "keyword");
    assert.equal(out.results[0].netuid, 7);
    assert.equal(out.results[0].base_url, "https://api.data.io");
    assert.equal(out.results[0].integration_readiness, 70);
    // subnet 8 is not in the catalog (not callable) so it is excluded.
    assert.ok(out.results.every((r) => r.netuid !== 8));
  });

  test("find_subnet_for_task notes when nothing callable matches", async () => {
    const res = await callTool(
      "find_subnet_for_task",
      { task: "quantum teleportation" },
      { deps: makeDeps(searchAndCatalog) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.count, 0);
    assert.match(out.note, /No callable subnet/);
  });

  const callDetail = {
    "/metagraph/agent-catalog/7.json": {
      netuid: 7,
      name: "Data Universe",
      slug: "sn-7",
      integration_readiness: 70,
      services: [
        {
          surface_id: "sn-7-api",
          kind: "subnet-api",
          capability: "Data API",
          base_url: "https://api.data.io",
          auth_required: true,
          auth_schemes: ["apiKey"],
          schema_url: "https://api.data.io/openapi.json",
          schema_artifact: "schemas/sn-7-api.json",
          health: { status: "operational", stale: false },
          eligibility: { callable: true },
        },
      ],
    },
    "/metagraph/subnets.json": {
      subnets: [{ netuid: 7, slug: "sn-7", native_slug: "datauniverse" }],
    },
    "/metagraph/agent-catalog/9.json": {
      netuid: 9,
      name: "Quiet",
      slug: "sn-9",
      integration_readiness: 10,
      services: [],
    },
  };

  test("how_do_i_call returns concrete call instructions by netuid", async () => {
    const res = await callTool(
      "how_do_i_call",
      { netuid: 7 },
      { deps: makeDeps(callDetail) },
    );
    assert.equal(res.status, 200);
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.callable, true);
    assert.equal(out.services[0].base_url, "https://api.data.io");
    assert.equal(out.services[0].auth.required, true);
    assert.deepEqual(out.services[0].auth.schemes, ["apiKey"]);
    assert.equal(out.services[0].schema.available, true);
    assert.match(out.services[0].schema.fetch_with, /get_api_schema/);
    // ready-to-run snippets (#351): curl/python/typescript for a first call
    assert.ok(out.services[0].snippets, "expected integration snippets");
    assert.match(
      out.services[0].snippets.curl,
      /^curl -sS 'https:\/\/api\.data\.io'/,
    );
    assert.match(out.services[0].snippets.curl, /X-API-Key: YOUR_API_KEY/);
    assert.match(out.services[0].snippets.python, /import requests/);
    assert.match(out.services[0].snippets.typescript, /await fetch/);
    assert.ok(out.next_steps.some((s) => /get_subnet_health/.test(s)));
  });

  test("how_do_i_call regenerates snippets without cleartext credentials", async () => {
    const cleartextDetail = structuredClone(callDetail);
    const service =
      cleartextDetail["/metagraph/agent-catalog/7.json"].services[0];
    service.base_url = "http://api.data.io";
    service.snippets = {
      curl: "curl -sS 'http://api.data.io' -H 'X-API-Key: YOUR_API_KEY'",
      python:
        'requests.get("http://api.data.io", headers={"X-API-Key": "YOUR_API_KEY"})',
      typescript:
        'fetch("http://api.data.io", { headers: { "X-API-Key": "YOUR_API_KEY" } })',
    };

    const res = await callTool(
      "how_do_i_call",
      { netuid: 7 },
      { deps: makeDeps(cleartextDetail) },
    );

    assert.equal(res.status, 200);
    const snippets = res.body.result.structuredContent.services[0].snippets;
    assert.equal(snippets.curl, "curl -sS 'http://api.data.io'");
    assert.ok(!snippets.curl.includes("YOUR_API_KEY"));
    assert.ok(!snippets.python.includes("YOUR_API_KEY"));
    assert.ok(!snippets.typescript.includes("YOUR_API_KEY"));
  });

  test("how_do_i_call resolves a subnet by chain native_slug", async () => {
    const res = await callTool(
      "how_do_i_call",
      { subnet: "datauniverse" },
      { deps: makeDeps(callDetail) },
    );
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("how_do_i_call explains when a subnet exposes nothing callable", async () => {
    const res = await callTool(
      "how_do_i_call",
      { netuid: 9 },
      { deps: makeDeps(callDetail) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.callable, false);
    assert.equal(out.callable_count, 0);
    assert.match(out.guidance, /no callable services/i);
  });

  test("how_do_i_call requires a netuid or subnet reference", async () => {
    const res = await callTool(
      "how_do_i_call",
      {},
      { deps: makeDeps(callDetail) },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid.*subnet|invalid_params/);
  });
});

describe("MCP goal-shaped tools — branch coverage", () => {
  // Minimal AI env whose vector query returns the given subnet netuids in order.
  function aiEnvWithMatches(netuids) {
    return {
      METAGRAPH_ENABLE_AI: "true",
      AI: {
        run(_model, input) {
          if (input?.text) {
            return Promise.resolve({ data: [new Array(1024).fill(0.02)] });
          }
          return Promise.resolve({ response: "ok" });
        },
      },
      VECTORIZE: {
        query() {
          return Promise.resolve({
            matches: netuids.map((n, i) => ({
              id: `subnet:${n}`,
              score: 0.9 - i * 0.01,
              metadata: {
                type: "subnet",
                netuid: n,
                slug: `sn-${n}`,
                title: `Subnet ${n}`,
                subtitle: "summary",
              },
            })),
          });
        },
      },
    };
  }

  const catalogOnly = {
    "/metagraph/agent-catalog.json": {
      subnets: [
        {
          netuid: 1,
          name: "One",
          slug: "sn-1",
          categories: [],
          integration_readiness: 80,
          callable_count: 1,
          service_kinds: ["openapi"],
          base_url: "https://one.io",
          health: "operational",
        },
        {
          netuid: 2,
          name: "Two",
          slug: "sn-2",
          categories: [],
          integration_readiness: 70,
          callable_count: 1,
          service_kinds: ["sse"],
          base_url: "https://two.io",
          health: "unknown",
        },
      ],
    },
  };

  test("find_subnet_for_task: semantic ranking skips non-callable and honors limit", async () => {
    // netuid 99 is not in the catalog (skipped); limit 1 triggers the early break.
    const res = await callTool(
      "find_subnet_for_task",
      { task: "generate text", limit: 1 },
      { deps: makeDeps(catalogOnly), env: aiEnvWithMatches([99, 1, 2]) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.discovery, "semantic");
    assert.equal(out.count, 1);
    assert.equal(out.results[0].netuid, 1);
  });

  test("find_subnet_for_task: falls back to keyword when semantic search throws", async () => {
    const env = {
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: () => Promise.resolve({ data: [new Array(1024).fill(0)] }) },
      VECTORIZE: { query: () => Promise.reject(new Error("vectorize down")) },
    };
    const deps = makeDeps({
      "/metagraph/search.json": {
        documents: [
          {
            id: "subnet:1",
            type: "subnet",
            netuid: 1,
            slug: "sn-1",
            title: "One",
            subtitle: "text generation",
            tokens: ["text", "generation"],
          },
        ],
      },
      ...catalogOnly,
    });
    const res = await callTool(
      "find_subnet_for_task",
      { task: "generation" },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.discovery, "keyword");
    assert.equal(out.results[0].netuid, 1);
  });

  const callDetail = {
    "/metagraph/agent-catalog/7.json": {
      netuid: 7,
      name: "Data",
      slug: "sn-7",
      integration_readiness: 70,
      services: [
        {
          surface_id: "sn-7-api",
          kind: "subnet-api",
          capability: "Data API",
          base_url: "https://api.data.io",
          auth_required: true,
          auth_schemes: ["apiKey"],
          schema_url: "https://api.data.io/openapi.json",
          schema_artifact: "schemas/sn-7-api.json",
          health: { status: "operational", stale: false },
          eligibility: { callable: true },
        },
      ],
    },
    "/metagraph/agent-catalog/3.json": {
      netuid: 3,
      name: "Bare",
      slug: "sn-3",
      integration_readiness: 40,
      services: [
        {
          surface_id: "sn-3-sse",
          kind: "sse",
          capability: "Stream",
          base_url: "https://s3.io",
          auth_required: false,
          auth_schemes: [],
          schema_url: null,
          schema_artifact: null,
          health: {},
          eligibility: { callable: true },
        },
      ],
    },
    "/metagraph/subnets.json": {
      subnets: [{ netuid: 7, slug: "sn-7", native_slug: "datauniverse" }],
    },
  };

  test("how_do_i_call resolves a numeric subnet string", async () => {
    const res = await callTool(
      "how_do_i_call",
      { subnet: "7" },
      { deps: makeDeps(callDetail) },
    );
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("how_do_i_call resolves a curated slug", async () => {
    const res = await callTool(
      "how_do_i_call",
      { subnet: "sn-7" },
      { deps: makeDeps(callDetail) },
    );
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("how_do_i_call errors on an unknown subnet reference", async () => {
    const res = await callTool(
      "how_do_i_call",
      { subnet: "does-not-exist" },
      { deps: makeDeps(callDetail) },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /No subnet matches|not_found/);
  });

  test("find_subnet_for_task uses keyword when semantic returns no subnet hits", async () => {
    const env = {
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: () => Promise.resolve({ data: [new Array(1024).fill(0)] }) },
      VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
    };
    const deps = makeDeps({
      "/metagraph/search.json": {
        documents: [
          {
            id: "subnet:1",
            type: "subnet",
            netuid: 1,
            slug: "sn-1",
            title: "One",
            subtitle: "text generation",
            tokens: ["text", "generation"],
          },
        ],
      },
      ...catalogOnly,
    });
    const res = await callTool(
      "find_subnet_for_task",
      { task: "generation" },
      { deps, env },
    );
    assert.equal(res.body.result.structuredContent.discovery, "keyword");
  });

  test("how_do_i_call reports a no-auth, no-schema service cleanly", async () => {
    const res = await callTool(
      "how_do_i_call",
      { netuid: 3 },
      { deps: makeDeps(callDetail) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.callable, true);
    assert.equal(out.services[0].auth.required, false);
    assert.equal(out.services[0].schema.available, false);
    assert.equal(out.services[0].health.status, "unknown");
    assert.ok(out.next_steps.every((s) => !/get_api_schema/.test(s)));
  });

  test("how_do_i_call tolerates a detail with no services array", async () => {
    const res = await callTool(
      "how_do_i_call",
      { netuid: 5 },
      { deps: makeDeps({ "/metagraph/agent-catalog/5.json": { netuid: 5, name: "X", slug: "sn-5", integration_readiness: 0 } }) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.callable, false);
    assert.deepEqual(out.services, []);
  });

  test("how_do_i_call handles a callable service missing auth_schemes + schema_url", async () => {
    const res = await callTool(
      "how_do_i_call",
      { netuid: 4 },
      {
        deps: makeDeps({
          "/metagraph/agent-catalog/4.json": {
            netuid: 4,
            name: "Y",
            slug: "sn-4",
            integration_readiness: 50,
            services: [
              {
                surface_id: "sn-4-api",
                kind: "openapi",
                capability: "Y API",
                base_url: "https://y.io",
                auth_required: true,
                schema_artifact: "schemas/sn-4-api.json",
                schema_url: null,
                health: { status: "operational" },
                eligibility: { callable: true },
              },
            ],
          },
        }),
      },
    );
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.services[0].auth.schemes, []);
    assert.equal(out.services[0].schema.available, true);
    assert.equal(out.services[0].schema.schema_url, null);
  });

  test("find_subnet_for_task tolerates a catalog with no subnets field", async () => {
    const env = aiEnvWithMatches([1, 2]);
    const res = await callTool(
      "find_subnet_for_task",
      { task: "anything" },
      { deps: makeDeps({ "/metagraph/agent-catalog.json": {} }), env },
    );
    assert.equal(res.body.result.structuredContent.count, 0);
  });

  describe("live health overlay (warm KV overrides stale static)", () => {
    const staticHealth = {
      schema_version: 1,
      netuid: 7,
      summary: { status: "ok", surface_count: 1 },
      surfaces: [{ surface_id: "7:subnet-api:x", netuid: 7, status: "ok" }],
    };
    const staticCatalog = {
      netuid: 7,
      services: [
        {
          surface_id: "7:subnet-api:x",
          base_url: "https://x",
          health: { status: "ok", stale: true },
          eligibility: { callable: true, reasons: [] },
        },
      ],
    };
    const liveKv = {
      last_run_at: "2026-06-13T00:00:00.000Z",
      surfaces: [
        {
          surface_id: "7:subnet-api:x",
          netuid: 7,
          status: "failed",
          classification: "down",
          latency_ms: null,
          last_ok: "2026-06-12T00:00:00.000Z",
          last_checked: "2026-06-13T00:00:00.000Z",
        },
      ],
      subnets: [{ netuid: 7, status: "failed", surface_count: 1, ok_count: 0 }],
    };

    test("get_subnet_health returns LIVE status, not the static artifact", async () => {
      const deps = makeDeps(
        { "/metagraph/health/subnets/7.json": staticHealth },
        { "health:current": liveKv },
      );
      const res = await callTool("get_subnet_health", { netuid: 7 }, { deps });
      const out = res.body.result.structuredContent;
      assert.equal(out.surfaces[0].status, "failed");
      assert.equal(out.summary.status, "failed");
      assert.equal(out.operational_observed_at, "2026-06-13T00:00:00.000Z");
    });

    test("list_subnet_apis overlays live health + recomputes callable", async () => {
      const deps = makeDeps(
        { "/metagraph/agent-catalog/7.json": staticCatalog },
        { "health:current": liveKv },
      );
      const res = await callTool("list_subnet_apis", { netuid: 7 }, { deps });
      const out = res.body.result.structuredContent;
      assert.equal(out.services[0].health.status, "failed");
      assert.equal(out.services[0].health.stale, false);
      assert.equal(out.services[0].eligibility.callable, false);
      assert.equal(out.health_source, "live-cron-prober");
    });

    test("cold KV → static current-health is NOT served (live-only); reports unknown", async () => {
      const deps = makeDeps({
        "/metagraph/health/subnets/7.json": staticHealth,
      });
      const res = await callTool("get_subnet_health", { netuid: 7 }, { deps });
      assert.equal(res.body.result.structuredContent.summary.status, "unknown");
    });

    test("get_subnet_health with neither live nor static → unknown, never baked", async () => {
      const res = await callTool(
        "get_subnet_health",
        { netuid: 7 },
        { deps: makeDeps() },
      );
      const out = res.body.result.structuredContent;
      assert.equal(out.summary.status, "unknown");
      assert.equal(out.health_source, "unavailable");
      assert.equal(out.operational_observed_at, null);
    });

    test("list_subnet_apis cold KV → static services + unavailable freshness", async () => {
      const deps = makeDeps({
        "/metagraph/agent-catalog/7.json": staticCatalog,
      });
      const res = await callTool("list_subnet_apis", { netuid: 7 }, { deps });
      const out = res.body.result.structuredContent;
      assert.equal(out.service_count, 1);
      assert.equal(out.health_source, "unavailable");
      assert.equal(out.operational_observed_at, null);
    });
  });
});
