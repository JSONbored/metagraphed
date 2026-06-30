import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
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
import { EXPOSED_RESPONSE_HEADERS_VALUE } from "../workers/http.mjs";

const MCP_URL = "https://api.metagraph.sh/mcp";

// Fresh prober run time for live KV fixtures — resolveLiveHealth rejects a
// health:current whose last_run_at is older than the 25-min freshness window.
const FRESH_RUN = new Date(Date.now() - 60_000).toISOString();

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

  test("listToolDefinitions exposes name/title/description/inputSchema + annotations + outputSchema", () => {
    const defs = listToolDefinitions();
    assert.equal(defs.length, MCP_TOOLS.length);
    const ajv = new Ajv2020({ strict: false });
    const allowed = new Set([
      "description",
      "inputSchema",
      "name",
      "title",
      "annotations",
      "outputSchema",
    ]);
    for (const def of defs) {
      for (const key of Object.keys(def)) {
        assert.ok(allowed.has(key), `${def.name}: unexpected key ${key}`);
      }
      assert.ok(def.name && def.title && def.description && def.inputSchema);
      // Every tool is read-only with no side effects (clients may auto-run).
      assert.equal(def.annotations.readOnlyHint, true, `${def.name}`);
      assert.equal(def.annotations.destructiveHint, false, `${def.name}`);
      // Every tool declares a compilable object outputSchema for its structuredContent.
      assert.equal(
        typeof def.outputSchema,
        "object",
        `${def.name}: outputSchema`,
      );
      assert.equal(
        def.outputSchema.type,
        "object",
        `${def.name}: outputSchema.type`,
      );
      assert.doesNotThrow(
        () => ajv.compile(def.outputSchema),
        `${def.name}: outputSchema must be a valid JSON Schema`,
      );
    }
  });

  test("concentration history is registered once with a typed point schema", () => {
    const tools = MCP_TOOLS.filter(
      (tool) => tool.name === "get_subnet_concentration_history",
    );
    assert.equal(tools.length, 1);

    const defs = listToolDefinitions().filter(
      (def) => def.name === "get_subnet_concentration_history",
    );
    assert.equal(defs.length, 1);
    const pointProperties =
      defs[0].outputSchema?.properties?.points?.items?.properties;
    assert.ok(pointProperties?.snapshot_date);
    assert.ok(pointProperties?.stake_gini);
    assert.ok(pointProperties?.emission_top_10pct_share);
  });

  test("get_rpc_usage advertises a typed RpcUsageArtifact-shaped outputSchema", () => {
    const def = listToolDefinitions().find((t) => t.name === "get_rpc_usage");
    assert.ok(def);
    const summary = def.outputSchema?.properties?.summary?.properties;
    assert.ok(summary?.total_requests);
    assert.ok(summary?.latency_ms?.properties?.p50);
    const endpoint = def.outputSchema?.properties?.endpoints?.items?.properties;
    assert.ok(endpoint?.endpoint_id);
    assert.ok(endpoint?.error_rate);
    const bucket = def.outputSchema?.properties?.buckets?.items?.properties;
    assert.ok(bucket?.ts);
    assert.ok(bucket?.avg_latency_ms);
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

  test("initialize negotiates the current stable revision (2025-11-25) and carries serverInfo.description", async () => {
    assert.equal(MCP_PROTOCOL_VERSIONS[0], "2025-11-25");
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    assert.equal(res.body.result.protocolVersion, "2025-11-25");
    // Implementation.description added in 2025-11-25.
    assert.equal(typeof res.body.result.serverInfo.description, "string");
    assert.ok(res.body.result.serverInfo.description.length > 0);
  });

  test("ping returns an empty result", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 7, method: "ping" });
    assert.deepEqual(res.body.result, {});
  });

  test("tools/list returns all registered tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(res.body.result.tools.length, MCP_TOOLS.length);
  });

  test("initialize advertises tools + resources + prompts capabilities", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.deepEqual(res.body.result.capabilities, {
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
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

describe("MCP resources (#742)", () => {
  test("resources/templates/list returns the subnet/provider/schema templates", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/templates/list",
    });
    const tpls = res.body.result.resourceTemplates;
    assert.equal(tpls.length, 3);
    assert.deepEqual(tpls.map((t) => t.uriTemplate).sort(), [
      "metagraph://provider/{slug}",
      "metagraph://schema/{surface_id}",
      "metagraph://subnet/{netuid}",
    ]);
    for (const t of tpls) {
      assert.ok(t.name && t.title && t.description && t.mimeType);
    }
  });

  test("resources/list enumerates fixed + subnet/provider/schema resources", async () => {
    const deps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 7, name: "Allways" },
          { netuid: 12, name: "Compute" },
        ],
      },
      "/metagraph/providers.json": {
        providers: [{ slug: "datura", name: "Datura" }],
      },
      "/metagraph/schemas/index.json": {
        schemas: [
          {
            surface_id: "7:subnet-api:allways",
            content_type: "application/json",
          },
        ],
      },
    });
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { deps },
    );
    const uris = res.body.result.resources.map((r) => r.uri);
    assert.ok(uris.includes("metagraph://registry/summary"));
    assert.ok(uris.includes("metagraph://subnet/7"));
    assert.ok(uris.includes("metagraph://provider/datura"));
    assert.ok(uris.includes("metagraph://schema/7:subnet-api:allways"));
    assert.equal(res.body.result.nextCursor, undefined);
    for (const r of res.body.result.resources) {
      assert.ok(r.uri && r.name && r.title && r.mimeType);
    }
  });

  test("resources/list degrades gracefully when indexes are missing", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    const uris = res.body.result.resources.map((r) => r.uri);
    assert.ok(uris.includes("metagraph://registry/summary"));
    assert.ok(uris.includes("metagraph://registry/catalog"));
  });

  test("resources/read returns the backing artifact for a subnet uri", async () => {
    const deps = makeDeps({
      "/metagraph/overview/7.json": { netuid: 7, name: "Allways" },
    });
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "metagraph://subnet/7" },
      },
      { deps },
    );
    const contents = res.body.result.contents;
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, "metagraph://subnet/7");
    assert.equal(contents[0].mimeType, "application/json");
    assert.deepEqual(JSON.parse(contents[0].text), {
      netuid: 7,
      name: "Allways",
    });
  });

  test("resources/read maps a fixed uri to its artifact", async () => {
    const deps = makeDeps({
      "/metagraph/registry-summary.json": { completeness: 0.42 },
    });
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "metagraph://registry/summary" },
      },
      { deps },
    );
    assert.deepEqual(JSON.parse(res.body.result.contents[0].text), {
      completeness: 0.42,
    });
  });

  test("resources/read rejects malformed / traversing uris with -32602", async () => {
    for (const uri of [
      "metagraph://subnet/../secrets",
      "metagraph://subnet/", // empty id
      "metagraph://bogus/1", // unknown type
      "https://evil.example/x", // wrong scheme
    ]) {
      const res = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri },
      });
      assert.equal(res.body.error.code, -32602, `expected -32602 for ${uri}`);
    }
  });
});

describe("MCP prompts (#742)", () => {
  test("prompts/list returns >=3 recipes with arguments", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "prompts/list" });
    const prompts = res.body.result.prompts;
    assert.ok(prompts.length >= 3);
    for (const p of prompts) {
      assert.ok(p.name && p.title && p.description);
      assert.ok(Array.isArray(p.arguments));
    }
    assert.ok(prompts.some((p) => p.name === "integrate_with_subnet"));
  });

  test("prompts/get returns a user message referencing the tools", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: { name: "integrate_with_subnet", arguments: { netuid: 7 } },
    });
    const messages = res.body.result.messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content.type, "text");
    assert.match(messages[0].content.text, /get_subnet/);
    assert.match(messages[0].content.text, /netuid: 7/);
  });

  test("prompts/get rejects a missing required argument with -32602", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: { name: "integrate_with_subnet", arguments: {} },
    });
    assert.equal(res.body.error.code, -32602);
  });

  test("prompts/get rejects an unknown prompt with -32602", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: { name: "does_not_exist", arguments: {} },
    });
    assert.equal(res.body.error.code, -32602);
  });
});

describe("MCP resources/prompts — branch coverage", () => {
  test("resources/list paginates with a cursor over a large catalog", async () => {
    const subnets = Array.from({ length: 130 }, (_, i) => ({
      netuid: i,
      name: `SN${i}`,
    }));
    const deps = makeDeps({ "/metagraph/subnets.json": { subnets } });
    const page1 = await rpc(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { deps },
    );
    assert.equal(page1.body.result.resources.length, 100);
    assert.equal(typeof page1.body.result.nextCursor, "string");
    const page2 = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list",
        params: { cursor: page1.body.result.nextCursor },
      },
      { deps },
    );
    assert.ok(page2.body.result.resources.length > 0);
    assert.equal(page2.body.result.nextCursor, undefined);
  });

  test("resources/list skips malformed index entries + uses fallbacks", async () => {
    const deps = makeDeps({
      // 1st subnet has no name (title fallback); 2nd has no netuid (skipped).
      "/metagraph/subnets.json": {
        subnets: [{ netuid: 0 }, { name: "no-netuid" }],
      },
      // 1st provider's slug comes from id; 2nd has no slug (skipped).
      "/metagraph/providers.json": {
        providers: [{ id: "by-id" }, { name: "no-slug" }],
      },
      // schema ids: from id fallback, with content_type, and an empty (skipped).
      "/metagraph/schemas/index.json": {
        schemas: [
          { id: "s1" },
          { surface_id: "s2", content_type: "text/yaml" },
          {},
        ],
      },
    });
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { deps },
    );
    const uris = res.body.result.resources.map((r) => r.uri);
    assert.ok(uris.includes("metagraph://subnet/0"));
    assert.ok(!uris.some((u) => u.includes("no-netuid")));
    assert.ok(uris.includes("metagraph://provider/by-id"));
    assert.ok(!uris.some((u) => u.includes("no-slug")));
    assert.ok(uris.includes("metagraph://schema/s1"));
    assert.ok(uris.includes("metagraph://schema/s2"));
  });

  test("resources/read returns provider + schema artifacts", async () => {
    const deps = makeDeps({
      "/metagraph/providers/datura.json": { slug: "datura", subnets: [] },
      "/metagraph/schemas/sn-6-openapi.json": {
        surface_id: "sn-6-openapi",
        openapi: "3.1.0",
      },
    });
    const prov = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "metagraph://provider/datura" },
      },
      { deps },
    );
    assert.deepEqual(JSON.parse(prov.body.result.contents[0].text), {
      slug: "datura",
      subnets: [],
    });
    const schema = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "metagraph://schema/sn-6-openapi" },
      },
      { deps },
    );
    assert.equal(
      JSON.parse(schema.body.result.contents[0].text).openapi,
      "3.1.0",
    );
  });

  test("resources/read rejects invalid provider/schema ids + non-string uri", async () => {
    for (const uri of [
      "metagraph://provider/has spaces",
      "metagraph://schema/bad!id",
    ]) {
      const res = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri },
      });
      assert.equal(res.body.error.code, -32602, `expected -32602 for ${uri}`);
    }
    const noUri = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: {},
    });
    assert.equal(noUri.body.error.code, -32602);
  });

  test("prompts/get treats an empty-string required arg as missing", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: { name: "find_subnet_for_task", arguments: { task: "" } },
    });
    assert.equal(res.body.error.code, -32602);
  });

  test("prompts/get builds the find_subnet + check_health recipes", async () => {
    const find = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: {
        name: "find_subnet_for_task",
        arguments: { task: "image generation" },
      },
    });
    assert.match(
      find.body.result.messages[0].content.text,
      /find_subnet_for_task/,
    );
    const health = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/get",
      params: { name: "check_health_and_fallbacks", arguments: { netuid: 7 } },
    });
    assert.match(
      health.body.result.messages[0].content.text,
      /get_subnet_health/,
    );
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

  test("a concurrently-dispatched mixed batch correlates responses by id, not position (#2060)", async () => {
    // Requests interleaved with notifications. The batch is now dispatched
    // concurrently (Promise.all), so correctness must hold via the JSON-RPC `id`
    // correlation regardless of completion order: every request id appears
    // exactly once and the notifications are dropped.
    const res = await rpc([
      { jsonrpc: "2.0", id: 10, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 20, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
      { jsonrpc: "2.0", id: 30, method: "ping" },
    ]);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 3, "three requests → three responses");
    assert.deepEqual(
      res.body.map((r) => r.id).sort((a, b) => a - b),
      [10, 20, 30],
      "every request id is present exactly once",
    );
    // Each response is correlated to its own request by id (not by array slot).
    const byId = new Map(res.body.map((r) => [r.id, r]));
    assert.ok(Array.isArray(byId.get(10).result.tools), "id 10 → tools/list");
    assert.deepEqual(byId.get(20).result, {}, "id 20 → ping result");
    assert.deepEqual(byId.get(30).result, {}, "id 30 → ping result");
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
    // The rate-limit hints must be readable by a cross-origin browser client.
    assert.equal(
      response.headers.get("access-control-expose-headers"),
      EXPOSED_RESPONSE_HEADERS_VALUE,
    );
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
      "/metagraph/coverage-depth.json": {
        schema_version: 1,
        generated_at: "1970-01-01T00:00:00.000Z",
        coverage_depth_version: 1,
        rows: [
          {
            netuid: 7,
            slug: "allways",
            name: "Allways",
            tier: "machine-usable",
            score: 77,
            priority_score: 86,
            agent_status: "callable",
            blocker_level: "none",
            top_gap_codes: ["missing-fixture", "partial-schema-coverage"],
            top_gaps: [
              {
                code: "missing-fixture",
                severity: "missing-data",
                field: "fixtures",
                next_action: "capture a sanitized fixture",
              },
              {
                code: "partial-schema-coverage",
                severity: "missing-data",
                field: "schemas",
                next_action: "capture remaining schemas",
              },
            ],
            recommended_next_action: "capture a sanitized fixture",
            dimensions: {
              callable_service_count: 13,
              service_kinds: ["openapi", "subnet-api"],
              schema_service_count: 12,
              schema_missing_count: 1,
              fixture_available_count: 0,
              fixture_status_counts: { missing: 13 },
              example_count: 0,
              sdk_count: 0,
              candidate_operational_count: 3,
              official_surface_count: 0,
              provider_claimed_surface_count: 15,
            },
          },
          {
            netuid: 31,
            slug: "recall",
            name: "Recall",
            tier: "missing-interface",
            score: 18,
            priority_score: 67,
            agent_status: "blocked",
            blocker_level: "missing-data",
            top_gap_codes: ["missing-callable-service"],
            top_gaps: [
              {
                code: "missing-callable-service",
                severity: "missing-data",
                field: "surfaces",
                next_action: "find an official callable surface",
              },
            ],
            recommended_next_action: "find an official callable surface",
            dimensions: {
              callable_service_count: 0,
              service_kinds: [],
              schema_service_count: 0,
              schema_missing_count: 0,
              fixture_available_count: 0,
              fixture_status_counts: {},
              example_count: 0,
              sdk_count: 0,
              candidate_operational_count: 0,
              official_surface_count: 0,
              provider_claimed_surface_count: 0,
            },
          },
        ],
        ranked_queue: [
          {
            rank: 1,
            netuid: 7,
            tier: "machine-usable",
            score: 77,
            priority_score: 86,
            severity: "missing-data",
            top_gap_codes: ["missing-fixture", "partial-schema-coverage"],
            recommended_next_action: "capture a sanitized fixture",
          },
          {
            rank: 2,
            netuid: 31,
            tier: "missing-interface",
            score: 18,
            priority_score: 67,
            severity: "missing-data",
            top_gap_codes: ["missing-callable-service"],
            recommended_next_action: "find an official callable surface",
          },
        ],
      },
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
    // Pagination envelope mirrors list_subnets: total/offset/limit/next_offset.
    assert.equal(out.total, 1);
    assert.equal(out.count, 1);
    assert.equal(out.offset, 0);
    assert.equal(out.limit, 5);
    assert.equal(out.next_offset, null);
  });

  test("search_subnets clamps the limit and reports zero matches", async () => {
    const res = await callTool(
      "search_subnets",
      { query: "nonexistentxyz", limit: 999 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.count, 0);
    assert.equal(out.total, 0);
    assert.equal(out.next_offset, null);
    // An out-of-range limit clamps to the 50 max, not the raw 999.
    assert.equal(out.limit, 50);
  });

  test("search_subnets limit:0 falls back to the default, not a single result", async () => {
    // tools/call does not enforce inputSchema `minimum:1`, so limit:0 reaches
    // clampLimit. It must fall back to the default (10), not clamp up to 1 — a
    // query matching two subnets returns both, not one.
    const res = await callTool(
      "search_subnets",
      { query: "data compute", limit: 0 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.ok(
      out.results.length >= 2,
      `expected >=2 results (fallback), got ${out.results.length}`,
    );
  });

  test("search_subnets malformed limit values fall back to the default", async () => {
    // tools/call passes raw JSON arguments to handlers, so clampLimit must not
    // coerce schema-invalid values like true or "1" into a one-result limit.
    for (const limit of [true, "1", [1], { toString: null }]) {
      const res = await callTool(
        "search_subnets",
        { query: "data compute", limit },
        { deps },
      );
      const out = res.body.result.structuredContent;
      assert.ok(
        out.results.length >= 2,
        `expected fallback for limit ${JSON.stringify(limit)}, got ${out.results.length}`,
      );
    }
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
    // Pagination envelope mirrors list_subnets: total/offset/limit/next_offset.
    assert.equal(out.total, 1);
    assert.equal(out.offset, 0);
    assert.equal(out.limit, 10);
    assert.equal(out.next_offset, null);
  });

  test("find_subnets_by_capability with no match returns empty", async () => {
    const res = await callTool(
      "find_subnets_by_capability",
      { capability: "gpu" },
      { deps },
    );
    // netuid 12 has gpu but callable_count 0 -> excluded
    const out = res.body.result.structuredContent;
    assert.equal(out.count, 0);
    assert.equal(out.total, 0);
    assert.equal(out.next_offset, null);
  });

  test("get_subnet returns the overview artifact", async () => {
    const res = await callTool("get_subnet", { netuid: 7 }, { deps });
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("get_subnet rejects a non-integer netuid", async () => {
    const res = await callTool("get_subnet", { netuid: "seven" }, { deps });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet maps a missing artifact to a clean not_found (no R2 key leak)", async () => {
    const res = await callTool("get_subnet", { netuid: 999 }, { deps });
    assert.equal(res.body.result.isError, true);
    const text = res.body.result.content[0].text;
    assert.ok(text.includes("not_found"));
    // Must not echo the internal artifact path / R2 key.
    assert.equal(text.includes("/metagraph/overview/999.json"), false);
    assert.equal(text.includes("latest/"), false);
    // Machine-readable error code for agents to branch on.
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
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

  test("get_api_schema and get_fixture resolve deprecated surface_id aliases", async () => {
    const aliasDeps = makeDeps({
      "/metagraph/operational-surfaces.json": {
        surfaces: [
          {
            surface_id: "7:subnet-api:new",
            surface_key: "srf-renamed",
            netuid: 7,
            kind: "subnet-api",
            url: "https://api.example/new",
          },
        ],
      },
      "/metagraph/surface-aliases.json": {
        aliases: [
          {
            deprecated_id: "7:subnet-api:old",
            surface_key: "srf-renamed",
            current_id: "7:subnet-api:new",
            netuid: 7,
            kind: "subnet-api",
          },
        ],
      },
      "/metagraph/schemas/7:subnet-api:new.json": {
        surface_id: "7:subnet-api:new",
        openapi: "3.1.0",
        paths: { "/v1": {} },
      },
      "/metagraph/fixtures/7:subnet-api:new.json": {
        surface_id: "7:subnet-api:new",
        response: { status: 200, body: { renamed: true } },
      },
    });
    const schema = await callTool(
      "get_api_schema",
      { surface_id: "7:subnet-api:old" },
      { deps: aliasDeps },
    );
    assert.equal(schema.body.result.structuredContent.openapi, "3.1.0");

    const fixture = await callTool(
      "get_fixture",
      { surface_id: "7:subnet-api:old" },
      { deps: aliasDeps },
    );
    assert.deepEqual(fixture.body.result.structuredContent.response.body, {
      renamed: true,
    });
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

  test("list_enrichment_targets returns ranked coverage-depth targets", async () => {
    const res = await callTool(
      "list_enrichment_targets",
      { limit: 1 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.targets[0].netuid, 7);
    assert.equal(out.targets[0].rank, 1);
    assert.equal(
      out.targets[0].top_gap_codes.includes("missing-fixture"),
      true,
    );
    assert.equal(out.targets[0].dimensions.callable_service_count, 13);
    assert.match(out.note, /not live uptime/);
  });

  test("list_enrichment_targets filters by gap and returns a netuid row", async () => {
    const filtered = await callTool(
      "list_enrichment_targets",
      { gap_code: "missing-callable-service" },
      { deps },
    );
    const out = filtered.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.targets[0].netuid, 31);

    const row = await callTool(
      "list_enrichment_targets",
      { netuid: 7, severity: "missing-data" },
      { deps },
    );
    const rowOut = row.body.result.structuredContent;
    assert.equal(rowOut.targets[0].netuid, 7);
    assert.equal(rowOut.targets[0].rank, null);
  });

  test("list_enrichment_targets reports missing coverage-depth artifact", async () => {
    const missingDeps = makeDeps({});
    const res = await callTool(
      "list_enrichment_targets",
      {},
      { deps: missingDeps },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /No resource/);
  });

  const opportunityDeps = makeDeps({
    "/metagraph/economics.json": {
      captured_at: "2026-06-20T00:00:00Z",
      subnets: [
        {
          netuid: 10,
          slug: "ten",
          name: "Ten",
          open_slots: 200,
          max_uids: 256,
          registration_cost_tao: 1,
          registration_allowed: true,
          emission_share: 0.1,
          total_stake_tao: 5000,
          validator_count: 10,
          miner_count: 46,
          max_validators: 64,
        },
        {
          netuid: 11,
          slug: "eleven",
          name: "Eleven",
          open_slots: 50,
          registration_cost_tao: 0.5,
          registration_allowed: true,
          emission_share: 0.3,
          total_stake_tao: 9000,
          validator_count: 60,
          miner_count: 18,
          max_validators: 64,
        },
      ],
    },
  });

  test("find_subnet_opportunities ranks the economic boards", async () => {
    const res = await callTool(
      "find_subnet_opportunities",
      { limit: 10 },
      { deps: opportunityDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.with_economics_count, 2);
    assert.equal(out.observed_at, "2026-06-20T00:00:00Z");
    // Only the four economic boards are returned (no operational boards).
    assert.deepEqual(Object.keys(out.boards).sort(), [
      "cheapest-registration",
      "highest-emission",
      "open-slots",
      "validator-headroom",
    ]);
    assert.deepEqual(
      out.boards["open-slots"].map((e) => e.netuid),
      [10, 11],
    );
    assert.deepEqual(
      out.boards["highest-emission"].map((e) => e.netuid),
      [11, 10],
    );
  });

  test("find_subnet_opportunities filters to a single board", async () => {
    const res = await callTool(
      "find_subnet_opportunities",
      { board: "cheapest-registration", limit: 1 },
      { deps: opportunityDeps },
    );
    const out = res.body.result.structuredContent;
    assert.deepEqual(Object.keys(out.boards), ["cheapest-registration"]);
    assert.equal(out.boards["cheapest-registration"].length, 1);
    assert.equal(out.boards["cheapest-registration"][0].netuid, 11);
  });

  test("find_subnet_opportunities rejects an unknown board", async () => {
    const res = await callTool(
      "find_subnet_opportunities",
      { board: "bogus" },
      { deps: opportunityDeps },
    );
    assert.equal(res.body.result.isError, true);
  });

  test("find_subnet_opportunities reports a missing economics artifact", async () => {
    const res = await callTool(
      "find_subnet_opportunities",
      {},
      { deps: makeDeps({}) },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /No resource/);
  });

  test("find_subnet_opportunities tolerates an economics artifact with no subnets", async () => {
    // No subnets array -> empty boards; observed_at falls back to generated_at.
    let res = await callTool(
      "find_subnet_opportunities",
      {},
      {
        deps: makeDeps({
          "/metagraph/economics.json": { generated_at: "2026-06-19T00:00:00Z" },
        }),
      },
    );
    let out = res.body.result.structuredContent;
    assert.equal(out.with_economics_count, 0);
    assert.equal(out.observed_at, "2026-06-19T00:00:00Z");
    for (const key of [
      "open-slots",
      "cheapest-registration",
      "highest-emission",
      "validator-headroom",
    ]) {
      assert.deepEqual(out.boards[key], []);
    }

    // Neither captured_at nor generated_at -> observed_at is null.
    res = await callTool(
      "find_subnet_opportunities",
      {},
      { deps: makeDeps({ "/metagraph/economics.json": {} }) },
    );
    assert.equal(res.body.result.structuredContent.observed_at, null);
  });
});

// get_chain_activity reaches the Postgres-backed all-events tier through the
// DATA_API service binding (the same binding the REST /chain-events/stats proxy
// uses), so its tests mock that binding via env rather than the injected deps.
describe("MCP get_chain_activity (DATA_API binding)", () => {
  // A stub DATA_API binding: records the requested URL and returns the supplied
  // stats payload (or a non-OK response when `status` is given).
  function makeDataApi({ payload, status = 200 } = {}) {
    const calls = [];
    return {
      calls,
      fetch(request) {
        calls.push(new URL(request.url));
        return Promise.resolve(
          new Response(status === 200 ? JSON.stringify(payload) : "err", {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    };
  }

  test("returns the pallet.method aggregate from the data Worker", async () => {
    const dataApi = makeDataApi({
      payload: {
        window_blocks: 1000,
        groups: 2,
        activity: [
          { pallet: "SubtensorModule", method: "set_weights", count: 42 },
          { pallet: "System", method: "ExtrinsicSuccess", count: 7 },
        ],
      },
    });
    const res = await callTool(
      "get_chain_activity",
      {},
      { env: { DATA_API: dataApi } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window_blocks, 1000);
    assert.equal(out.groups, 2);
    assert.equal(out.activity.length, 2);
    assert.equal(out.activity[0].pallet, "SubtensorModule");
    // Default window is 1000 blocks when `blocks` is omitted.
    assert.equal(
      dataApi.calls[0].searchParams.get("blocks"),
      "1000",
      "omitted blocks must default to 1000",
    );
  });

  test("passes an explicit blocks window through to the data Worker", async () => {
    const dataApi = makeDataApi({
      payload: { window_blocks: 250, groups: 0, activity: [] },
    });
    const res = await callTool(
      "get_chain_activity",
      { blocks: 250 },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(dataApi.calls[0].searchParams.get("blocks"), "250");
  });

  test("applies the data API limiter before fetching chain activity", async () => {
    const dataApi = makeDataApi({
      payload: { window_blocks: 1000, groups: 0, activity: [] },
    });
    const limiterKeys = [];
    const res = await callTool(
      "get_chain_activity",
      {},
      {
        env: {
          DATA_API: dataApi,
          DATA_RATE_LIMITER: {
            async limit({ key }) {
              limiterKeys.push(key);
              return { success: false };
            },
          },
        },
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /Too many data API requests/);
    assert.deepEqual(limiterKeys, ["data:anonymous"]);
    assert.equal(dataApi.calls.length, 0);
  });

  test("charges the data API limiter for each batched chain activity call", async () => {
    const dataApi = makeDataApi({
      payload: { window_blocks: 1000, groups: 0, activity: [] },
    });
    const limiterKeys = [];
    const res = await rpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_chain_activity", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_chain_activity", arguments: {} },
        },
      ],
      {
        env: {
          DATA_API: dataApi,
          DATA_RATE_LIMITER: {
            async limit({ key }) {
              limiterKeys.push(key);
              return { success: true };
            },
          },
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.deepEqual(limiterKeys, ["data:anonymous", "data:anonymous"]);
    assert.equal(dataApi.calls.length, 2);
  });

  test("clamps an over-cap blocks window to 5000", async () => {
    const dataApi = makeDataApi({
      payload: { window_blocks: 5000, groups: 0, activity: [] },
    });
    await callTool(
      "get_chain_activity",
      { blocks: 99999 },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(dataApi.calls[0].searchParams.get("blocks"), "5000");
  });

  test("rejects a non-positive / non-integer blocks argument", async () => {
    for (const blocks of [0, -5, 1.5]) {
      const res = await callTool(
        "get_chain_activity",
        { blocks },
        { env: { DATA_API: makeDataApi() } },
      );
      assert.equal(res.body.result.isError, true, `blocks=${blocks}`);
      assert.ok(res.body.result.content[0].text.includes("blocks"));
    }
  });

  test("errors cleanly when the DATA_API binding is absent", async () => {
    const res = await callTool("get_chain_activity", {}, { env: {} });
    assert.equal(res.body.result.isError, true);
    assert.ok(
      res.body.result.content[0].text.includes("chain activity tier"),
      "must surface a clear tier-unavailable message",
    );
  });

  test("errors cleanly when the data Worker returns a non-OK response", async () => {
    const dataApi = makeDataApi({ status: 502 });
    const res = await callTool(
      "get_chain_activity",
      {},
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("502"));
  });
});

describe("MCP get_chain_signers", () => {
  test("returns signers ranked by tx_count from D1", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async all() {
                  assert.match(sql, /FROM extrinsics/);
                  assert.ok(params.includes(50));
                  return {
                    results: [
                      {
                        signer:
                          "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
                        tx_count: 12,
                        total_fee_tao: 1.5,
                        total_tip_tao: 0.25,
                        last_tx_block: 4200000,
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      },
    };
    const res = await callTool(
      "get_chain_signers",
      { window: "7d", limit: 50 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.signer_count, 1);
    assert.equal(out.signers[0].tx_count, 12);
    assert.equal(out.signers[0].total_fee_tao, 1.5);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool("get_chain_signers", { window: "99d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/i);
  });

  test("rejects an over-long call_module", async () => {
    const res = await callTool(
      "get_chain_signers",
      { call_module: "x".repeat(101) },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /call_module/i);
  });

  test("scopes the leaderboard by call_module", async () => {
    let boundModule;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              boundModule = params[1];
              return {
                async all() {
                  assert.match(sql, /call_module = \?/);
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    };
    const res = await callTool(
      "get_chain_signers",
      { window: "30d", call_module: "Balances", limit: 10 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(boundModule, "Balances");
  });

  test("returns an empty leaderboard on a cold D1 store", async () => {
    const res = await callTool("get_chain_signers", {}, {});
    const out = res.body.result.structuredContent;
    assert.equal(out.signer_count, 0);
    assert.deepEqual(out.signers, []);
  });
});

describe("MCP get_rpc_usage", () => {
  function rpcUsageDb() {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(..._params) {
              return {
                async all() {
                  if (/COUNT\(\*\) AS total/.test(sql)) {
                    return {
                      results: [
                        {
                          total: 50,
                          ok_count: 48,
                          failover_count: 2,
                          cache_hits: 10,
                          avg_latency_ms: 80,
                        },
                      ],
                    };
                  }
                  if (/ROW_NUMBER\(\) OVER/.test(sql)) {
                    return { results: [{ p50: 70, p95: 200 }] };
                  }
                  if (/GROUP BY endpoint_id/.test(sql)) {
                    return {
                      results: [
                        {
                          endpoint_id: "a",
                          provider: "p",
                          requests: 50,
                          ok_count: 48,
                          avg_latency_ms: 80,
                        },
                      ],
                    };
                  }
                  if (/GROUP BY network/.test(sql)) {
                    return {
                      results: [
                        { network: "finney", requests: 50, ok_count: 48 },
                      ],
                    };
                  }
                  if (/GROUP BY ts/.test(sql)) {
                    return {
                      results: [
                        {
                          ts: 1_700_000_000_000,
                          requests: 5,
                          errors: 0,
                          avg_latency_ms: 75,
                        },
                      ],
                    };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    };
  }

  test("returns usage analytics from rpc_proxy_events", async () => {
    const res = await callTool(
      "get_rpc_usage",
      { window: "7d" },
      { env: rpcUsageDb() },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.summary.total_requests, 50);
    assert.equal(out.endpoints[0].endpoint_id, "a");
    assert.equal(out.networks[0].network, "finney");
    assert.equal(out.buckets.length, 1);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool("get_rpc_usage", { window: "99d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/i);
  });

  test("returns a cold-stable zeroed payload on empty D1", async () => {
    const res = await callTool("get_rpc_usage", {}, {});
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.summary.total_requests, 0);
    assert.deepEqual(out.endpoints, []);
    assert.deepEqual(out.buckets, []);
  });

  test("cold and populated payloads validate against the declared outputSchema", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(
      listToolDefinitions().find((t) => t.name === "get_rpc_usage")
        .outputSchema,
    );
    for (const [label, env] of [
      ["cold", {}],
      ["populated", rpcUsageDb()],
    ]) {
      const res = await callTool("get_rpc_usage", { window: "7d" }, { env });
      assert.ok(
        validate(res.body.result.structuredContent),
        `${label}: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});

describe("MCP get_account_counterparties", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const CP = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";

  // Returns the canned rows for the Transfer-tier read; records every query.
  function cpD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  return Promise.resolve({
                    results: /event_kind = 'Transfer'/.test(sql) ? rows : [],
                  });
                },
              };
            },
          };
        },
      },
    };
  }

  test("ranks counterparties by transfer volume from D1", async () => {
    const capture = [];
    const env = cpD1(
      [
        { hotkey: SS58, coldkey: "A", amount_tao: 100, block_number: 10 },
        { hotkey: "C", coldkey: SS58, amount_tao: 200, block_number: 7 },
      ],
      capture,
    );
    const res = await callTool(
      "get_account_counterparties",
      { ss58: SS58, limit: 10 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.counterparty_count, 2);
    assert.equal(out.counterparties[0].address, "C"); // highest volume (200)
    // The single read is the bounded two-side union, never a hotkey/coldkey OR.
    const q = capture.find((c) => /event_kind = 'Transfer'/.test(c.sql));
    assert.match(q.sql, /UNION ALL/);
    assert.equal(q.sql.includes(" OR "), false);
    assert.deepEqual(q.params.slice(0, 3), [SS58, SS58, SS58]);
  });

  test("counterparty=<ss58> drills into the nested relationship detail", async () => {
    const env = cpD1([
      {
        block_number: 20,
        event_index: 2,
        hotkey: SS58,
        coldkey: CP,
        netuid: 1,
        amount_tao: 40,
        observed_at: 1700,
      },
      {
        block_number: 18,
        event_index: 1,
        hotkey: CP,
        coldkey: SS58,
        netuid: 1,
        amount_tao: 10,
        observed_at: 1600,
      },
    ]);
    const res = await callTool(
      "get_account_counterparties",
      { ss58: SS58, counterparty: CP },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.counterparty_count, 1);
    assert.equal(out.counterparties[0].address, CP);
    assert.equal(out.relationship.counterparty, CP);
    assert.equal(out.relationship.transfer_count, 2);
    assert.equal(out.relationship.net_tao, -30); // 10 received - 40 sent
  });

  test("rejects a malformed counterparty before any D1 work", async () => {
    const res = await callTool(
      "get_account_counterparties",
      { ss58: SS58, counterparty: "not-ss58" },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /counterparty/);
  });

  test("rejects a counterparty equal to ss58", async () => {
    const res = await callTool(
      "get_account_counterparties",
      { ss58: SS58, counterparty: SS58 },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /differ/);
  });

  test("rejects a malformed ss58", async () => {
    const res = await callTool(
      "get_account_counterparties",
      { ss58: "bad" },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/);
  });

  test("degrades to an empty rollup on cold D1", async () => {
    const res = await callTool("get_account_counterparties", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.counterparty_count, 0);
    assert.deepEqual(out.counterparties, []);
  });
});

// keyword-search.test.mjs covers the scoring matrix; here we only prove both
// tools are wired to it — substring noise is gone and the precise target wins.
describe("MCP keyword discovery relevance", () => {
  const deps = makeDeps({
    "/metagraph/search.json": {
      documents: [
        {
          type: "subnet",
          netuid: 1,
          slug: "targon",
          title: "Targon",
          subtitle: "AI inference network",
          tokens: ["ai", "inference", "llm"],
        },
        {
          // "Brain" / "domain" only contain "ai" as a mid-word substring — the
          // old includes() ranking surfaced these for a query of "ai".
          type: "subnet",
          netuid: 2,
          slug: "braintrust",
          title: "BrainTrust",
          subtitle: "domain registrar",
          tokens: ["brain", "domain", "captain"],
        },
      ],
    },
    "/metagraph/agent-catalog.json": {
      subnets: [
        {
          netuid: 1,
          slug: "targon",
          name: "Targon",
          categories: ["ai", "inference"],
          service_kinds: ["subnet-api"],
          callable_count: 5,
          integration_readiness: 90,
        },
        {
          netuid: 2,
          slug: "braintrust",
          name: "BrainTrust",
          categories: ["brain", "domain"],
          service_kinds: ["subnet-api"],
          callable_count: 5,
          integration_readiness: 90,
        },
      ],
    },
  });

  test('search_subnets: "ai" matches the real AI subnet, not "brain"/"domain"', async () => {
    const res = await callTool("search_subnets", { query: "ai" }, { deps });
    const out = res.body.result.structuredContent;
    assert.deepEqual(
      out.results.map((r) => r.netuid),
      [1],
    );
  });

  test("search_subnets: an exact name match wins outright", async () => {
    const res = await callTool("search_subnets", { query: "targon" }, { deps });
    assert.equal(res.body.result.structuredContent.results[0].netuid, 1);
  });

  test('find_subnets_by_capability: "ai" excludes the substring-only subnet', async () => {
    const res = await callTool(
      "find_subnets_by_capability",
      { capability: "ai" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.deepEqual(
      out.results.map((r) => r.netuid),
      [1],
    );
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

  test("a readArtifact rejection is a sanitized isError result (no internal leak)", async () => {
    const throwingDeps = {
      readArtifact() {
        return Promise.reject(new Error("kv exploded"));
      },
      readHealthKv() {
        return Promise.resolve(null);
      },
    };
    const res = await callTool("registry_summary", {}, { deps: throwingDeps });
    // A non-toolError stays inside the tool-result contract (isError, not a
    // -32603 transport error) and must not echo the raw internal message.
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "internal_error",
    );
    assert.ok(!JSON.stringify(res.body).includes("kv exploded"));
  });

  test("a non-toolError from a protocol method is a sanitized -32603 (no leak)", async () => {
    // resources/read -> readResource -> loadArtifactData; a raw readArtifact
    // rejection is a non-toolError that reaches dispatchMessage's internal-error
    // path, which must withhold the raw message (not just tool calls).
    const throwingDeps = {
      readArtifact() {
        return Promise.reject(new Error("kv exploded"));
      },
      readHealthKv() {
        return Promise.resolve(null);
      },
    };
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "metagraph://subnet/7" },
      },
      { deps: throwingDeps },
    );
    assert.equal(res.body.error.code, -32603);
    assert.equal(res.body.error.message, "Internal error.");
    assert.ok(!JSON.stringify(res.body).includes("kv exploded"));
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

  test("semantic_search forwards the type scope to Vectorize", async () => {
    const env = aiEnv();
    let lastOptions;
    env.VECTORIZE.query = (_vector, options) => {
      lastOptions = options;
      return Promise.resolve({ matches: [] });
    };
    const res = await callTool(
      "semantic_search",
      { query: "images", type: ["subnet", "provider"] },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(lastOptions.filter, {
      type: { $in: ["subnet", "provider"] },
    });
  });

  test("semantic_search rejects an unknown type with invalid_params", async () => {
    const res = await callTool(
      "semantic_search",
      { query: "images", type: "widget" },
      { env: aiEnv() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /Unknown type|Valid types/);
  });

  test("ask forwards the type scope to Vectorize", async () => {
    const env = aiEnv();
    let lastOptions;
    env.VECTORIZE.query = (_vector, options) => {
      lastOptions = options;
      return Promise.resolve({ matches: [] });
    };
    const res = await callTool(
      "ask",
      { question: "which providers?", type: "provider" },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(lastOptions.filter, { type: "provider" });
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

  test("find_subnet_for_task surfaces a callable subnet ranked beyond the non-callable pool", async () => {
    // Regression: callability must be filtered BEFORE the rank pool is
    // truncated. Here 51 non-callable subnets tie with (and, by the ascending
    // netuid tiebreak, out-rank) the single callable subnet 999, pushing it to
    // pool position 52 — past the hard-coded poolSize of 50. Filtering after the
    // slice would drop it and falsely report "no callable subnet matched".
    const documents = [];
    for (let netuid = 1; netuid <= 51; netuid += 1) {
      documents.push({
        id: `subnet:${netuid}`,
        type: "subnet",
        netuid,
        slug: `sn-${netuid}`,
        title: "Data tool",
        tokens: ["data"],
        categories: ["data"],
      });
    }
    documents.push({
      id: "subnet:999",
      type: "subnet",
      netuid: 999,
      slug: "sn-999",
      title: "Data tool",
      tokens: ["data"],
      categories: ["data"],
    });
    const fixture = {
      "/metagraph/search.json": { documents },
      "/metagraph/agent-catalog.json": {
        subnets: [
          {
            netuid: 999,
            name: "Callable data API",
            slug: "sn-999",
            categories: ["data"],
            integration_readiness: 60,
            callable_count: 3,
            service_kinds: ["subnet-api"],
            base_url: "https://api.example.io",
            health: "operational",
          },
        ],
      },
    };
    const res = await callTool(
      "find_subnet_for_task",
      { task: "data", limit: 5 },
      { deps: makeDeps(fixture) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.discovery, "keyword");
    assert.equal(out.count, 1);
    assert.equal(out.results[0].netuid, 999);
    assert.equal(out.note, undefined);
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
    assert.equal(out.services[0].fixture.available, false);
    assert.equal(out.services[0].fixture.status, "missing");
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

  test("how_do_i_call surfaces fixture fetch instructions when available", async () => {
    const fixtureDetail = structuredClone(callDetail);
    const service =
      fixtureDetail["/metagraph/agent-catalog/7.json"].services[0];
    service.fixture = {
      captured_at: "2026-06-18T00:00:00.000Z",
      request: { method: "GET", url: "https://api.data.io" },
      response: { status: 200, content_type: "application/json" },
      artifact_path: "/metagraph/fixtures/sn-7-api.json",
    };
    service.fixture_status = {
      status: "available",
      reason: null,
      artifact_path: "/metagraph/fixtures/sn-7-api.json",
      captured_at: "2026-06-18T00:00:00.000Z",
    };

    const res = await callTool(
      "how_do_i_call",
      { netuid: 7 },
      { deps: makeDeps(fixtureDetail) },
    );

    const out = res.body.result.structuredContent;
    assert.equal(out.services[0].fixture.available, true);
    assert.equal(
      out.services[0].fixture.fetch_with,
      "get_fixture with surface_id sn-7-api",
    );
    assert.ok(out.next_steps.some((s) => /get_fixture/.test(s)));
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
    assert.match(
      res.body.result.content[0].text,
      /netuid.*subnet|invalid_params/,
    );
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
    assert.match(
      res.body.result.content[0].text,
      /No subnet matches|not_found/,
    );
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
      {
        deps: makeDeps({
          "/metagraph/agent-catalog/5.json": {
            netuid: 5,
            name: "X",
            slug: "sn-5",
            integration_readiness: 0,
          },
        }),
      },
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
    // Semantic hits that aren't callable (empty catalog) now fall through to
    // keyword discovery, so search.json must be present (empty here) — still 0.
    const res = await callTool(
      "find_subnet_for_task",
      { task: "anything" },
      {
        deps: makeDeps({
          "/metagraph/agent-catalog.json": {},
          "/metagraph/search.json": { documents: [] },
        }),
        env,
      },
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
      last_run_at: FRESH_RUN,
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
      assert.equal(out.operational_observed_at, FRESH_RUN);
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

    test("find_subnet_for_task overlays live health onto ranked results", async () => {
      const deps = makeDeps(
        {
          "/metagraph/search.json": {
            documents: [
              {
                type: "subnet",
                netuid: 7,
                slug: "x",
                title: "X",
                tokens: ["bitcoin", "data"],
              },
            ],
          },
          "/metagraph/agent-catalog.json": {
            subnets: [
              {
                netuid: 7,
                slug: "x",
                name: "X",
                categories: ["bitcoin"],
                service_kinds: ["subnet-api"],
                callable_count: 3,
                integration_readiness: 80,
              },
            ],
          },
        },
        { "health:current": liveKv },
      );
      const res = await callTool(
        "find_subnet_for_task",
        { task: "bitcoin" },
        { deps },
      );
      const match = res.body.result.structuredContent.results.find(
        (r) => r.netuid === 7,
      );
      assert.ok(match, "subnet 7 should rank for the task");
      // health reflects the LIVE probe ("failed"), not the build-time stub.
      assert.equal(match.health, "failed");
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

describe("list_subnets", () => {
  const deps = makeDeps({
    "/metagraph/subnets.json": {
      subnets: [
        {
          netuid: 0,
          slug: "root",
          name: "root",
          subnet_type: "root",
          status: "active",
          integration_readiness: 15,
          surface_count: 17,
          categories: [],
        },
        {
          netuid: 7,
          slug: "allways",
          name: "Allways",
          subnet_type: "application",
          status: "active",
          integration_readiness: 90,
          surface_count: 4,
          categories: ["inference"],
        },
        {
          netuid: 8,
          slug: "parked",
          name: "Parked",
          subnet_type: "application",
          status: "deprecated",
          integration_readiness: 0,
          surface_count: 0,
          derived_categories: ["data"],
        },
      ],
    },
  });

  test("paginates the full registry and reports next_offset", async () => {
    const res = await callTool("list_subnets", { limit: 2 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 3);
    assert.equal(out.returned, 2);
    assert.equal(out.next_offset, 2);
    assert.equal(out.subnets[0].netuid, 0);
    assert.equal(out.subnets[0].title, "root");
    assert.equal(out.subnets[0].integration_readiness, 15);
  });

  test("offset reads the tail and clears next_offset", async () => {
    const res = await callTool(
      "list_subnets",
      { offset: 2, limit: 2 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.next_offset, null);
    assert.equal(out.subnets[0].netuid, 8);
  });

  test("filters by subnet_type, status, min_readiness, and domain", async () => {
    const byType = (
      await callTool("list_subnets", { subnet_type: "application" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byType.total, 2);

    const byStatus = (
      await callTool("list_subnets", { status: "deprecated" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byStatus.total, 1);
    assert.equal(byStatus.subnets[0].netuid, 8);

    const byReadiness = (
      await callTool("list_subnets", { min_readiness: 50 }, { deps })
    ).body.result.structuredContent;
    assert.equal(byReadiness.total, 1);
    assert.equal(byReadiness.subnets[0].netuid, 7);

    const byDomain = (
      await callTool("list_subnets", { domain: "data" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byDomain.total, 1);
    assert.equal(byDomain.subnets[0].netuid, 8);
  });

  // Fixture readiness: {0:15, 7:90, 8:0}; surface_count: {0:17, 7:4, 8:0}.
  const rangeNetuids = (out) =>
    out.subnets.map((s) => s.netuid).sort((a, b) => a - b);

  test("max_readiness keeps rows <= the bound (complement of min_readiness)", async () => {
    const out = (
      await callTool("list_subnets", { max_readiness: 50 }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [0, 8]); // 15 and 0 pass; 90 drops
  });

  test("min_readiness + max_readiness form an inclusive range", async () => {
    const out = (
      await callTool(
        "list_subnets",
        { min_readiness: 10, max_readiness: 50 },
        { deps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [0]); // only readiness 15 is in [10,50]
  });

  test("min_/max_surface_count bound the callable-surface count", async () => {
    const atLeast5 = (
      await callTool("list_subnets", { min_surface_count: 5 }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(atLeast5), [0]); // only 17 >= 5

    const atMost4 = (
      await callTool("list_subnets", { max_surface_count: 4 }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(atMost4), [7, 8]); // 4 and 0
  });

  test("min_/max_netuid bound the id range", async () => {
    const out = (
      await callTool("list_subnets", { min_netuid: 1, max_netuid: 7 }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [7]); // 0 below, 8 above
  });

  test("a row whose bounded field is absent or non-numeric is excluded", async () => {
    const localDeps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, slug: "a", name: "A", surface_count: 6 },
          { netuid: 2, slug: "b", name: "B" }, // surface_count absent
          { netuid: 3, slug: "c", name: "C", surface_count: "lots" }, // non-numeric
        ],
      },
    });
    const out = (
      await callTool(
        "list_subnets",
        { min_surface_count: 0 },
        { deps: localDeps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [1]); // 2 (absent) and 3 (non-numeric) drop even at min 0
  });

  test("sort by integration_readiness desc returns the most ready first + echoes order", async () => {
    const out = (
      await callTool(
        "list_subnets",
        { sort: "integration_readiness", order: "desc" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [7, 0, 8],
    );
    assert.equal(out.sort, "integration_readiness");
    assert.equal(out.order, "desc");
  });

  test("sort defaults to ascending when order is omitted", async () => {
    const out = (
      await callTool(
        "list_subnets",
        { sort: "integration_readiness" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [8, 0, 7],
    );
    assert.equal(out.order, "asc");
  });

  test("sort by name uses string comparison", async () => {
    const out = (await callTool("list_subnets", { sort: "name" }, { deps }))
      .body.result.structuredContent;
    // Allways (7), Parked (8), root (0)
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [7, 8, 0],
    );
  });

  test("no sort preserves source order and reports sort/order null", async () => {
    const out = (await callTool("list_subnets", {}, { deps })).body.result
      .structuredContent;
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [0, 7, 8],
    );
    assert.equal(out.sort, null);
    assert.equal(out.order, null);
  });

  test("rejects an unknown sort field or order value", async () => {
    const badSort = await callTool("list_subnets", { sort: "bogus" }, { deps });
    assert.equal(badSort.body.result.isError, true);
    assert.ok(badSort.body.result.content[0].text.includes("sort"));
    const badOrder = await callTool(
      "list_subnets",
      { sort: "netuid", order: "sideways" },
      { deps },
    );
    assert.equal(badOrder.body.result.isError, true);
    assert.ok(badOrder.body.result.content[0].text.includes("order"));
  });

  test("unscored subnets sort last and equal values tie-break by netuid", async () => {
    const tieDeps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 5, name: "E", integration_readiness: 50 },
          { netuid: 3, name: "C", integration_readiness: 50 },
          { netuid: 2, name: "B", integration_readiness: 80 },
          { netuid: 9, name: "I" }, // no integration_readiness → null
          { netuid: 1, name: "A" }, // no integration_readiness → null
        ],
      },
    });
    const out = (
      await callTool(
        "list_subnets",
        { sort: "integration_readiness", order: "desc" },
        { deps: tieDeps },
      )
    ).body.result.structuredContent;
    // 80 first; the two 50s tie → netuid asc (3,5); the nulls sort last → netuid
    // asc (1,9), even under desc.
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [2, 3, 5, 1, 9],
    );
  });

  test("a scored subnet sorts before an unscored one for either input order", async () => {
    // Reversing the input flips which side of the comparator the null lands on,
    // so both nulls-last branches are exercised; the result is the same.
    for (const subnets of [
      [
        { netuid: 1, name: "A", integration_readiness: 10 },
        { netuid: 2, name: "B" },
      ],
      [
        { netuid: 2, name: "B" },
        { netuid: 1, name: "A", integration_readiness: 10 },
      ],
    ]) {
      const out = (
        await callTool(
          "list_subnets",
          { sort: "integration_readiness" },
          { deps: makeDeps({ "/metagraph/subnets.json": { subnets } }) },
        )
      ).body.result.structuredContent;
      assert.deepEqual(
        out.subnets.map((s) => s.netuid),
        [1, 2],
      );
    }
  });
});

// The keyword search tools share the list_subnets pagination contract: page
// through a match set larger than one page and confirm every ranked item is
// reachable and next_offset clears at the end.
describe("search tools pagination", () => {
  const MATCH_COUNT = 60; // > the 50-per-page cap, so paging is mandatory
  const searchDocs = Array.from({ length: MATCH_COUNT }, (_, i) => ({
    type: "subnet",
    netuid: i + 1,
    slug: `pageable-${i + 1}`,
    title: `Pageable ${i + 1}`,
    subtitle: "pageable subnet",
    tokens: ["pageable"],
  }));
  const catalogSubnets = Array.from({ length: MATCH_COUNT }, (_, i) => ({
    netuid: i + 1,
    slug: `pageable-${i + 1}`,
    name: `Pageable ${i + 1}`,
    categories: ["pageable"],
    service_kinds: ["subnet-api"],
    callable_count: 1,
    // Distinct readiness => a total order with no ties to depend on.
    integration_readiness: MATCH_COUNT - i,
  }));
  const deps = makeDeps({
    "/metagraph/search.json": { documents: searchDocs },
    "/metagraph/agent-catalog.json": { subnets: catalogSubnets },
  });

  // Walk every page by following next_offset; returns the concatenated results
  // and the (offset, next_offset) cursor sequence seen.
  async function walkAll(tool, baseArgs, limit) {
    const all = [];
    const cursors = [];
    let offset = 0;
    let total = null;
    // Guard well above the real page count so a cursor bug fails fast instead
    // of looping forever.
    for (let guard = 0; guard < 100; guard += 1) {
      const out = (
        await callTool(tool, { ...baseArgs, offset, limit }, { deps })
      ).body.result.structuredContent;
      total = out.total;
      assert.equal(out.offset, offset, `${tool}: echoes the requested offset`);
      assert.equal(out.limit, limit, `${tool}: echoes the requested limit`);
      assert.equal(
        out.count,
        out.results.length,
        `${tool}: count equals the page length`,
      );
      all.push(...out.results);
      cursors.push({ offset: out.offset, next_offset: out.next_offset });
      if (out.next_offset === null) break;
      assert.equal(
        out.next_offset,
        offset + out.results.length,
        `${tool}: next_offset is the cursor for the following page`,
      );
      offset = out.next_offset;
    }
    return { all, cursors, total };
  }

  for (const { tool, args } of [
    { tool: "search_subnets", args: { query: "pageable" } },
    { tool: "find_subnets_by_capability", args: { capability: "pageable" } },
  ]) {
    test(`${tool} pages the whole match set; next_offset clears at the end`, async () => {
      const { all, cursors, total } = await walkAll(tool, args, 50);
      // total is the full match count, independent of the per-page cap.
      assert.equal(total, MATCH_COUNT);
      // Two pages (60 matches, 50 cap) prove items past page one are reachable.
      assert.deepEqual(cursors, [
        { offset: 0, next_offset: 50 },
        { offset: 50, next_offset: null },
      ]);
      // Every match reached exactly once: no drops, no duplicates across pages.
      assert.equal(all.length, MATCH_COUNT);
      assert.equal(new Set(all.map((r) => r.netuid)).size, MATCH_COUNT);
    });

    test(`${tool} offset past the end returns an empty terminal page`, async () => {
      const out = (
        await callTool(
          tool,
          { ...args, offset: MATCH_COUNT, limit: 10 },
          { deps },
        )
      ).body.result.structuredContent;
      assert.equal(out.total, MATCH_COUNT);
      assert.equal(out.offset, MATCH_COUNT);
      assert.equal(out.count, 0);
      assert.equal(out.results.length, 0);
      assert.equal(out.next_offset, null);
    });
  }
});

// Optional fields are absent on some real subnets, so the result mappers fall
// back: search subtitle -> null, and capability categories/service_kinds -> [],
// integration_readiness -> null. Exercise those fallback branches directly.
describe("search tools — absent optional fields fall back", () => {
  const deps = makeDeps({
    // A matching search doc with no subtitle.
    "/metagraph/search.json": {
      documents: [
        {
          type: "subnet",
          netuid: 5,
          slug: "sparse",
          title: "Sparse",
          tokens: ["sparse"],
        },
      ],
    },
    // A matching catalog subnet (matched via name/slug) with no categories,
    // service_kinds, or integration_readiness.
    "/metagraph/agent-catalog.json": {
      subnets: [
        { netuid: 9, slug: "sparsecap", name: "Sparsecap", callable_count: 3 },
      ],
    },
  });

  test("search_subnets maps a missing subtitle to description: null", async () => {
    const out = (
      await callTool("search_subnets", { query: "sparse" }, { deps })
    ).body.result.structuredContent;
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].netuid, 5);
    assert.equal(out.results[0].description, null);
  });

  test("find_subnets_by_capability defaults absent categories/service_kinds/readiness", async () => {
    const out = (
      await callTool(
        "find_subnets_by_capability",
        { capability: "sparsecap" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.equal(out.results.length, 1);
    const [match] = out.results;
    assert.equal(match.netuid, 9);
    assert.deepEqual(match.categories, []);
    assert.deepEqual(match.service_kinds, []);
    assert.equal(match.integration_readiness, null);
  });
});

describe("MCP economics + metagraph data tools", () => {
  // One valid live economics blob: contract matches, captured_at fresh, the row
  // count matches the summary, and emission_share sums to ~1 (resolveLiveEconomics
  // rejects a blob that fails any of these, falling through to the R2 artifact).
  const ECON_ROW = {
    netuid: 7,
    name: "Allways",
    slug: "allways",
    emission_share: 1,
    registration_cost_tao: 0.5,
    registration_allowed: true,
    open_slots: 3,
    miner_readiness: 80,
    validator_count: 12,
    miner_count: 200,
    total_stake_tao: 1000,
    max_stake_tao: 5000,
    alpha_price_tao: 0.06,
  };
  const ECON_BLOB = {
    contract_version: "test-contract",
    captured_at: FRESH_RUN,
    schema_version: 1,
    network: "finney",
    summary: {
      with_economics_count: 1,
      subnet_count: 1,
      registration_open_count: 1,
    },
    subnets: [ECON_ROW],
  };

  test("get_subnet_economics serves the live KV economics tier (KV-primary)", async () => {
    const res = await callTool(
      "get_subnet_economics",
      { netuid: 7 },
      {
        deps: makeDeps({}, { "economics:current": ECON_BLOB }),
        env: { METAGRAPH_CONTRACT_VERSION: "test-contract" },
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "live-kv");
    assert.equal(out.netuid, 7);
    assert.equal(out.economics.open_slots, 3);
    assert.equal(out.economics.registration_cost_tao, 0.5);
    assert.equal(out.summary.with_economics_count, 1);
    assert.equal(out.captured_at, FRESH_RUN);
  });

  test("get_subnet_economics falls back to the committed R2 artifact when KV is cold", async () => {
    const res = await callTool(
      "get_subnet_economics",
      { netuid: 7 },
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "r2-fallback");
    assert.equal(out.economics.netuid, 7);
  });

  test("get_subnet_economics falls back to R2 when the KV blob is off-contract", async () => {
    const res = await callTool(
      "get_subnet_economics",
      { netuid: 7 },
      {
        deps: makeDeps(
          { "/metagraph/economics.json": ECON_BLOB },
          { "economics:current": ECON_BLOB },
        ),
        // mcpContractVersion mismatches the blob's contract_version → KV rejected.
        env: { METAGRAPH_CONTRACT_VERSION: "different-contract" },
      },
    );
    assert.equal(res.body.result.structuredContent.source, "r2-fallback");
  });

  test("get_subnet_economics returns economics:null for a subnet with no row", async () => {
    const res = await callTool(
      "get_subnet_economics",
      { netuid: 999 },
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.economics, null);
    assert.equal(out.source, "r2-fallback");
  });

  test("get_subnet_economics null-fills captured_at and summary when the snapshot omits them", async () => {
    const res = await callTool(
      "get_subnet_economics",
      { netuid: 7 },
      {
        deps: makeDeps(
          {
            "/metagraph/economics.json": {
              subnets: [{ netuid: 7, open_slots: 1 }],
            },
          },
          {},
        ),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.captured_at, null);
    assert.equal(out.summary, null);
    assert.equal(out.economics.netuid, 7);
  });

  test("get_subnet_economics surfaces not_found when neither tier has data", async () => {
    const res = await callTool(
      "get_subnet_economics",
      { netuid: 7 },
      { deps: makeDeps({}, {}), env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /not_found/);
  });

  // A D1 `neurons` row (booleans as 0/1 INTEGER, stake/emission already TAO floats),
  // mirroring the metagraph-neurons unit-test fixtures.
  const ROW = {
    uid: 0,
    hotkey: "5Hk1",
    coldkey: "5Co1",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0.5,
    validator_trust: 0.99,
    consensus: 0.4,
    incentive: 0.1,
    dividends: 0.2,
    emission_tao: 22.1,
    stake_tao: 1000.5,
    registered_at_block: 6702485,
    is_immunity_period: 0,
    axon: "1.2.3.4:8091",
    block_number: 8454388,
    captured_at: 1750000000000,
  };
  const MINER = { ...ROW, uid: 5, validator_permit: 0, hotkey: "5Hk5" };
  const SNAPSHOTS = [
    {
      snapshot_date: "2026-06-01",
      completeness_score: 90,
      surface_count: 10,
      endpoint_count: 12,
      validator_count: 8,
      miner_count: 100,
      total_stake_tao: 500,
      alpha_price_tao: 0.05,
      emission_share: 0.04,
    },
    {
      snapshot_date: "2026-06-10",
      completeness_score: 97,
      surface_count: 13,
      endpoint_count: 15,
      validator_count: 12,
      miner_count: 200,
      total_stake_tao: 1000,
      alpha_price_tao: 0.06,
      emission_share: 0.05,
    },
  ];

  // D1 binding honoring the loaders' WHERE clauses (neurons + subnet_snapshots).
  function metagraphD1({
    neurons = [],
    snapshots = [],
    surfaceStatus = [],
    uptimeRows = [],
    incidentRows = [],
    growthSamples = [],
    rpcRows = [],
    neuronDaily = [],
    turnoverBounds = [],
    turnoverRows = [],
  } = {}) {
    return {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              all() {
                if (sql.includes("FROM neurons")) {
                  let r = neurons;
                  if (sql.includes("validator_permit = 1")) {
                    r = r.filter((x) => x.validator_permit === 1);
                  }
                  if (sql.includes("AND uid = ?")) {
                    r = r.filter((x) => x.uid === params[1]);
                  }
                  return Promise.resolve({ results: r });
                }
                if (sql.includes("FROM subnet_snapshots")) {
                  if (sql.includes("snapshot_date >=")) {
                    return Promise.resolve({ results: growthSamples });
                  }
                  return Promise.resolve({ results: snapshots });
                }
                if (sql.includes("FROM neuron_daily")) {
                  if (/MIN\(snapshot_date\) AS start_date/.test(sql)) {
                    return Promise.resolve({ results: turnoverBounds });
                  }
                  if (/snapshot_date IN/.test(sql)) {
                    return Promise.resolve({ results: turnoverRows });
                  }
                  return Promise.resolve({ results: neuronDaily });
                }
                if (sql.includes("FROM surface_uptime_daily")) {
                  return Promise.resolve({ results: uptimeRows });
                }
                if (sql.includes("FROM surface_checks")) {
                  return Promise.resolve({ results: incidentRows });
                }
                if (sql.includes("min_latency_ms")) {
                  return Promise.resolve({ results: rpcRows });
                }
                if (sql.includes("FROM surface_status")) {
                  if (sql.includes("WHERE netuid IN")) {
                    const netuids = params.map(Number);
                    return Promise.resolve({
                      results: surfaceStatus.filter((row) =>
                        netuids.includes(row.netuid),
                      ),
                    });
                  }
                  return Promise.resolve({ results: surfaceStatus });
                }
                return Promise.resolve({ results: [] });
              },
            };
          },
        };
      },
    };
  }
  const d1Env = {
    METAGRAPH_HEALTH_DB: metagraphD1({
      neurons: [ROW, MINER],
      snapshots: SNAPSHOTS,
      growthSamples: SNAPSHOTS,
      surfaceStatus: [
        { netuid: 1, surface_count: 5, ok_count: 4, avg_latency_ms: 100 },
        { netuid: 7, surface_count: 3, ok_count: 2, avg_latency_ms: 120 },
      ],
    }),
  };
  const liveAnalyticsDeps = makeDeps({
    "/metagraph/profiles.json": {
      profiles: [
        {
          netuid: 1,
          slug: "alpha",
          name: "Alpha",
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
        {
          netuid: 7,
          slug: "gamma",
          name: "Gamma",
          completeness_score: 70,
          surface_count: 4,
          operational_interface_count: 1,
        },
      ],
    },
    "/metagraph/economics.json": {
      generated_at: "2026-06-20T00:00:00Z",
      subnets: [
        { netuid: 1, open_slots: 2, emission_share: 0.1 },
        { netuid: 7, open_slots: 1, emission_share: 0.05 },
      ],
    },
  });

  test("get_subnet_metagraph returns every neuron with booleans coerced", async () => {
    const res = await callTool(
      "get_subnet_metagraph",
      { netuid: 7 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 2);
    assert.equal(out.block_number, 8454388);
    assert.equal(typeof out.captured_at, "string");
    assert.equal(out.neurons[0].validator_permit, true);
    assert.equal(out.neurons[0].is_immunity_period, false);
  });

  test("get_subnet_metagraph with validator_permit returns only validators", async () => {
    const res = await callTool(
      "get_subnet_metagraph",
      { netuid: 7, validator_permit: true },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.neuron_count, 1);
    assert.equal(out.neurons[0].uid, 0);
  });

  test("get_subnet_metagraph rejects a non-boolean validator_permit", async () => {
    const res = await callTool(
      "get_subnet_metagraph",
      { netuid: 7, validator_permit: "yes" },
      { env: d1Env },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /boolean/);
  });

  test("list_subnet_validators returns permit-holders ranked by stake", async () => {
    const res = await callTool(
      "list_subnet_validators",
      { netuid: 7 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.validator_count, 1);
    assert.equal(out.validators[0].validator_permit, true);
  });

  test("get_neuron returns one UID, neuron:null for an absent UID", async () => {
    const present = await callTool(
      "get_neuron",
      { netuid: 7, uid: 0 },
      { env: d1Env },
    );
    assert.equal(present.body.result.structuredContent.neuron.uid, 0);
    const absent = await callTool(
      "get_neuron",
      { netuid: 7, uid: 999 },
      { env: d1Env },
    );
    assert.equal(absent.body.result.structuredContent.neuron, null);
  });

  test("get_neuron requires a non-negative uid", async () => {
    const res = await callTool("get_neuron", { netuid: 7 }, { env: d1Env });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /uid/);
  });

  test("get_subnet_trajectory computes the time series + deltas (sorted ascending)", async () => {
    const res = await callTool(
      "get_subnet_trajectory",
      { netuid: 7 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.point_count, 2);
    assert.equal(out.points[0].date, "2026-06-01");
    assert.equal(out.points[1].validator_count, 12);
    assert.equal(out.deltas["7d"].completeness_score, 7);
  });

  test("get_economics_trends defaults to 30d and rolls subnet_snapshots rows", async () => {
    const res = await callTool("get_economics_trends", {}, { env: d1Env });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.day_count, 2);
    assert.equal(out.days[0].snapshot_date, "2026-06-01");
    assert.equal(out.days[1].total_stake_tao, 1000);
  });

  test("get_economics_trends rejects an invalid window", async () => {
    const res = await callTool(
      "get_economics_trends",
      { window: "99d" },
      { env: d1Env },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_economics_trends returns schema-stable empty days on cold D1", async () => {
    const res = await callTool("get_economics_trends", { window: "7d" });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.day_count, 0);
    assert.deepEqual(out.days, []);
  });

  test("get_subnet_concentration returns schema-stable null blocks on cold D1", async () => {
    const res = await callTool("get_subnet_concentration", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.stake, null);
    assert.equal(out.emission, null);
  });

  test("get_subnet_concentration computes entity-collapsed scorecards", async () => {
    const res = await callTool(
      "get_subnet_concentration",
      { netuid: 7 },
      {
        env: {
          METAGRAPH_HEALTH_DB: metagraphD1({
            neurons: [
              { ...ROW, stake_tao: 100, emission_tao: 2, coldkey: "ck-a" },
              {
                ...MINER,
                stake_tao: 50,
                emission_tao: 1,
                coldkey: "ck-a",
              },
            ],
          }),
        },
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.neuron_count, 2);
    assert.equal(out.entity_count, 1);
    assert.equal(out.entity_stake.total, 150);
    assert.equal(out.stake.holders, 2);
  });

  test("get_subnet_concentration_history defaults to 30d and returns points", async () => {
    const res = await callTool(
      "get_subnet_concentration_history",
      { netuid: 7 },
      {
        env: {
          METAGRAPH_HEALTH_DB: metagraphD1({
            neuronDaily: [
              { snapshot_date: "2026-06-02", stake_tao: 20, emission_tao: 2 },
              { snapshot_date: "2026-06-01", stake_tao: 10, emission_tao: 1 },
            ],
          }),
        },
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 2);
    assert.equal(out.points[0].snapshot_date, "2026-06-02");
  });

  test("concentration tools reject invalid window params", async () => {
    const res = await callTool("get_subnet_concentration_history", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_subnet_turnover returns schema-stable empty on cold D1", async () => {
    const res = await callTool("get_subnet_turnover", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "30d");
    assert.equal(out.comparable, false);
    assert.equal(out.validator_retention, null);
    assert.equal(out.stability_score, null);
  });

  test("get_subnet_turnover computes validator churn between boundary snapshots", async () => {
    const res = await callTool(
      "get_subnet_turnover",
      { netuid: 9, window: "30d" },
      {
        env: {
          METAGRAPH_HEALTH_DB: metagraphD1({
            turnoverBounds: [
              { start_date: "2026-06-01", end_date: "2026-06-30" },
            ],
            turnoverRows: [
              {
                snapshot_date: "2026-06-01",
                uid: 0,
                hotkey: "V1",
                validator_permit: 1,
              },
              {
                snapshot_date: "2026-06-01",
                uid: 1,
                hotkey: "V2",
                validator_permit: 1,
              },
              {
                snapshot_date: "2026-06-01",
                uid: 2,
                hotkey: "M1",
                validator_permit: 0,
              },
              {
                snapshot_date: "2026-06-30",
                uid: 0,
                hotkey: "V1",
                validator_permit: 1,
              },
              {
                snapshot_date: "2026-06-30",
                uid: 1,
                hotkey: "V3",
                validator_permit: 1,
              },
              {
                snapshot_date: "2026-06-30",
                uid: 2,
                hotkey: "M1",
                validator_permit: 0,
              },
            ],
          }),
        },
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.comparable, true);
    assert.equal(out.start_date, "2026-06-01");
    assert.equal(out.end_date, "2026-06-30");
    assert.equal(out.validators_entered, 1);
    assert.equal(out.validators_exited, 1);
    assert.equal(out.uids_deregistered, 1);
    assert.equal(out.stability_score, 42);
  });

  test("get_subnet_turnover rejects an invalid window", async () => {
    const res = await callTool("get_subnet_turnover", {
      netuid: 7,
      window: "400d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_subnet_turnover accepts the all window without a date cutoff", async () => {
    const res = await callTool(
      "get_subnet_turnover",
      { netuid: 9, window: "all" },
      {
        env: {
          METAGRAPH_HEALTH_DB: metagraphD1({
            turnoverBounds: [
              { start_date: "2026-06-01", end_date: "2026-06-30" },
            ],
            turnoverRows: [
              {
                snapshot_date: "2026-06-01",
                uid: 0,
                hotkey: "V1",
                validator_permit: 1,
              },
              {
                snapshot_date: "2026-06-30",
                uid: 0,
                hotkey: "V1",
                validator_permit: 1,
              },
            ],
          }),
        },
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "all");
    assert.equal(out.comparable, true);
    assert.equal(out.validator_retention, 1);
  });

  test("the D1-backed tools degrade to schema-stable empty payloads when D1 is cold", async () => {
    const meta = await callTool("get_subnet_metagraph", { netuid: 7 });
    assert.equal(meta.body.result.isError, false);
    assert.equal(meta.body.result.structuredContent.neuron_count, 0);
    assert.deepEqual(meta.body.result.structuredContent.neurons, []);

    const vals = await callTool("list_subnet_validators", { netuid: 7 });
    assert.equal(vals.body.result.structuredContent.validator_count, 0);

    const neuron = await callTool("get_neuron", { netuid: 7, uid: 0 });
    assert.equal(neuron.body.result.structuredContent.neuron, null);

    const traj = await callTool("get_subnet_trajectory", { netuid: 7 });
    assert.equal(traj.body.result.structuredContent.point_count, 0);
  });

  test("get_subnet_uptime returns schema-stable empty surfaces on cold D1", async () => {
    const res = await callTool("get_subnet_uptime", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "90d");
    assert.deepEqual(out.surfaces, []);
  });

  test("get_subnet_health_trends returns schema-stable empty windows on cold D1", async () => {
    const res = await callTool("get_subnet_health_trends", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.deepEqual(out.windows["7d"].surfaces, []);
    assert.deepEqual(out.windows["30d"].surfaces, []);
  });

  test("get_chain_calls returns schema-stable empty calls on cold D1", async () => {
    const res = await callTool("get_chain_calls", { window: "7d" });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.call_count, 0);
    assert.deepEqual(out.calls, []);
  });

  test("get_chain_calls rejects invalid window and group_by params", async () => {
    const window = await callTool("get_chain_calls", { window: "90d" });
    assert.equal(window.body.result.isError, true);
    const groupBy = await callTool("get_chain_calls", { group_by: "bogus" });
    assert.equal(groupBy.body.result.isError, true);
  });

  test("get_chain_calls aggregates extrinsic rows with honest shares", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(..._params) {
              const rows = /GROUP BY call_module/.test(sql)
                ? [
                    { call_module: "SubtensorModule", count: 60 },
                    { call_module: "Balances", count: 30 },
                  ]
                : /COUNT\(\*\) AS total/.test(sql)
                  ? [{ total: 120 }]
                  : [];
              return { all: () => Promise.resolve({ results: rows }) };
            },
          };
        },
      },
    };
    const deps = makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } });
    const res = await callTool(
      "get_chain_calls",
      { window: "30d", limit: 2 },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.observed_at, FRESH_RUN);
    assert.equal(out.total_extrinsics, 120);
    assert.equal(out.calls[0].share, 0.5);
  });

  test("get_registry_leaderboards returns boards from committed profiles", async () => {
    const res = await callTool(
      "get_registry_leaderboards",
      { limit: 5 },
      { deps: liveAnalyticsDeps, env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.ok(typeof out.boards === "object");
    assert.ok(Object.keys(out.boards).length > 0);
  });

  test("compare_subnets composes health-only dimensions", async () => {
    const res = await callTool(
      "compare_subnets",
      { netuids: [1, 7], dimensions: ["health"] },
      { deps: liveAnalyticsDeps, env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.requested_netuids, [1, 7]);
    assert.deepEqual(out.dimensions, ["health"]);
    assert.equal(out.subnets.length, 2);
    for (const subnet of out.subnets) {
      assert.equal("health" in subnet, true);
      assert.equal("structure" in subnet, false);
    }
  });

  test("get_global_incidents returns empty summary on cold D1", async () => {
    const res = await callTool("get_global_incidents", { window: "7d" });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.summary.incident_count, 0);
    assert.deepEqual(out.surfaces, []);
  });

  test("live analytics tools reject invalid window/board params", async () => {
    const uptime = await callTool("get_subnet_uptime", {
      netuid: 7,
      window: "30d",
    });
    assert.equal(uptime.body.result.isError, true);

    const incidents = await callTool("get_global_incidents", { window: "90d" });
    assert.equal(incidents.body.result.isError, true);

    const compare = await callTool("compare_subnets", {
      netuids: [],
    });
    assert.equal(compare.body.result.isError, true);

    const dimensions = await callTool("compare_subnets", {
      netuids: [1],
      dimensions: ["bogus"],
    });
    assert.equal(dimensions.body.result.isError, true);

    const board = await callTool("get_registry_leaderboards", {
      board: "not-a-board",
    });
    assert.equal(board.body.result.isError, true);
  });

  test("get_subnet_uptime returns per-surface history for the 1y window", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: metagraphD1({
        uptimeRows: [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            day: "2026-06-01",
            samples: 100,
            ok_count: 95,
            uptime_ratio: 0.95,
            avg_latency_ms: 80,
            p50: 70,
            p95: 120,
            p99: 150,
            status: "ok",
          },
        ],
      }),
    };
    const deps = makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } });
    const res = await callTool(
      "get_subnet_uptime",
      { netuid: 7, window: "1y" },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "1y");
    assert.equal(out.observed_at, FRESH_RUN);
    assert.equal(out.surfaces.length, 1);
    assert.equal(out.surfaces[0].samples, 100);
  });

  test("get_subnet_health_trends aggregates ranked-CTE rows into both windows", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: metagraphD1({
        incidentRows: [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            total: 100,
            ok_count: 95,
            latency_samples: 95,
            avg_latency_ms: 90,
            p50: 80,
            p95: 110,
            p99: 130,
          },
        ],
      }),
    };
    const deps = makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } });
    const res = await callTool(
      "get_subnet_health_trends",
      { netuid: 7 },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.observed_at, FRESH_RUN);
    for (const label of ["7d", "30d"]) {
      assert.equal(out.windows[label].surfaces[0].surface_id, "api-root");
      assert.equal(out.windows[label].surfaces[0].uptime_ratio, 0.95);
    }
  });

  test("get_subnet_health_percentiles shapes per-surface latency percentiles from ranked rows", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: metagraphD1({
        incidentRows: [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            latency_samples: 95,
            p50: 80,
            p95: 110,
            p99: 130,
            avg_latency_ms: 90,
            min_latency_ms: 40,
            max_latency_ms: 200,
          },
        ],
      }),
    };
    const deps = makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } });
    const res = await callTool(
      "get_subnet_health_percentiles",
      { netuid: 7, window: "30d" },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "30d");
    assert.equal(out.observed_at, FRESH_RUN);
    assert.equal(out.surfaces[0].surface_id, "api-root");
    assert.equal(out.surfaces[0].samples, 95);
    assert.equal(out.surfaces[0].latency_ms.p95, 110);
    assert.equal(out.surfaces[0].latency_ms.max, 200);
  });

  test("get_subnet_health_percentiles returns schema-stable empty surfaces (default 7d) on cold D1", async () => {
    const res = await callTool("get_subnet_health_percentiles", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d");
    assert.deepEqual(out.surfaces, []);
  });

  test("get_subnet_health_percentiles rejects an invalid window", async () => {
    const res = await callTool(
      "get_subnet_health_percentiles",
      { netuid: 7, window: "99d" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_registry_leaderboards can filter to one board", async () => {
    const res = await callTool(
      "get_registry_leaderboards",
      { board: "healthiest", limit: 2 },
      { deps: liveAnalyticsDeps, env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.ok(out.boards.healthiest);
    assert.equal("fastest-rpc" in out.boards, false);
  });

  test("compare_subnets defaults to all dimensions and uses live economics KV", async () => {
    const deps = {
      ...liveAnalyticsDeps,
      readHealthKv: makeDeps(
        {},
        {
          "health:meta": { last_run_at: FRESH_RUN },
          "economics:current": ECON_BLOB,
        },
      ).readHealthKv,
    };
    const res = await callTool(
      "compare_subnets",
      { netuids: [1, 7] },
      {
        deps,
        env: { ...d1Env, METAGRAPH_CONTRACT_VERSION: "test-contract" },
      },
    );
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.dimensions, ["structure", "economics", "health"]);
    assert.equal(out.subnets[1].structure.completeness_score, 70);
    assert.equal(out.subnets[1].economics.open_slots, 3);
    assert.equal(out.subnets[1].health.ok_count, 2);
    assert.equal(out.observed_at, FRESH_RUN);
  });

  test("get_global_incidents returns incident rows for the 30d window", async () => {
    const now = Date.now();
    const env = {
      METAGRAPH_HEALTH_DB: metagraphD1({
        incidentRows: [
          {
            netuid: 7,
            surface_id: "api-root",
            surface_key: "api-root",
            started_at: now - 3_600_000,
            ended_at: now - 1_800_000,
            failed_samples: 3,
          },
        ],
      }),
    };
    const res = await callTool(
      "get_global_incidents",
      { window: "30d" },
      {
        deps: makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } }),
        env,
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.observed_at, FRESH_RUN);
    assert.equal(out.summary.incident_count, 1);
    assert.equal(out.surfaces[0].incidents[0].failed_samples, 3);
  });

  test("the D1 runner swallows a query error and a missing result set", async () => {
    // A bound DB whose .all() throws must be caught and yield an empty payload.
    const throwingEnv = {
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({
          bind: () => ({
            all() {
              throw new Error("d1 unavailable");
            },
          }),
        }),
      },
    };
    const thrown = await callTool(
      "get_subnet_metagraph",
      { netuid: 7 },
      { env: throwingEnv },
    );
    assert.equal(thrown.body.result.isError, false);
    assert.equal(thrown.body.result.structuredContent.neuron_count, 0);

    // A result object with no `results` array falls back to [] (no throw).
    const noResultsEnv = {
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({ bind: () => ({ all: () => Promise.resolve({}) }) }),
      },
    };
    const empty = await callTool(
      "get_subnet_metagraph",
      { netuid: 7 },
      { env: noResultsEnv },
    );
    assert.equal(empty.body.result.structuredContent.neuron_count, 0);
  });

  test("the data tools reject a negative netuid", async () => {
    for (const name of [
      "get_subnet_economics",
      "get_subnet_trajectory",
      "get_subnet_metagraph",
      "list_subnet_validators",
    ]) {
      const res = await callTool(name, { netuid: -1 }, { env: d1Env });
      assert.equal(
        res.body.result.isError,
        true,
        `${name} must reject netuid -1`,
      );
    }
  });
});

describe("MCP account tools (get_account + events + subnets)", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  // A D1 binding that routes by SQL shape so the account loaders get realistic
  // rows. Order matters: GROUP BY (kinds) before COUNT (agg), as in the REST
  // account-routes test. `capture` records each bound (sql, params) so a test can
  // assert the clamped LIMIT/OFFSET actually reached the query.
  function accountD1({ agg, kinds, registrations, events } = {}, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  if (/GROUP BY event_kind/.test(sql))
                    return Promise.resolve({ results: kinds || [] });
                  if (/COUNT\(\*\) AS c/.test(sql))
                    return Promise.resolve({ results: agg ? [agg] : [] });
                  if (/FROM neurons/.test(sql))
                    return Promise.resolve({ results: registrations || [] });
                  if (/FROM account_events/.test(sql))
                    return Promise.resolve({ results: events || [] });
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
  }

  test("get_account returns a cross-subnet summary with booleans coerced", async () => {
    const env = accountD1({
      agg: {
        c: 12,
        sc: 3,
        fb: 100,
        lb: 200,
        fo: 1750000000000,
        lo: 1750009000000,
      },
      kinds: [
        { kind: "StakeAdded", count: 7 },
        { kind: "WeightsSet", count: 5 },
      ],
      registrations: [
        { netuid: 7, uid: 3, stake_tao: 100, validator_permit: 1, active: 1 },
      ],
      events: [
        {
          block_number: 200,
          event_index: 1,
          event_kind: "StakeAdded",
          hotkey: SS58,
          coldkey: null,
          netuid: 7,
          uid: 3,
          amount_tao: 1.5,
          observed_at: 1750009000000,
        },
      ],
    });
    const res = await callTool("get_account", { ss58: SS58 }, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.event_count, 12);
    assert.equal(out.subnet_count, 3);
    assert.equal(out.event_kinds[0].kind, "StakeAdded");
    assert.equal(out.registrations[0].validator_permit, true);
    assert.equal(out.recent_events[0].event_kind, "StakeAdded");
  });

  test("get_account_balance returns balance_tao from finney RPC", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { data: { free: 2_000_000_000, reserved: 500_000_000 } },
      }),
    });
    try {
      const res = await callTool("get_account_balance", { ss58: SS58 }, {});
      const out = res.body.result.structuredContent;
      assert.equal(out.ss58, SS58);
      assert.equal(out.balance_tao, 2.5);
      assert.ok(out.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_account_balance rejects a non-finney ss58 prefix", async () => {
    const res = await callTool(
      "get_account_balance",
      { ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXc6TYeyZ1km1" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /finney/i);
  });

  test("get_account_balance returns balance_tao:null on RPC failure", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("rpc down");
    };
    try {
      const res = await callTool("get_account_balance", { ss58: SS58 }, {});
      const out = res.body.result.structuredContent;
      assert.equal(out.balance_tao, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_account_balance applies the RPC rate limiter before finney fetch", async () => {
    let limiterKey;
    let fetchCalled = false;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("should not fetch");
    };
    const env = {
      MCP_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
      RPC_RATE_LIMITER: {
        async limit({ key }) {
          limiterKey = key;
          return { success: false };
        },
      },
    };
    try {
      const res = await callTool(
        "get_account_balance",
        { ss58: SS58 },
        { env },
      );
      assert.equal(res.body.result.isError, true);
      assert.match(res.body.result.content[0].text, /rate_limited/);
      assert.equal(limiterKey, "balance:mcp:anonymous");
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_account_events filters by kind and echoes the limit", async () => {
    const capture = [];
    const env = accountD1(
      {
        events: [
          {
            block_number: 200,
            event_index: 1,
            event_kind: "StakeRemoved",
            hotkey: SS58,
            coldkey: null,
            netuid: 7,
            uid: 3,
            amount_tao: 2.0,
            observed_at: 1750009000000,
          },
        ],
      },
      capture,
    );
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, kind: "StakeRemoved", limit: 50 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.events[0].event_kind, "StakeRemoved");
    assert.equal(out.limit, 50);
    assert.equal(out.offset, 0);
    // The kind filter must reach the SQL as a bound param (never interpolated).
    const eventsQuery = capture.find((q) => /FROM account_events/.test(q.sql));
    assert.ok(/AND event_kind = \?/.test(eventsQuery.sql));
    assert.ok(eventsQuery.params.includes("StakeRemoved"));
  });

  test("get_account_events clamps an over-range limit the same way the REST route does", async () => {
    const capture = [];
    const env = accountD1({ events: [] }, capture);
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, limit: 5000 },
      { env },
    );
    // clampInt(5000, 100, 1, 1000) → 1000, in both the payload and the bound LIMIT.
    assert.equal(res.body.result.structuredContent.limit, 1000);
    const eventsQuery = capture.find((q) => /FROM account_events/.test(q.sql));
    assert.ok(eventsQuery.params.includes(1000));
  });

  test("get_account_events falls back to the default limit for a non-numeric limit", async () => {
    const env = accountD1({ events: [] });
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, limit: "abc" },
      { env },
    );
    // clampInt(NaN) → default 100.
    assert.equal(res.body.result.structuredContent.limit, 100);
  });

  test("get_account_subnets returns the cross-subnet footprint", async () => {
    const env = accountD1({
      registrations: [
        { netuid: 7, uid: 3, stake_tao: 100, validator_permit: 0, active: 1 },
        { netuid: 64, uid: 12, stake_tao: 5, validator_permit: 1, active: 1 },
      ],
    });
    const res = await callTool("get_account_subnets", { ss58: SS58 }, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[1].netuid, 64);
    assert.equal(out.subnets[1].validator_permit, true);
  });

  test("get_account_events rejects a non-string kind", async () => {
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, kind: 7 },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /kind/);
  });

  test("the account tools reject a malformed ss58", async () => {
    for (const name of [
      "get_account",
      "get_account_events",
      "get_account_subnets",
    ]) {
      const res = await callTool(name, { ss58: "not-an-address" }, { env: {} });
      assert.equal(
        res.body.result.isError,
        true,
        `${name} must reject bad ss58`,
      );
      assert.match(res.body.result.content[0].text, /ss58/);
    }
  });

  test("the account tools degrade to schema-stable empty payloads when D1 is cold", async () => {
    const summary = await callTool("get_account", { ss58: SS58 });
    assert.equal(summary.body.result.isError, false);
    assert.equal(summary.body.result.structuredContent.event_count, 0);
    assert.deepEqual(summary.body.result.structuredContent.registrations, []);

    const events = await callTool("get_account_events", { ss58: SS58 });
    assert.equal(events.body.result.structuredContent.event_count, 0);
    assert.deepEqual(events.body.result.structuredContent.events, []);

    const subnets = await callTool("get_account_subnets", { ss58: SS58 });
    assert.equal(subnets.body.result.structuredContent.subnet_count, 0);
  });

  test("populated account payloads validate against their declared outputSchemas", async () => {
    // validate-mcp only exercises the cold (empty-array) path, so assert the
    // POPULATED shapes here — the only check that the item schemas match the rows.
    const ajv = new Ajv2020({ strict: false });
    const validatorFor = (name) =>
      ajv.compile(
        listToolDefinitions().find((t) => t.name === name).outputSchema,
      );
    const reg = {
      netuid: 7,
      uid: 3,
      stake_tao: 100.5,
      validator_permit: 1,
      active: 1,
    };
    const event = {
      block_number: 9,
      event_index: 0,
      event_kind: "StakeAdded",
      hotkey: SS58,
      coldkey: null,
      netuid: 7,
      uid: 3,
      amount_tao: 1.5,
      observed_at: 1750009000000,
    };
    const cases = [
      [
        "get_account",
        accountD1({
          agg: {
            c: 5,
            sc: 2,
            fb: 1,
            lb: 9,
            fo: 1750000000000,
            lo: 1750009000000,
          },
          kinds: [{ kind: "StakeAdded", count: 5 }],
          registrations: [reg],
          events: [event],
        }),
      ],
      ["get_account_events", accountD1({ events: [event] })],
      ["get_account_subnets", accountD1({ registrations: [reg] })],
    ];
    for (const [name, env] of cases) {
      const res = await callTool(name, { ss58: SS58 }, { env });
      const validate = validatorFor(name);
      assert.ok(
        validate(res.body.result.structuredContent),
        `${name}: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  test("get_account_events seeks by keyset cursor instead of offset", async () => {
    const capture = [];
    const env = accountD1({ events: [] }, capture);
    await callTool(
      "get_account_events",
      { ss58: SS58, cursor: "200.1", limit: 50 },
      { env },
    );
    const q = capture.find((c) => /FROM account_events/.test(c.sql));
    // A valid cursor switches the page to a row-value seek and drops OFFSET.
    assert.ok(/AND \(block_number, event_index\) < \(\?, \?\)/.test(q.sql));
    assert.ok(!/OFFSET/.test(q.sql));
    assert.ok(q.params.includes(200) && q.params.includes(1));
  });

  test("get_account_events emits next_cursor for a full page", async () => {
    const env = accountD1({
      events: [
        {
          block_number: 200,
          event_index: 1,
          event_kind: "StakeAdded",
          hotkey: SS58,
          coldkey: null,
          netuid: 7,
          uid: 3,
          amount_tao: 1.5,
          observed_at: 1750009000000,
        },
      ],
    });
    // limit:1 with exactly one row is a full page → a keyset token for the next.
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, limit: 1 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.next_cursor, "200.1");
  });
});

describe("MCP account tail tools (history, extrinsics, transfers)", () => {
  // The account tail tools complete the account chain-data surface: daily
  // activity (get_account_history), signed extrinsics (get_account_extrinsics),
  // and native-TAO transfers (get_account_transfers).
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  function tailD1(fixtures = {}, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  if (/FROM account_events_daily/.test(sql))
                    return Promise.resolve({
                      results: fixtures.days || [],
                    });
                  if (/FROM extrinsics WHERE signer/.test(sql))
                    return Promise.resolve({
                      results: fixtures.extrinsics || [],
                    });
                  if (/event_kind = 'Transfer'/.test(sql))
                    return Promise.resolve({
                      results: fixtures.transfers || [],
                    });
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
  }

  test("get_account_history returns daily series with fields correctly shaped", async () => {
    const env = tailD1({
      days: [
        {
          day: "2025-06-24",
          netuid: 7,
          event_count: 3,
          event_kinds: "StakeAdded,WeightsSet",
          first_block: 100,
          last_block: 200,
        },
      ],
    });
    const res = await callTool("get_account_history", { ss58: SS58 }, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.day_count, 1);
    assert.equal(out.days[0].day, "2025-06-24");
    assert.equal(out.days[0].netuid, 7);
    assert.deepEqual(out.days[0].event_kinds, ["StakeAdded", "WeightsSet"]);
    assert.equal(out.days[0].first_block, 100);
  });

  test("get_account_history passes netuid and date bounds to the SQL query", async () => {
    const capture = [];
    const env = tailD1({ days: [] }, capture);
    await callTool(
      "get_account_history",
      {
        ss58: SS58,
        netuid: 7,
        from: "2025-01-01",
        to: "2025-06-30",
        limit: 10,
      },
      { env },
    );
    const q = capture.find((c) => /FROM account_events_daily/.test(c.sql));
    assert.ok(q, "daily query must be executed");
    assert.ok(/AND netuid = \?/.test(q.sql), "netuid filter must be applied");
    assert.ok(/AND day >= \?/.test(q.sql), "from filter must be applied");
    assert.ok(/AND day <= \?/.test(q.sql), "to filter must be applied");
    assert.ok(q.params.includes(7));
    assert.ok(q.params.includes("2025-01-01"));
    assert.ok(q.params.includes("2025-06-30"));
    assert.ok(q.params.includes(10));
  });

  test("get_account_history degrades to empty payload on cold D1", async () => {
    const res = await callTool("get_account_history", { ss58: SS58 });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.day_count, 0);
    assert.deepEqual(res.body.result.structuredContent.days, []);
  });

  test("get_account_extrinsics returns signed extrinsics with correct fields", async () => {
    const env = tailD1({
      extrinsics: [
        {
          block_number: 500,
          extrinsic_index: 2,
          extrinsic_hash: "0xabc",
          signer: SS58,
          call_module: "SubtensorModule",
          call_function: "set_weights",
          call_args: null,
          success: 1,
          fee_tao: 0.001,
          tip_tao: null,
          observed_at: 1750009000000,
        },
      ],
    });
    const res = await callTool(
      "get_account_extrinsics",
      { ss58: SS58, limit: 50 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.extrinsic_count, 1);
    assert.equal(out.limit, 50);
    assert.equal(out.extrinsics[0].call_module, "SubtensorModule");
    assert.equal(out.extrinsics[0].success, true);
  });

  test("get_account_extrinsics degrades to empty payload on cold D1", async () => {
    const res = await callTool("get_account_extrinsics", { ss58: SS58 });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    assert.deepEqual(res.body.result.structuredContent.extrinsics, []);
  });

  test("get_account_transfers returns transfers with direction field", async () => {
    const env = tailD1({
      transfers: [
        {
          block_number: 300,
          event_index: 1,
          event_kind: "Transfer",
          hotkey: SS58,
          coldkey: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
          amount_tao: 10.5,
          alpha_amount: null,
          observed_at: 1750009000000,
          extrinsic_index: null,
        },
      ],
    });
    const res = await callTool(
      "get_account_transfers",
      { ss58: SS58 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.transfer_count, 1);
    assert.equal(out.transfers[0].direction, "sent");
    assert.equal(out.transfers[0].amount_tao, 10.5);
  });

  test("get_account_transfers filters by direction=received", async () => {
    const capture = [];
    const env = tailD1({ transfers: [] }, capture);
    await callTool(
      "get_account_transfers",
      { ss58: SS58, direction: "received" },
      { env },
    );
    const q = capture.find((c) => /event_kind = 'Transfer'/.test(c.sql));
    assert.ok(q, "transfer query must be executed");
    assert.ok(/coldkey = \?/.test(q.sql), "received side uses coldkey match");
    assert.ok(!/hotkey = \?/.test(q.sql), "received must not match hotkey");
  });

  test("get_account_transfers degrades to empty payload on cold D1", async () => {
    const res = await callTool("get_account_transfers", { ss58: SS58 });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.transfer_count, 0);
    assert.deepEqual(res.body.result.structuredContent.transfers, []);
  });

  test("account tail tools reject a malformed ss58", async () => {
    for (const name of [
      "get_account_history",
      "get_account_extrinsics",
      "get_account_transfers",
    ]) {
      const res = await callTool(name, { ss58: "bad" }, { env: {} });
      assert.equal(
        res.body.result.isError,
        true,
        `${name} must reject bad ss58`,
      );
      assert.match(res.body.result.content[0].text, /ss58/);
    }
  });

  test("account tail payloads validate against their declared outputSchemas", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validatorFor = (name) =>
      ajv.compile(
        listToolDefinitions().find((t) => t.name === name).outputSchema,
      );
    const dayRow = {
      day: "2025-06-24",
      netuid: 7,
      event_count: 3,
      event_kinds: "StakeAdded",
      first_block: 100,
      last_block: 200,
    };
    const extrinsicRow = {
      block_number: 500,
      extrinsic_index: 2,
      extrinsic_hash: "0xabc",
      signer: SS58,
      call_module: "SubtensorModule",
      call_function: "set_weights",
      call_args: null,
      success: 1,
      fee_tao: 0.001,
      tip_tao: null,
      observed_at: 1750009000000,
    };
    const transferRow = {
      block_number: 300,
      event_index: 1,
      event_kind: "Transfer",
      hotkey: SS58,
      coldkey: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
      amount_tao: 10.5,
      alpha_amount: null,
      observed_at: 1750009000000,
      extrinsic_index: null,
    };
    const cases = [
      ["get_account_history", tailD1({ days: [dayRow] })],
      ["get_account_extrinsics", tailD1({ extrinsics: [extrinsicRow] })],
      ["get_account_transfers", tailD1({ transfers: [transferRow] })],
    ];
    for (const [name, env] of cases) {
      const res = await callTool(name, { ss58: SS58 }, { env });
      const validate = validatorFor(name);
      assert.ok(
        validate(res.body.result.structuredContent),
        `${name}: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});

describe("MCP block-explorer tools (list_blocks, get_block, list_extrinsics, get_extrinsic)", () => {
  // Tests for the chain block-explorer MCP surface.

  function chainD1(fixtures = {}, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  if (/FROM blocks WHERE block_number = \?/.test(sql))
                    return Promise.resolve({
                      results: fixtures.block ? [fixtures.block] : [],
                    });
                  if (/FROM blocks WHERE block_hash = \?/.test(sql))
                    return Promise.resolve({
                      results: fixtures.block ? [fixtures.block] : [],
                    });
                  if (
                    /SELECT MAX\(block_number\) FROM blocks WHERE block_number < \?/.test(
                      sql,
                    )
                  )
                    return Promise.resolve({
                      results: [
                        {
                          prev: fixtures.prev ?? null,
                          next: fixtures.next ?? null,
                        },
                      ],
                    });
                  if (/FROM blocks/.test(sql))
                    return Promise.resolve({
                      results: fixtures.blocks || [],
                    });
                  if (/FROM extrinsics WHERE extrinsic_hash/.test(sql))
                    return Promise.resolve({
                      results: fixtures.extrinsic ? [fixtures.extrinsic] : [],
                    });
                  if (
                    /FROM extrinsics WHERE block_number = \? AND extrinsic_index/.test(
                      sql,
                    )
                  )
                    return Promise.resolve({
                      results: fixtures.extrinsic ? [fixtures.extrinsic] : [],
                    });
                  if (/FROM extrinsics/.test(sql))
                    return Promise.resolve({
                      results: fixtures.extrinsics || [],
                    });
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
  }

  const BLOCK_ROW = {
    block_number: 4200000,
    block_hash: "0x" + "a".repeat(64),
    parent_hash: "0x" + "b".repeat(64),
    author: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    extrinsic_count: 5,
    event_count: 12,
    spec_version: 207,
    observed_at: 1750009000000,
  };

  const EXTRINSIC_ROW = {
    block_number: 4200000,
    extrinsic_index: 3,
    extrinsic_hash: "0x" + "c".repeat(64),
    signer: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    call_module: "SubtensorModule",
    call_function: "set_weights",
    call_args: null,
    success: 1,
    fee_tao: 0.0005,
    tip_tao: null,
    observed_at: 1750009000000,
  };

  test("list_blocks returns block feed with block_count and correct fields", async () => {
    const env = chainD1({ blocks: [BLOCK_ROW] });
    const res = await callTool("list_blocks", {}, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.block_count, 1);
    assert.equal(out.blocks[0].block_number, 4200000);
    assert.equal(out.blocks[0].extrinsic_count, 5);
    assert.equal(out.blocks[0].spec_version, 207);
  });

  test("list_blocks emits next_cursor for a full page", async () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({
      ...BLOCK_ROW,
      block_number: 4200000 - i,
    }));
    const env = chainD1({ blocks });
    const res = await callTool("list_blocks", { limit: 50 }, { env });
    const out = res.body.result.structuredContent;
    assert.ok(out.next_cursor, "full page must emit a keyset cursor");
    assert.equal(out.block_count, 50);
  });

  test("list_blocks uses cursor WHERE clause instead of OFFSET", async () => {
    const capture = [];
    const env = chainD1({ blocks: [] }, capture);
    await callTool("list_blocks", { cursor: "4200000" }, { env });
    const q = capture.find((c) => /FROM blocks/.test(c.sql));
    assert.ok(/WHERE block_number < \?/.test(q.sql));
    assert.ok(!/OFFSET/.test(q.sql));
    assert.ok(q.params.includes(4200000));
  });

  test("list_blocks degrades to empty payload on cold D1", async () => {
    const res = await callTool("list_blocks", {});
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.block_count, 0);
    assert.deepEqual(res.body.result.structuredContent.blocks, []);
  });

  test("get_block returns block detail with prev/next neighbors", async () => {
    const capture = [];
    const env = chainD1(
      { block: BLOCK_ROW, prev: 4199999, next: 4200001 },
      capture,
    );
    const res = await callTool("get_block", { ref: "4200000" }, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.ref, "4200000");
    assert.equal(out.block.block_number, 4200000);
    assert.equal(out.prev_block_number, 4199999);
    assert.equal(out.next_block_number, 4200001);
    const neighborQuery = capture.find(
      (c) => /AS prev/.test(c.sql) && /AS next/.test(c.sql),
    );
    assert.ok(neighborQuery, "get_block must query nearest stored neighbors");
    assert.ok(/WHERE block_number < \?/.test(neighborQuery.sql));
    assert.ok(/WHERE block_number > \?/.test(neighborQuery.sql));
    assert.ok(!/CASE WHEN block_number/.test(neighborQuery.sql));
    assert.deepEqual(neighborQuery.params, [4200000, 4200000]);
  });

  test("get_block accepts a 0x hash ref", async () => {
    const capture = [];
    const env = chainD1({ block: BLOCK_ROW }, capture);
    const hash = "0x" + "a".repeat(64);
    await callTool("get_block", { ref: hash }, { env });
    const q = capture.find((c) => /block_hash = \?/.test(c.sql));
    assert.ok(q, "hash ref must query by block_hash");
    assert.ok(q.params.includes(hash));
  });

  test("get_block returns block:null for an unknown ref (cold store)", async () => {
    const res = await callTool("get_block", { ref: "9999999" });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.block, null);
  });

  test("get_block rejects a missing ref argument", async () => {
    const res = await callTool("get_block", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ref/);
  });

  test("list_extrinsics returns extrinsic feed with correct fields", async () => {
    const env = chainD1({ extrinsics: [EXTRINSIC_ROW] });
    const res = await callTool("list_extrinsics", {}, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.extrinsic_count, 1);
    assert.equal(out.extrinsics[0].call_module, "SubtensorModule");
    assert.equal(out.extrinsics[0].success, true);
  });

  test("list_extrinsics filters by signer, call_module, call_function", async () => {
    const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
    const capture = [];
    const env = chainD1({ extrinsics: [] }, capture);
    await callTool(
      "list_extrinsics",
      {
        signer: SS58,
        call_module: "SubtensorModule",
        call_function: "set_weights",
      },
      { env },
    );
    const q = capture.find((c) => /FROM extrinsics/.test(c.sql));
    assert.ok(/signer = \?/.test(q.sql));
    assert.ok(/call_module = \?/.test(q.sql));
    assert.ok(/call_function = \?/.test(q.sql));
    assert.ok(q.params.includes(SS58));
    assert.ok(q.params.includes("SubtensorModule"));
    assert.ok(q.params.includes("set_weights"));
  });

  test("list_extrinsics uses cursor row-value seek instead of OFFSET", async () => {
    const capture = [];
    const env = chainD1({ extrinsics: [] }, capture);
    await callTool("list_extrinsics", { cursor: "4200000.3" }, { env });
    const q = capture.find((c) => /FROM extrinsics/.test(c.sql));
    assert.ok(
      /\(block_number, extrinsic_index\) < \(\?, \?\)/.test(q.sql),
      "cursor must use row-value seek",
    );
    assert.ok(!/OFFSET/.test(q.sql));
    assert.ok(q.params.includes(4200000) && q.params.includes(3));
  });

  test("list_extrinsics degrades to empty payload on cold D1", async () => {
    const res = await callTool("list_extrinsics", {});
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    assert.deepEqual(res.body.result.structuredContent.extrinsics, []);
  });

  test("get_extrinsic returns extrinsic detail by 0x hash", async () => {
    const hash = "0x" + "c".repeat(64);
    const env = chainD1({ extrinsic: EXTRINSIC_ROW });
    const res = await callTool("get_extrinsic", { ref: hash }, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.ref, hash);
    assert.equal(out.extrinsic.block_number, 4200000);
    assert.equal(out.extrinsic.call_function, "set_weights");
  });

  test("get_extrinsic returns extrinsic detail by composite block-index ref", async () => {
    const capture = [];
    const env = chainD1({ extrinsic: EXTRINSIC_ROW }, capture);
    await callTool("get_extrinsic", { ref: "4200000-3" }, { env });
    const q = capture.find((c) =>
      /block_number = \? AND extrinsic_index = \?/.test(c.sql),
    );
    assert.ok(
      q,
      "composite ref must use block_number + extrinsic_index PK hit",
    );
    assert.ok(q.params.includes(4200000) && q.params.includes(3));
  });

  test("get_extrinsic returns extrinsic:null for an unknown ref (cold store)", async () => {
    const res = await callTool("get_extrinsic", { ref: "0x" + "f".repeat(64) });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.extrinsic, null);
  });

  test("get_extrinsic rejects a missing ref argument", async () => {
    const res = await callTool("get_extrinsic", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ref/);
  });

  test("block-explorer payloads validate against their declared outputSchemas", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validatorFor = (name) =>
      ajv.compile(
        listToolDefinitions().find((t) => t.name === name).outputSchema,
      );
    const hash = "0x" + "c".repeat(64);
    const cases = [
      ["list_blocks", chainD1({ blocks: [BLOCK_ROW] }), {}],
      [
        "get_block",
        chainD1({ block: BLOCK_ROW, prev: 4199999, next: 4200001 }),
        { ref: "4200000" },
      ],
      ["list_extrinsics", chainD1({ extrinsics: [EXTRINSIC_ROW] }), {}],
      ["get_extrinsic", chainD1({ extrinsic: EXTRINSIC_ROW }), { ref: hash }],
    ];
    for (const [name, env, args] of cases) {
      const res = await callTool(name, args, { env });
      const validate = validatorFor(name);
      assert.ok(
        validate(res.body.result.structuredContent),
        `${name}: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});

describe("MCP tool-input validation — typed errors, never a throw (#742)", () => {
  // INVARIANT: a malformed argument must surface as a tools/call RESULT with
  // isError:true + a stable `invalid_params` code (so an agent branches on the
  // code), NOT as a thrown transport error or a 500. These exercise the
  // optionalEnum / requireString / clampLimit validators across several tools.

  test("optionalEnum rejects an out-of-set value with an invalid_params result", async () => {
    const res = await callTool("list_enrichment_targets", {
      tier: "not-a-real-tier",
    });
    assert.equal(res.status, 200, "transport stays 200; the error is in-band");
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "invalid_params",
    );
    assert.match(res.body.result.content[0].text, /must be one of/);
  });

  test("optionalEnum rejects a non-string value the same way", async () => {
    const res = await callTool("find_subnet_opportunities", { board: 7 });
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "invalid_params",
    );
  });

  test("requireString rejects a blank/whitespace-only required arg", async () => {
    for (const args of [{ query: "   " }, { query: "" }, { query: 42 }]) {
      const res = await callTool("search_subnets", args);
      assert.equal(res.body.result.isError, true, JSON.stringify(args));
      assert.equal(
        res.body.result.structuredContent.error.code,
        "invalid_params",
      );
      assert.match(res.body.result.content[0].text, /non-empty string/);
    }
  });

  test("an unknown tool name is a typed isError result, not a transport error", async () => {
    // Regression: callTool must return an isError result for an unknown tool
    // (the dispatcher never throws a -32603 for it).
    const res = await callTool("definitely_not_a_tool", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /Unknown tool/);
    // A non-string name is handled the same way (no crash on `.get`).
    const res2 = await rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: 123, arguments: {} },
    });
    assert.equal(res2.body.result.isError, true);
  });

  test("an unknown JSON-RPC method is a typed method-not-found, not a throw", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/teleport",
      params: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, -32601);
  });
});

// MCP↔REST parity tools (#393): per-subnet history/concentration-history, per-UID
// neuron history, the subnet chain-event stream, the provider detail, and the
// discovery-bundle artifact reads. Each mirrors its existing REST route's
// data-access (mcpD1Runner over the same SQL, or loadArtifactData over the same
// artifact) so an agent reaches the same data through MCP.
describe("MCP parity tools — subnet history / events (D1-backed)", () => {
  // A neuron_daily row shaped like NEURON_DAILY_READ_COLUMNS (snapshot_date +
  // the live NEURON_COLUMNS) so buildNeuronHistory/buildSubnetHistory consume it.
  function neuronDailyRow(date, uid, overrides = {}) {
    return {
      snapshot_date: date,
      uid,
      hotkey: `hk-${uid}`,
      coldkey: `ck-${uid}`,
      active: 1,
      validator_permit: uid === 0 ? 1 : 0,
      rank: 0.5,
      trust: 0.5,
      validator_trust: 0.5,
      consensus: 0.5,
      incentive: 0.4,
      dividends: 0.1,
      emission_tao: 1.25,
      stake_tao: 1000,
      registered_at_block: 100,
      is_immunity_period: 0,
      axon: null,
      block_number: 8454388,
      captured_at: 1750000000000,
      ...overrides,
    };
  }

  // A D1 binding routing by SQL shape over neuron_daily + account_events, so the
  // parity loaders' WHERE/GROUP-BY clauses get realistic rows. `capture` records
  // each bound (sql, params) so a test can assert what reached the query.
  function parityD1(
    { dailyAgg, dailyRows, concentrationRows, events } = {},
    capture = [],
  ) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  if (/FROM neuron_daily/.test(sql)) {
                    if (/GROUP BY snapshot_date/.test(sql))
                      return Promise.resolve({ results: dailyAgg || [] });
                    if (
                      /SELECT snapshot_date, stake_tao, emission_tao/.test(sql)
                    )
                      return Promise.resolve({
                        results: concentrationRows || [],
                      });
                    return Promise.resolve({ results: dailyRows || [] });
                  }
                  if (/FROM account_events/.test(sql))
                    return Promise.resolve({ results: events || [] });
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
  }

  test("get_subnet_history returns the per-day aggregate series newest-first", async () => {
    const capture = [];
    const env = parityD1(
      {
        dailyAgg: [
          {
            snapshot_date: "2026-06-26",
            neuron_count: 256,
            validator_count: 9,
            total_stake_tao: 2_500_000,
            total_emission_tao: 81,
          },
          {
            snapshot_date: "2026-06-25",
            neuron_count: 255,
            validator_count: 9,
            total_stake_tao: 2_400_000,
            total_emission_tao: 80,
          },
        ],
      },
      capture,
    );
    const res = await callTool(
      "get_subnet_history",
      { netuid: 1, window: "7d" },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.window, "7d");
    assert.equal(out.point_count, 2);
    assert.equal(out.points[0].snapshot_date, "2026-06-26");
    assert.equal(out.points[0].neuron_count, 256);
    // The window cutoff reached the SQL as a bound YYYY-MM-DD param.
    const q = capture.find((c) => /GROUP BY snapshot_date/.test(c.sql));
    assert.ok(q.params.some((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)));
  });

  test("get_subnet_history (all) omits the date cutoff bind", async () => {
    const capture = [];
    const env = parityD1({ dailyAgg: [] }, capture);
    const res = await callTool(
      "get_subnet_history",
      { netuid: 1, window: "all" },
      { env },
    );
    assert.equal(res.body.result.structuredContent.window, "all");
    const q = capture.find((c) => /GROUP BY snapshot_date/.test(c.sql));
    // Only netuid + MAX_HISTORY_POINTS limit are bound, no date cutoff.
    assert.equal(q.params.length, 2);
    assert.ok(!q.params.some((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)));
  });

  test("get_subnet_history defaults to the 30d window when omitted", async () => {
    const env = parityD1({ dailyAgg: [] });
    const res = await callTool("get_subnet_history", { netuid: 1 }, { env });
    assert.equal(res.body.result.structuredContent.window, "30d");
  });

  test("get_subnet_history rejects an unknown window", async () => {
    const res = await callTool("get_subnet_history", {
      netuid: 1,
      window: "5d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_neuron_history returns one UID's per-day series", async () => {
    const env = parityD1({
      dailyRows: [
        neuronDailyRow("2026-06-26", 3, { stake_tao: 1200, rank: 0.9 }),
        neuronDailyRow("2026-06-25", 3, { stake_tao: 1100, rank: 0.8 }),
      ],
    });
    const res = await callTool(
      "get_neuron_history",
      { netuid: 1, uid: 3, window: "30d" },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.uid, 3);
    assert.equal(out.point_count, 2);
    assert.equal(out.points[0].snapshot_date, "2026-06-26");
    assert.equal(out.points[0].stake_tao, 1200);
  });

  test("get_neuron_history requires a non-negative uid", async () => {
    const res = await callTool("get_neuron_history", { netuid: 1 });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /uid/);
  });

  test("get_subnet_concentration_history builds the per-day trend", async () => {
    const env = parityD1({
      concentrationRows: [
        { snapshot_date: "2026-06-26", stake_tao: 100, emission_tao: 10 },
        { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
        { snapshot_date: "2026-06-25", stake_tao: 80, emission_tao: 8 },
        { snapshot_date: "2026-06-25", stake_tao: 40, emission_tao: 4 },
      ],
    });
    const res = await callTool(
      "get_subnet_concentration_history",
      { netuid: 1, window: "30d" },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 2);
    assert.equal(out.points[0].snapshot_date, "2026-06-26");
    assert.equal(out.points[0].neuron_count, 2);
    assert.equal(typeof out.points[0].stake_gini, "number");
  });

  test("get_subnet_concentration_history rejects the 1y window (smaller set)", async () => {
    const res = await callTool("get_subnet_concentration_history", {
      netuid: 1,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_subnet_events filters by kind and paginates with a cursor", async () => {
    const capture = [];
    const env = parityD1(
      {
        events: [
          {
            block_number: 8502402,
            event_index: 1,
            event_kind: "WeightsSet",
            hotkey: null,
            coldkey: null,
            netuid: 1,
            uid: 226,
            amount_tao: null,
            alpha_amount: null,
            observed_at: 1751081952000,
            extrinsic_index: null,
          },
        ],
      },
      capture,
    );
    const res = await callTool(
      "get_subnet_events",
      { netuid: 1, kind: "WeightsSet", limit: 1 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.event_count, 1);
    assert.equal(out.limit, 1);
    assert.equal(out.events[0].event_kind, "WeightsSet");
    // A full page yields a non-null keyset cursor.
    assert.equal(typeof out.next_cursor, "string");
    // The kind filter reaches the SQL as a bound param (never interpolated).
    const q = capture.find((c) => /FROM account_events/.test(c.sql));
    assert.ok(/AND event_kind = \?/.test(q.sql));
    assert.ok(q.params.includes("WeightsSet"));
  });

  test("get_subnet_events clamps an over-range limit like the REST route", async () => {
    const capture = [];
    const env = parityD1({ events: [] }, capture);
    const res = await callTool(
      "get_subnet_events",
      { netuid: 1, limit: 5000 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.limit, 1000);
    const q = capture.find((c) => /FROM account_events/.test(c.sql));
    assert.ok(q.params.includes(1000));
  });

  test("the parity history/events tools degrade to empty payloads on cold D1", async () => {
    const history = await callTool("get_subnet_history", { netuid: 1 });
    assert.equal(history.body.result.isError, false);
    assert.equal(history.body.result.structuredContent.point_count, 0);

    const neuronHistory = await callTool("get_neuron_history", {
      netuid: 1,
      uid: 0,
    });
    assert.equal(neuronHistory.body.result.structuredContent.point_count, 0);

    const concentration = await callTool("get_subnet_concentration_history", {
      netuid: 1,
    });
    assert.equal(concentration.body.result.structuredContent.point_count, 0);

    const events = await callTool("get_subnet_events", { netuid: 1 });
    assert.equal(events.body.result.structuredContent.event_count, 0);
    assert.equal(events.body.result.structuredContent.next_cursor, null);
  });

  test("the parity history/events tools reject a negative netuid", async () => {
    for (const name of [
      "get_subnet_history",
      "get_subnet_concentration_history",
      "get_subnet_events",
    ]) {
      const res = await callTool(name, { netuid: -1 });
      assert.equal(res.body.result.isError, true, `${name} must reject -1`);
    }
  });
});

describe("MCP parity tools — provider + discovery bundle (artifact-backed)", () => {
  test("get_provider_detail returns the provider artifact (no endpoints by default)", async () => {
    const deps = makeDeps({
      "/metagraph/providers/datura.json": {
        id: "datura",
        slug: "datura",
        name: "Datura",
        authority: "official",
      },
    });
    const res = await callTool(
      "get_provider_detail",
      { slug: "datura" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.slug, "datura");
    assert.equal(out.name, "Datura");
    // No endpoints wrapper unless include_endpoints was set.
    assert.equal("provider" in out, false);
  });

  test("get_provider_detail attaches endpoints when include_endpoints is set", async () => {
    const deps = makeDeps({
      "/metagraph/providers/datura.json": { slug: "datura", name: "Datura" },
      "/metagraph/providers/datura/endpoints.json": {
        endpoints: [{ surface_id: "datura-api", url: "https://x" }],
      },
    });
    const res = await callTool(
      "get_provider_detail",
      { slug: "datura", include_endpoints: true },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.provider.slug, "datura");
    assert.equal(out.endpoints.endpoints[0].surface_id, "datura-api");
  });

  test("get_provider_detail null-fills endpoints when the artifact is absent", async () => {
    const deps = makeDeps({
      "/metagraph/providers/lonely.json": { slug: "lonely" },
    });
    const res = await callTool(
      "get_provider_detail",
      { slug: "lonely", include_endpoints: true },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.provider.slug, "lonely");
    assert.equal(out.endpoints, null);
  });

  test("get_provider_detail is not_found when the provider artifact is missing", async () => {
    const res = await callTool("get_provider_detail", { slug: "ghost" });
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
  });

  test("get_provider_detail rejects a slug that could escape the namespace", async () => {
    const res = await callTool("get_provider_detail", { slug: "../secrets" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid characters/);
  });

  test("list_fixtures returns the fixtures index artifact", async () => {
    const deps = makeDeps({
      "/metagraph/fixtures.json": {
        candidate_count: 2,
        coverage: [{ surface_id: "a", status: "captured" }],
      },
    });
    const res = await callTool("list_fixtures", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.candidate_count, 2);
    assert.equal(out.coverage[0].surface_id, "a");
  });

  test("list_schemas returns the schemas index artifact", async () => {
    const deps = makeDeps({
      "/metagraph/schemas/index.json": {
        schemas: [{ netuid: 6, drift_status: "new" }],
      },
    });
    const res = await callTool("list_schemas", {}, { deps });
    assert.equal(
      res.body.result.structuredContent.schemas[0].drift_status,
      "new",
    );
  });

  test("get_lineage returns the lineage artifact", async () => {
    const deps = makeDeps({
      "/metagraph/lineage.json": {
        link_count: 1,
        graduated_subnet_count: 1,
        broken_link_count: 0,
        links: [{ mainnet_netuid: 1, testnet_netuid: 1 }],
        broken_links: [],
      },
    });
    const res = await callTool("get_lineage", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.link_count, 1);
    assert.equal(out.links[0].mainnet_netuid, 1);
  });

  test("get_source_health returns the source-health artifact", async () => {
    const deps = makeDeps({
      "/metagraph/source-health.json": {
        providers: [{ id: "datura", status: "ok", endpoint_count: 3 }],
      },
    });
    const res = await callTool("get_source_health", {}, { deps });
    assert.equal(res.body.result.structuredContent.providers[0].status, "ok");
  });

  test("get_freshness overlays the live prober run onto surface-health", async () => {
    const deps = makeDeps(
      {
        "/metagraph/freshness.json": {
          schema_version: 1,
          sources: [
            { id: "surface-health", status: "stale", timestamp: "old" },
            { id: "adapter-snapshots", status: "captured" },
          ],
          summary: {},
        },
      },
      { "health:meta": { last_run_at: FRESH_RUN } },
    );
    const res = await callTool("get_freshness", {}, { deps });
    const out = res.body.result.structuredContent;
    const surfaceHealth = out.sources.find((s) => s.id === "surface-health");
    assert.equal(surfaceHealth.status, "current");
    assert.equal(surfaceHealth.timestamp, FRESH_RUN);
    assert.equal(out.summary.health_probe_as_of, FRESH_RUN);
  });

  test("get_freshness passes the committed artifact through with no live meta", async () => {
    const deps = makeDeps({
      "/metagraph/freshness.json": {
        schema_version: 1,
        sources: [{ id: "surface-health", status: "stale" }],
      },
    });
    const res = await callTool("get_freshness", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.sources[0].status, "stale");
  });
});
