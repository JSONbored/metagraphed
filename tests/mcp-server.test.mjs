import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
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
import * as profilesMcp from "../src/profiles-mcp.mjs";
import * as healthHistoryMcp from "../src/health-history-mcp.mjs";
import { KV_HEALTH_RPC_POOL } from "../src/health-prober.mjs";
import { createLocalArtifactEnv, latestArtifactDate } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";
import { EXPOSED_RESPONSE_HEADERS_VALUE } from "../workers/http.mjs";
import { MCP_CHAIN_STREAM_RESOURCE_URI } from "../workers/mcp-session-hub.mjs";

const MCP_URL = "https://api.metagraph.sh/mcp";

// Fresh prober run time for live KV fixtures — resolveLiveHealth rejects a
// health:current whose last_run_at is older than the 25-min freshness window.
const FRESH_RUN = new Date(Date.now() - 60_000).toISOString();
const HEALTH_HISTORY_DATE = await latestArtifactDate("health/history");
const HEALTH_HISTORY_BLOB = {
  date: HEALTH_HISTORY_DATE || "2026-06-06",
  summary: { incident_count: 0, surface_count: 2 },
  surfaces: [
    {
      netuid: 7,
      surface_id: "sn-7-example",
      kind: "openapi",
      provider: "allways",
      status: "ok",
      classification: "live",
      latency_ms: 120,
    },
    {
      netuid: 1,
      surface_id: "sn-1-example",
      kind: "openapi",
      provider: "other",
      status: "ok",
      classification: "live",
      latency_ms: 100,
    },
  ],
};

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
  { deps = makeDeps(), env = {}, method = "POST", headers = {} } = {},
) {
  const request = new Request(MCP_URL, {
    method,
    headers: { "content-type": "application/json", ...headers },
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

// A crypto.randomUUID()-shaped id, the only kind handleMcpRequest ever mints
// or accepts back from a client (isValidMcpSessionId's own length/charset
// bound is far looser, but this is what every real client will send).
const A_SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function fakeMcpSessionHubBinding(overrides = {}) {
  const calls = [];
  return {
    calls,
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url, init) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        if (overrides[path]) return overrides[path](init);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
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
      // subscribe: true (#4983 MCP half) -- metagraph://chain/stream is
      // subscribable; see resources/subscribe's own tests below.
      resources: { subscribe: true, listChanged: false },
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

describe("MCP resources/subscribe + resources/unsubscribe (#4983 MCP half)", () => {
  test("resources/read on the live chain-stream resource degrades gracefully when CHAIN_FIREHOSE_HUB is unbound", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
    });
    const data = JSON.parse(res.body.result.contents[0].text);
    assert.equal(data.table, null);
    assert.match(data.message, /not bound/);
  });

  test("resources/read on the live chain-stream resource returns ChainFirehoseHub's latest payload", async () => {
    const firehose = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () =>
          new Response(
            JSON.stringify({
              payload: { table: "chain_events", block_number: 8608447 },
            }),
            { status: 200 },
          ),
      }),
    };
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      { env: { CHAIN_FIREHOSE_HUB: firehose } },
    );
    assert.deepEqual(JSON.parse(res.body.result.contents[0].text), {
      table: "chain_events",
      block_number: 8608447,
    });
  });

  test("resources/read on the live chain-stream resource reports 'no event observed yet' when the hub is cold", async () => {
    const firehose = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ payload: null }), { status: 200 }),
      }),
    };
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      { env: { CHAIN_FIREHOSE_HUB: firehose } },
    );
    const data = JSON.parse(res.body.result.contents[0].text);
    assert.equal(data.table, null);
    assert.match(data.message, /no chain event observed yet/);
  });

  test("resources/subscribe rejects an unknown/non-subscribable uri with -32602", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/subscribe",
      params: { uri: "metagraph://registry/summary" },
    });
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /not subscribable/);
  });

  test("resources/subscribe requires an Mcp-Session-Id header", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/subscribe",
      params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
    });
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /Mcp-Session-Id/);
  });

  test("resources/subscribe reports resource_unavailable when MCP_SESSION_HUB is unbound", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      { headers: { "mcp-session-id": A_SESSION_ID } },
    );
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /not provisioned/);
  });

  test("resources/subscribe forwards to the session hub's /subscribe route and succeeds", async () => {
    const hub = fakeMcpSessionHubBinding();
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      {
        headers: { "mcp-session-id": A_SESSION_ID },
        env: { MCP_SESSION_HUB: hub },
      },
    );
    assert.deepEqual(res.body.result, {});
    assert.equal(hub.calls.length, 1);
    assert.match(hub.calls[0].url, /\/subscribe$/);
    assert.deepEqual(JSON.parse(hub.calls[0].init.body), {
      sessionId: A_SESSION_ID,
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    });
  });

  test("resources/subscribe surfaces a clear error when the session hub rejects the request", async () => {
    const hub = fakeMcpSessionHubBinding({
      "/subscribe": () => new Response(null, { status: 400 }),
    });
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      {
        headers: { "mcp-session-id": A_SESSION_ID },
        env: { MCP_SESSION_HUB: hub },
      },
    );
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /Could not subscribe/);
  });

  test("resources/unsubscribe requires a uri", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/unsubscribe",
      params: {},
    });
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /Missing required field: uri/);
  });

  test("resources/unsubscribe requires an Mcp-Session-Id header", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/unsubscribe",
      params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
    });
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /Mcp-Session-Id/);
  });

  test("resources/unsubscribe reports resource_unavailable when MCP_SESSION_HUB is unbound", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/unsubscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      { headers: { "mcp-session-id": A_SESSION_ID } },
    );
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /not provisioned/);
  });

  test("resources/subscribe as a notification (no id) is a no-op — never calls the session hub, returns 202", async () => {
    const hub = fakeMcpSessionHubBinding();
    const res = await rpc(
      {
        jsonrpc: "2.0",
        method: "resources/subscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      {
        headers: { "mcp-session-id": A_SESSION_ID },
        env: { MCP_SESSION_HUB: hub },
      },
    );
    assert.equal(res.status, 202);
    assert.equal(res.body, null);
    assert.equal(hub.calls.length, 0);
  });

  test("resources/unsubscribe as a notification (no id) is a no-op — never calls the session hub, returns 202", async () => {
    const hub = fakeMcpSessionHubBinding();
    const res = await rpc(
      {
        jsonrpc: "2.0",
        method: "resources/unsubscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      {
        headers: { "mcp-session-id": A_SESSION_ID },
        env: { MCP_SESSION_HUB: hub },
      },
    );
    assert.equal(res.status, 202);
    assert.equal(res.body, null);
    assert.equal(hub.calls.length, 0);
  });

  test("resources/unsubscribe forwards to the session hub's /unsubscribe route and succeeds, even for a uri never subscribed to", async () => {
    const hub = fakeMcpSessionHubBinding();
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/unsubscribe",
        params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
      },
      {
        headers: { "mcp-session-id": A_SESSION_ID },
        env: { MCP_SESSION_HUB: hub },
      },
    );
    assert.deepEqual(res.body.result, {});
    assert.equal(hub.calls.length, 1);
    assert.match(hub.calls[0].url, /\/unsubscribe$/);
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
  test("an unsupported method (e.g. PUT) is rejected with 405 and an Allow header listing GET/POST/DELETE", async () => {
    const res = await rpc(null, { method: "PUT" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, POST, DELETE, OPTIONS");
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

  test("the MCP rate limiter also covers GET and DELETE before session routing", async () => {
    for (const method of ["GET", "DELETE"]) {
      const hub = fakeMcpSessionHubBinding();
      const response = await handleMcpRequest(
        new Request(MCP_URL, {
          method,
          headers: { "mcp-session-id": A_SESSION_ID },
        }),
        {
          MCP_SESSION_HUB: hub,
          MCP_RATE_LIMITER: {
            async limit() {
              return { success: false };
            },
          },
        },
        makeDeps(),
      );
      assert.equal(response.status, 429);
      assert.equal(hub.calls.length, 0);
    }
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

  describe("MCP-Protocol-Version header (#4983 MCP half)", () => {
    test("an absent header is accepted (assumed 2025-03-26 per spec, not rejected)", async () => {
      const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
      assert.equal(res.status, 200);
    });

    test("a recognized header value is accepted", async () => {
      const res = await rpc(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSIONS[0] } },
      );
      assert.equal(res.status, 200);
    });

    test("an unrecognized header value is rejected with 400", async () => {
      const res = await rpc(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { headers: { "mcp-protocol-version": "1999-01-01" } },
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, -32600);
      assert.match(res.body.error.message, /Unsupported MCP-Protocol-Version/);
    });
  });

  describe("Mcp-Session-Id minting on initialize (#4983 MCP half)", () => {
    test("a successful initialize response mints a fresh Mcp-Session-Id response header", async () => {
      const res = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] },
      });
      assert.equal(res.status, 200);
      const sessionId = res.headers.get("mcp-session-id");
      assert.match(
        sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    test("two separate initialize calls mint two DIFFERENT session ids", async () => {
      const first = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      const second = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      assert.notEqual(
        first.headers.get("mcp-session-id"),
        second.headers.get("mcp-session-id"),
      );
    });

    test("a non-initialize method never mints a session id", async () => {
      const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
      assert.equal(res.headers.get("mcp-session-id"), null);
    });

    test("initialize inside a batch never mints a session id (legacy-array path predates sessions)", async () => {
      const res = await rpc([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ]);
      assert.equal(res.headers.get("mcp-session-id"), null);
    });
  });

  describe("GET /mcp — the SSE push stream (#4983 MCP half)", () => {
    test("without an Mcp-Session-Id header, rejects with 400", async () => {
      const res = await rpc(null, { method: "GET" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, -32600);
      assert.match(res.body.error.message, /Mcp-Session-Id/);
    });

    test("with a malformed Mcp-Session-Id header, rejects with 400", async () => {
      const res = await rpc(null, {
        method: "GET",
        headers: { "mcp-session-id": "has a space" },
      });
      assert.equal(res.status, 400);
    });

    test("with an unrecognized MCP-Protocol-Version header, rejects with 400 before checking the session", async () => {
      const res = await rpc(null, {
        method: "GET",
        headers: { "mcp-protocol-version": "1999-01-01" },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /Unsupported MCP-Protocol-Version/);
    });

    test("with a valid session id but MCP_SESSION_HUB unbound, degrades to 405", async () => {
      const res = await rpc(null, {
        method: "GET",
        headers: { "mcp-session-id": A_SESSION_ID },
        env: {},
      });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST, OPTIONS");
    });

    test("with MCP_SESSION_HUB bound, forwards to the session's /stream route and streams the response through", async () => {
      const hub = fakeMcpSessionHubBinding();
      const request = new Request(MCP_URL, {
        method: "GET",
        headers: { "mcp-session-id": A_SESSION_ID },
      });
      const response = await handleMcpRequest(request, {
        MCP_SESSION_HUB: hub,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      // #5545: SSE responses must carry nosniff like every other builder.
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(hub.calls.length, 1);
      assert.match(hub.calls[0].url, /\/stream\?sessionId=/);
      assert.match(
        hub.calls[0].url,
        new RegExp(encodeURIComponent(A_SESSION_ID)),
      );
    });

    test("a 409 from the session hub (a stream is already open) passes through as 409", async () => {
      const hub = fakeMcpSessionHubBinding({
        "/stream": () => new Response(null, { status: 409 }),
      });
      const request = new Request(MCP_URL, {
        method: "GET",
        headers: { "mcp-session-id": A_SESSION_ID },
      });
      const response = await handleMcpRequest(request, {
        MCP_SESSION_HUB: hub,
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.match(body.error.message, /already open/);
    });

    test("a 404 from the session hub (unknown/terminated session) passes through as 404", async () => {
      const hub = fakeMcpSessionHubBinding({
        "/stream": () => new Response(null, { status: 404 }),
      });
      const request = new Request(MCP_URL, {
        method: "GET",
        headers: { "mcp-session-id": A_SESSION_ID },
      });
      const response = await handleMcpRequest(request, {
        MCP_SESSION_HUB: hub,
      });
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error.message, /No such MCP session/);
    });
  });

  describe("DELETE /mcp — explicit session termination (#4983 MCP half)", () => {
    test("without an Mcp-Session-Id header, rejects with 400", async () => {
      const res = await rpc(null, { method: "DELETE" });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /Mcp-Session-Id/);
    });

    test("with a valid session id but MCP_SESSION_HUB unbound, degrades to 405", async () => {
      const res = await rpc(null, {
        method: "DELETE",
        headers: { "mcp-session-id": A_SESSION_ID },
      });
      assert.equal(res.status, 405);
    });

    test("with MCP_SESSION_HUB bound, forwards to the session's /terminate route and returns 204", async () => {
      const hub = fakeMcpSessionHubBinding();
      const request = new Request(MCP_URL, {
        method: "DELETE",
        headers: { "mcp-session-id": A_SESSION_ID },
      });
      const response = await handleMcpRequest(request, {
        MCP_SESSION_HUB: hub,
      });
      assert.equal(response.status, 204);
      assert.equal(hub.calls.length, 1);
      assert.match(hub.calls[0].url, /\/terminate$/);
      assert.equal(hub.calls[0].init.method, "POST");
      assert.deepEqual(JSON.parse(hub.calls[0].init.body), {
        sessionId: A_SESSION_ID,
      });
    });

    test("a 404 from the session hub (unknown session) passes through as 404", async () => {
      const hub = fakeMcpSessionHubBinding({
        "/terminate": () => new Response(null, { status: 404 }),
      });
      const request = new Request(MCP_URL, {
        method: "DELETE",
        headers: { "mcp-session-id": A_SESSION_ID },
      });
      const response = await handleMcpRequest(request, {
        MCP_SESSION_HUB: hub,
      });
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error.message, /No such MCP session/);
    });
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
      "/metagraph/agent-resources.json": {
        summary: { subnet_count: 2, callable_service_count: 13 },
        copyable_agent: { url: "https://api.metagraph.sh/agent.md" },
        mcp: { endpoint: "https://api.metagraph.sh/mcp", tools: [] },
        resources: [{ id: "agent", kind: "agent" }],
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
                auth_required: false,
                public_safe: true,
                score: 90,
                pool_eligible: true,
                latency_ms: 120,
              },
              {
                id: "b",
                url: "wss://b.example",
                provider: "y",
                kind: "subtensor-rpc",
                auth_required: false,
                public_safe: true,
                score: 95,
                pool_eligible: true,
                latency_ms: 80,
              },
              {
                id: "c",
                url: "wss://c.example",
                provider: "z",
                kind: "subtensor-rpc",
                auth_required: false,
                public_safe: true,
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
                auth_required: false,
                public_safe: true,
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

  test("get_subnet_detail merges the live economics row onto the raw structural record", async () => {
    const localDeps = makeDeps({
      "/metagraph/subnets/7.json": {
        schema_version: 1,
        subnet: { netuid: 7, slug: "allways", name: "Allways", tempo: 360 },
        surfaces: [],
        endpoints: [],
        gaps: [],
      },
      "/metagraph/economics.json": {
        schema_version: 1,
        summary: { with_economics_count: 1 },
        subnets: [{ netuid: 7, registration_cost_tao: 0.5, open_slots: 3 }],
      },
    });
    const res = await callTool(
      "get_subnet_detail",
      { netuid: 7 },
      { deps: localDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet.netuid, 7);
    assert.equal(out.subnet.tempo, 360);
    assert.equal(out.economics.open_slots, 3);
  });

  test("get_subnet_detail omits economics when no live row exists for the netuid", async () => {
    const localDeps = makeDeps({
      "/metagraph/subnets/7.json": {
        schema_version: 1,
        subnet: { netuid: 7, slug: "allways", name: "Allways" },
      },
      "/metagraph/economics.json": {
        schema_version: 1,
        summary: {},
        subnets: [],
      },
    });
    const res = await callTool(
      "get_subnet_detail",
      { netuid: 7 },
      { deps: localDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet.netuid, 7);
    assert.equal("economics" in out, false);
  });

  test("get_subnet_detail maps a missing artifact to a clean not_found", async () => {
    const res = await callTool("get_subnet_detail", { netuid: 999 }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
  });

  test("get_subnet_detail rejects a non-integer netuid", async () => {
    const res = await callTool(
      "get_subnet_detail",
      { netuid: "seven" },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
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

  test("get_agent_resources returns the AI-resources index", async () => {
    const res = await callTool("get_agent_resources", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.summary.subnet_count, 2);
    assert.ok(Array.isArray(out.resources));
    assert.ok(out.mcp.endpoint);
  });

  test("get_agent_resources reports not_found when the artifact is absent", async () => {
    const res = await callTool("get_agent_resources", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /unavailable in this environment/,
    );
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

  test("list_curation returns filtered curation rows", async () => {
    const deps = makeDeps({
      "/metagraph/curation.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        curation: [
          { netuid: 7, coverage_level: "probed", curation_level: "verified" },
          { netuid: 31, coverage_level: "manifested" },
        ],
      },
    });
    const res = await callTool("list_curation", { netuid: 7 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.curation[0].netuid, 7);
  });

  test("list_curation reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_curation", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Curation snapshot unavailable/,
    );
  });

  test("list_curation payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_curation",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/curation.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        notes: "ok",
        curation: [{ netuid: 7, coverage_level: "probed" }],
      },
    });
    const res = await callTool("list_curation", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_gaps returns filtered gap rows", async () => {
    const deps = makeDeps({
      "/metagraph/gaps.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        gaps: [
          {
            netuid: 7,
            coverage_level: "probed",
            curation_level: "maintainer-reviewed",
            gap_count: 2,
          },
          { netuid: 31, coverage_level: "manifested", gap_count: 5 },
        ],
      },
    });
    const res = await callTool("list_gaps", { netuid: 7 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.gaps[0].netuid, 7);
    assert.equal(out.gaps[0].gap_count, 2);
  });

  test("list_gaps reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_gaps", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Interface gaps snapshot unavailable/,
    );
  });

  test("list_gaps payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_gaps",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/gaps.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        notes: "ok",
        gaps: [{ netuid: 7, gap_count: 1 }],
      },
    });
    const res = await callTool("list_gaps", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_enrichment_queue returns filtered queue rows", async () => {
    const deps = makeDeps({
      "/metagraph/review/enrichment-queue.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        queue: [
          {
            netuid: 7,
            lane: "direct-submission",
            priority_score: 88,
            missing_kinds: ["openapi"],
          },
          {
            netuid: 12,
            lane: "maintainer-review",
            priority_score: 72,
            missing_kinds: ["website"],
          },
        ],
      },
    });
    const res = await callTool(
      "list_enrichment_queue",
      { lane: "direct-submission" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.queue[0].netuid, 7);
    assert.equal(out.queue[0].lane, "direct-submission");
  });

  test("list_enrichment_queue reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_enrichment_queue",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Enrichment queue snapshot unavailable/,
    );
  });

  test("list_enrichment_queue payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_enrichment_queue",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/review/enrichment-queue.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        queue: [{ netuid: 7, lane: "direct-submission", priority_score: 88 }],
      },
    });
    const res = await callTool("list_enrichment_queue", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_adapter_candidates returns filtered candidate rows", async () => {
    const deps = makeDeps({
      "/metagraph/review/adapter-candidates.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        candidates: [
          {
            netuid: 7,
            priority_score: 88,
            operational_kinds: ["openapi"],
            recommended_adapter_kind: "generic-openapi-or-custom",
          },
          {
            netuid: 12,
            priority_score: 72,
            operational_kinds: ["website"],
            recommended_adapter_kind: "custom-adapter",
          },
        ],
      },
    });
    const res = await callTool(
      "list_adapter_candidates",
      { operational_kinds: "openapi" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].netuid, 7);
    assert.equal(out.candidates[0].priority_score, 88);
  });

  test("list_adapter_candidates reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_adapter_candidates",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Adapter candidates snapshot unavailable/,
    );
  });

  test("list_adapter_candidates payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_adapter_candidates",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/review/adapter-candidates.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        candidates: [
          {
            netuid: 7,
            priority_score: 88,
            operational_kinds: ["openapi"],
          },
        ],
      },
    });
    const res = await callTool(
      "list_adapter_candidates",
      { limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_enrichment_evidence returns filtered evidence rows", async () => {
    const deps = makeDeps({
      "/metagraph/review/enrichment-evidence.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        entries: [
          {
            netuid: 7,
            evidence_action: "replace-stale-evidence",
            missing_kinds: ["openapi"],
            lane: "direct-submission",
          },
          {
            netuid: 12,
            evidence_action: "submit-new-evidence",
            missing_kinds: ["website"],
            lane: "maintainer-review",
          },
        ],
      },
    });
    const res = await callTool(
      "list_enrichment_evidence",
      { missing_kinds: "openapi" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.entries[0].netuid, 7);
    assert.equal(out.entries[0].evidence_action, "replace-stale-evidence");
  });

  test("list_enrichment_evidence reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_enrichment_evidence",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Enrichment evidence snapshot unavailable/,
    );
  });

  test("list_enrichment_evidence payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_enrichment_evidence",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/review/enrichment-evidence.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        entries: [
          {
            netuid: 7,
            evidence_action: "replace-stale-evidence",
            missing_kinds: ["openapi"],
          },
        ],
      },
    });
    const res = await callTool(
      "list_enrichment_evidence",
      { limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_review_gaps returns filtered priority rows", async () => {
    const deps = makeDeps({
      "/metagraph/review/gap-priorities.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        priorities: [
          {
            netuid: 7,
            priority_score: 88,
            curation_level: "candidate-discovered",
            missing_kinds: ["openapi"],
          },
          {
            netuid: 12,
            priority_score: 72,
            curation_level: "maintainer-reviewed",
            missing_kinds: ["website"],
          },
        ],
      },
    });
    const res = await callTool(
      "list_review_gaps",
      { curation_level: "candidate-discovered" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.priorities[0].netuid, 7);
    assert.equal(out.priorities[0].priority_score, 88);
  });

  test("list_review_gaps reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_review_gaps", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Review gap priorities snapshot unavailable/,
    );
  });

  test("list_review_gaps payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_review_gaps",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/review/gap-priorities.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        priorities: [
          {
            netuid: 7,
            priority_score: 88,
            curation_level: "candidate-discovered",
          },
        ],
      },
    });
    const res = await callTool("list_review_gaps", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_review_enrichment_targets returns filtered target rows", async () => {
    const deps = makeDeps({
      "/metagraph/review/enrichment-targets.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        targets: [
          {
            netuid: 7,
            priority_score: 88,
            target_type: "surface-candidate",
            target_action: "submit-new-candidate",
            missing_kinds: ["openapi"],
          },
          {
            netuid: 12,
            priority_score: 72,
            target_type: "maintainer-review",
            target_action: "maintainer-review",
            missing_kinds: ["website"],
          },
        ],
      },
    });
    const res = await callTool(
      "list_review_enrichment_targets",
      { target_type: "surface-candidate" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.targets[0].netuid, 7);
    assert.equal(out.targets[0].priority_score, 88);
  });

  test("list_review_enrichment_targets reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_review_enrichment_targets",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Review enrichment targets snapshot unavailable/,
    );
  });

  test("list_review_enrichment_targets payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_review_enrichment_targets",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/review/enrichment-targets.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        targets: [
          {
            netuid: 7,
            priority_score: 88,
            target_type: "surface-candidate",
          },
        ],
      },
    });
    const res = await callTool(
      "list_review_enrichment_targets",
      { limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_subnet_endpoints returns filtered endpoint rows", async () => {
    const deps = makeDeps({
      "/metagraph/endpoints/7.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        netuid: 7,
        endpoints: [
          {
            id: "allways-api",
            netuid: 7,
            kind: "subnet-api",
            status: "ok",
          },
          {
            id: "allways-openapi",
            netuid: 7,
            kind: "openapi",
            status: "degraded",
          },
        ],
      },
    });
    const res = await callTool(
      "list_subnet_endpoints",
      { netuid: 7, kind: "subnet-api" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].kind, "subnet-api");
    assert.equal(out.netuid, 7);
  });

  test("list_subnet_endpoints reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_subnet_endpoints",
      { netuid: 7 },
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /No endpoint snapshot exists for netuid 7/,
    );
  });

  test("list_subnet_endpoints payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_subnet_endpoints",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/endpoints/7.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        netuid: 7,
        endpoints: [{ id: "allways-api", netuid: 7, kind: "subnet-api" }],
      },
    });
    const res = await callTool(
      "list_subnet_endpoints",
      { netuid: 7, limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_endpoint_pools returns filtered pool rows", async () => {
    const deps = makeDeps({
      "/metagraph/endpoint-pools.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        pools: [
          {
            id: "finney-rpc",
            kind: "subtensor-rpc",
            eligible_count: 2,
            endpoint_count: 5,
          },
          {
            id: "finney-wss",
            kind: "subtensor-wss",
            eligible_count: 8,
            endpoint_count: 10,
          },
        ],
      },
    });
    const res = await callTool(
      "list_endpoint_pools",
      { kind: "subtensor-rpc" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.pools[0].id, "finney-rpc");
  });

  test("list_endpoint_pools reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_endpoint_pools", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Endpoint pool snapshot unavailable/,
    );
  });

  test("list_endpoint_pools payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_endpoint_pools",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/endpoint-pools.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        notes: "ok",
        pools: [{ id: "finney-rpc", eligible_count: 2 }],
      },
    });
    const res = await callTool("list_endpoint_pools", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_provider_endpoints returns filtered endpoint rows", async () => {
    const deps = makeDeps({
      "/metagraph/providers/datura/endpoints.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        endpoints: [
          {
            surface_id: "datura-api",
            kind: "subnet-api",
            status: "ok",
          },
          {
            surface_id: "datura-rpc",
            kind: "rpc",
            status: "degraded",
          },
        ],
      },
    });
    const res = await callTool(
      "list_provider_endpoints",
      { slug: "datura", kind: "subnet-api" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.slug, "datura");
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].surface_id, "datura-api");
  });

  test("list_provider_endpoints reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_provider_endpoints",
      { slug: "ghost" },
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /No endpoint catalog exists for provider 'ghost'/,
    );
  });

  test("list_provider_endpoints rejects a missing slug", async () => {
    const res = await callTool(
      "list_provider_endpoints",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /slug/);
  });

  test("list_provider_endpoints payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_provider_endpoints",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/providers/datura/endpoints.json": {
        endpoints: [{ surface_id: "datura-api", status: "ok" }],
      },
    });
    const res = await callTool(
      "list_provider_endpoints",
      { slug: "datura", limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_endpoint_incidents returns filtered incident rows", async () => {
    const deps = makeDeps({
      "/metagraph/endpoint-incidents.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        summary: { incident_count: 2 },
        incidents: [
          {
            id: "incident-a",
            netuid: 7,
            severity: "critical",
            state: "active",
            status: "failed",
          },
          {
            id: "incident-b",
            netuid: 31,
            severity: "warning",
            state: "active",
            status: "degraded",
          },
        ],
      },
    });
    const res = await callTool(
      "list_endpoint_incidents",
      { severity: "critical" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.incidents[0].id, "incident-a");
  });

  test("list_endpoint_incidents reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_endpoint_incidents",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Endpoint incident snapshot unavailable/,
    );
  });

  test("list_endpoint_incidents payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_endpoint_incidents",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/endpoint-incidents.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        notes: ["ok"],
        summary: { incident_count: 1 },
        incidents: [{ id: "incident-a", severity: "critical" }],
      },
    });
    const res = await callTool(
      "list_endpoint_incidents",
      { limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("registry_summary returns the summary artifact", async () => {
    const res = await callTool("registry_summary", {}, { deps });
    assert.equal(res.body.result.structuredContent.completeness, 0.42);
  });

  test("get_coverage returns the coverage artifact", async () => {
    const coverageDeps = makeDeps({
      "/metagraph/coverage.json": {
        surface_count: 99,
        completeness: { average_score: 55 },
      },
    });
    const res = await callTool("get_coverage", {}, { deps: coverageDeps });
    const out = res.body.result.structuredContent;
    assert.equal(out.surface_count, 99);
    assert.equal(out.completeness.average_score, 55);
  });

  test("get_coverage reports not_found when the artifact is absent", async () => {
    const res = await callTool("get_coverage", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /No resource at the requested/,
    );
  });

  test("get_changelog returns the changelog artifact", async () => {
    const deps = makeDeps({
      "/metagraph/changelog.json": {
        source: "generated-artifact-diff",
        summary: { artifact_added_count: 3 },
        artifacts: {
          added: [{ path: "/metagraph/foo.json" }],
          modified: [],
          removed: [],
        },
        subnets: { added: [], removed: [], renamed: [] },
        notes: ["publish-time diff"],
      },
    });
    const res = await callTool("get_changelog", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "generated-artifact-diff");
    assert.equal(out.summary.artifact_added_count, 3);
    assert.equal(out.artifacts.added.length, 1);
  });

  test("get_changelog reports not_found when the artifact is absent", async () => {
    const res = await callTool("get_changelog", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /unavailable in this environment/,
    );
  });

  test("get_changelog payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_changelog",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/changelog.json": {
        source: "generated-artifact-diff",
        summary: { artifact_added_count: 0 },
        artifacts: { added: [], modified: [], removed: [] },
        subnets: { added: [], removed: [], renamed: [] },
      },
    });
    const res = await callTool("get_changelog", {}, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_build returns the build summary artifact", async () => {
    const deps = makeDeps({
      "/metagraph/build-summary.json": {
        schema_version: 1,
        artifact_count: 99,
        artifacts: [{ path: "subnets.json", size_bytes: 1000 }],
        subnet_count: 129,
      },
    });
    const res = await callTool("get_build", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.schema_version, 1);
    assert.equal(out.artifact_count, 99);
    assert.equal(out.artifacts.length, 1);
  });

  test("get_build reports not_found when the artifact is absent", async () => {
    const res = await callTool("get_build", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /unavailable in this environment/,
    );
  });

  test("get_build payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_build",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/build-summary.json": {
        schema_version: 1,
        artifact_count: 0,
        artifacts: [],
      },
    });
    const res = await callTool("get_build", {}, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
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

  test("get_subnet_gaps returns the per-subnet gap artifact", async () => {
    const deps = makeDeps({
      "/metagraph/review/gaps/7.json": {
        schema_version: 1,
        netuid: 7,
        slug: "allways",
        name: "Allways",
        priorities: [
          {
            netuid: 7,
            slug: "allways",
            name: "Allways",
            missing_kinds: ["docs"],
            priority_score: 72,
            suggested_next_action: "Submit official docs evidence",
            candidate_count: 1,
            curation_level: "verified",
            review_state: "maintainer-reviewed",
            surface_count: 4,
            verified_candidate_count: 1,
          },
        ],
        enrichment_queue: [
          {
            netuid: 7,
            lane: "direct-submission",
            missing_kinds: ["docs"],
            recommended_action: "Submit official docs evidence",
            contribution_hint:
              "Submit one official public docs candidate with npm run surface:add.",
          },
        ],
      },
    });
    const res = await callTool("get_subnet_gaps", { netuid: 7 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.priorities[0].missing_kinds[0], "docs");
    assert.equal(out.enrichment_queue[0].lane, "direct-submission");
  });

  test("get_subnet_gaps is not_found when the artifact is missing", async () => {
    const res = await callTool("get_subnet_gaps", { netuid: 99999 });
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
  });

  test("get_subnet_gaps rejects invalid netuid", async () => {
    const res = await callTool("get_subnet_gaps", { netuid: -1 });
    assert.equal(res.body.result.isError, true);
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
      res.body.result.content[0].text.includes("all-events data tier"),
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

  test("list_chain_events returns the raw event feed and forwards filters", async () => {
    const dataApi = makeDataApi({
      payload: {
        count: 1,
        next_before: 4199999,
        next_cursor: "cursor-xyz",
        events: [
          {
            block_number: 4200000,
            event_index: 3,
            pallet: "SubtensorModule",
            method: "WeightsSet",
            args: [{ name: "netuid", value: 7 }],
            phase: "ApplyExtrinsic",
            extrinsic_index: 2,
            observed_at: 1750009000000,
          },
        ],
      },
    });
    const res = await callTool(
      "list_chain_events",
      { pallet: "SubtensorModule", method: "WeightsSet", limit: 10 },
      { env: { DATA_API: dataApi } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.count, 1);
    assert.equal(out.next_cursor, "cursor-xyz");
    assert.equal(out.events[0].pallet, "SubtensorModule");
    assert.equal(out.events[0].method, "WeightsSet");
    // The feed read hits /chain-events and forwards the filters + limit.
    assert.equal(dataApi.calls[0].pathname, "/api/v1/chain-events");
    assert.equal(
      dataApi.calls[0].searchParams.get("pallet"),
      "SubtensorModule",
    );
    assert.equal(dataApi.calls[0].searchParams.get("method"), "WeightsSet");
    assert.equal(dataApi.calls[0].searchParams.get("limit"), "10");
  });

  test("list_chain_events surfaces a data-Worker 400 as an invalid_params error", async () => {
    const dataApi = {
      calls: [],
      fetch(request) {
        this.calls.push(new URL(request.url));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "method filter requires pallet unless block is specified",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      },
    };
    const res = await callTool(
      "list_chain_events",
      { method: "WeightsSet" },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /requires pallet/);
  });

  test("list_chain_events errors cleanly when the DATA_API binding is absent", async () => {
    const res = await callTool("list_chain_events", {}, { env: {} });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /chain-events tier/);
  });

  test("list_chain_events applies the data API limiter before fetching", async () => {
    const dataApi = makeDataApi({ payload: { count: 0, events: [] } });
    const res = await callTool(
      "list_chain_events",
      {},
      {
        env: {
          DATA_API: dataApi,
          DATA_RATE_LIMITER: {
            async limit() {
              return { success: false };
            },
          },
        },
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /Too many data API requests/);
    assert.equal(dataApi.calls.length, 0);
  });

  test("list_chain_events forwards block/extrinsic/cursor and degrades to an empty feed", async () => {
    // An empty data-Worker body exercises the count/next/events fallbacks, and the
    // block/extrinsic/cursor filters cover the remaining query-param branches.
    const dataApi = makeDataApi({ payload: {} });
    const res = await callTool(
      "list_chain_events",
      { block: 4200000, extrinsic: 2, cursor: "abc", limit: 25 },
      { env: { DATA_API: dataApi } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.count, 0);
    assert.equal(out.next_before, null);
    assert.equal(out.next_cursor, null);
    assert.deepEqual(out.events, []);
    const q = dataApi.calls[0].searchParams;
    assert.equal(q.get("block"), "4200000");
    assert.equal(q.get("extrinsic"), "2");
    assert.equal(q.get("cursor"), "abc");
    assert.equal(q.get("limit"), "25");
  });

  test("list_chain_events surfaces a non-400 data-Worker error as tier_unavailable", async () => {
    const dataApi = makeDataApi({ status: 503 });
    const res = await callTool(
      "list_chain_events",
      {},
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /chain-events tier/);
    assert.match(res.body.result.content[0].text, /503/);
  });

  test("list_chain_events errors cleanly when the data Worker fetch throws", async () => {
    const dataApi = {
      calls: [],
      fetch() {
        return Promise.reject(new Error("socket hang up"));
      },
    };
    const res = await callTool(
      "list_chain_events",
      {},
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /could not be reached/);
  });

  test("list_chain_events falls back to a default message on a non-JSON 400 body", async () => {
    const dataApi = {
      calls: [],
      fetch(request) {
        this.calls.push(new URL(request.url));
        return Promise.resolve(new Response("not json", { status: 400 }));
      },
    };
    const res = await callTool(
      "list_chain_events",
      { method: "WeightsSet" },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Invalid chain-events filter/,
    );
  });
});

describe("MCP get_subnet_performance", () => {
  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so this tool always returns the schema-stable zeroed card
  // (buildSubnetPerformance([], netuid)) -- a D1 mock, if bound, is never queried.
  test("returns a schema-stable zeroed card (neurons D1 tier retired)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("D1 must not be queried -- neurons tier is retired");
        },
      },
    };
    const res = await callTool(
      "get_subnet_performance",
      { netuid: 7 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.validator_count, 0);
    assert.equal(out.incentive, null);
    assert.equal(out.trust, null);
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
    assert.equal(out.sort, "tx_count");
    assert.equal(out.signer_count, 1);
    assert.equal(out.signers[0].tx_count, 12);
    assert.equal(out.signers[0].total_fee_tao, 1.5);
  });

  test("rejects an invalid sort", async () => {
    const res = await callTool("get_chain_signers", { sort: "bogus" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /sort/i);
  });

  test("ranks signers by total_fee_tao when requested", async () => {
    let capturedSql;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capturedSql = sql;
              return {
                async all() {
                  assert.match(sql, /FROM extrinsics/);
                  assert.ok(params.includes(50));
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
      { window: "7d", sort: "total_fee_tao", limit: 50 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.sort, "total_fee_tao");
    assert.match(capturedSql, /ORDER BY total_fee_tao DESC, signer ASC/);
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

  test("applies the data-tier limiter before the D1 signers aggregation", async () => {
    let d1Calls = 0;
    const limiterKeys = [];
    const res = await callTool(
      "get_chain_signers",
      {},
      {
        env: {
          DATA_RATE_LIMITER: {
            async limit({ key }) {
              limiterKeys.push(key);
              return { success: false };
            },
          },
          METAGRAPH_HEALTH_DB: {
            prepare() {
              d1Calls += 1;
              return {
                bind() {
                  return {
                    async all() {
                      return { results: [] };
                    },
                  };
                },
              };
            },
          },
        },
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /Too many data API requests/);
    assert.deepEqual(limiterKeys, ["data:anonymous"]);
    assert.equal(d1Calls, 0);
  });

  test("proceeds to the D1 signers aggregation when the data-tier limiter allows the request", async () => {
    let d1Calls = 0;
    const limiterKeys = [];
    const res = await callTool(
      "get_chain_signers",
      {},
      {
        env: {
          DATA_RATE_LIMITER: {
            async limit({ key }) {
              limiterKeys.push(key);
              return { success: true };
            },
          },
          METAGRAPH_HEALTH_DB: {
            prepare() {
              d1Calls += 1;
              return {
                bind() {
                  return {
                    async all() {
                      return { results: [] };
                    },
                  };
                },
              };
            },
          },
        },
      },
    );
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(limiterKeys, ["data:anonymous"]);
    assert.equal(d1Calls, 1);
  });

  test("coalesces identical batched signers calls into one D1 query", async () => {
    let d1Calls = 0;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          d1Calls += 1;
          return {
            bind() {
              return {
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    };
    const message = (id) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "get_chain_signers",
        arguments: { window: "7d", limit: 50 },
      },
    });
    const res = await rpc([message(1), message(2)], { env });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.equal(d1Calls, 1);
  });

  test("returns an empty leaderboard when the signers D1 query times out", async () => {
    const env = {
      METAGRAPH_D1_TIMEOUT_MS: "1",
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return new Promise(() => {});
                },
              };
            },
          };
        },
      },
    };
    const res = await callTool("get_chain_signers", {}, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.signer_count, 0);
    assert.deepEqual(out.signers, []);
  });

  test("a batch of identical signers calls shares one limiter charge, not one per duplicate", async () => {
    let d1Calls = 0;
    let limiterCalls = 0;
    const env = {
      DATA_RATE_LIMITER: {
        async limit() {
          limiterCalls += 1;
          return { success: false };
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare() {
          d1Calls += 1;
          return {
            bind() {
              return {
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    };
    const message = (id) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "get_chain_signers",
        arguments: { window: "7d", limit: 50 },
      },
    });
    const res = await rpc([message(1), message(2), message(3)], { env });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
    for (const entry of res.body) {
      assert.equal(entry.result.isError, true);
      assert.match(entry.result.content[0].text, /Too many data API requests/);
    }
    assert.equal(
      limiterCalls,
      1,
      "identical batched calls must share a single limiter charge",
    );
    assert.equal(d1Calls, 0);
  });
});

describe("MCP get_chain_fees", () => {
  test("returns daily series and top payers from D1", async () => {
    // The median query only runs for days the daily aggregate already proved
    // are within the sample cap, so the mocked day must be one the real
    // window actually covers — use today (UTC), which any window ending at
    // the real "now" includes.
    const today = new Date().toISOString().slice(0, 10);
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async all() {
                  if (/ROW_NUMBER\(\) OVER/.test(sql)) {
                    return {
                      results: [
                        {
                          day: today,
                          median_fee_tao: 0.4,
                          median_tip_tao: 0.05,
                        },
                      ],
                    };
                  }
                  if (/GROUP BY day/.test(sql)) {
                    return {
                      results: [
                        {
                          day: today,
                          extrinsic_count: 20,
                          total_fee_tao: 8,
                          total_tip_tao: 2,
                        },
                      ],
                    };
                  }
                  assert.match(sql, /ORDER BY total_fee_tao DESC, signer ASC/);
                  assert.ok(params.includes(25));
                  return {
                    results: [
                      {
                        signer:
                          "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
                        total_fee_tao: 4,
                        total_tip_tao: 1,
                        extrinsic_count: 6,
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
      "get_chain_fees",
      { window: "7d", limit: 25 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.day_count, 1);
    assert.equal(out.daily[0].extrinsic_count, 20);
    assert.equal(out.daily[0].median_fee_tao, 0.4);
    assert.equal(out.daily[0].median_tip_tao, 0.05);
    assert.equal(out.top_fee_payers[0].total_fee_tao, 4);
  });

  test("scopes every chain-fees query by call_module", async () => {
    // The median query only runs for days the daily aggregate already proved
    // are within the sample cap, so the mocked daily response must report a
    // real day (today, UTC) rather than an empty result set.
    const today = new Date().toISOString().slice(0, 10);
    const calls = [];
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              if (sql.includes("call_module = ?")) {
                calls.push(params);
              }
              return {
                async all() {
                  if (/GROUP BY day/.test(sql)) {
                    return {
                      results: [
                        {
                          day: today,
                          extrinsic_count: 10,
                          total_fee_tao: 1,
                          total_tip_tao: 1,
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
    await callTool(
      "get_chain_fees",
      { window: "30d", call_module: "Balances", limit: 10 },
      { env },
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[0][1], "Balances"); // daily series
    assert.equal(calls[1][1], "Balances"); // top fee payers
    // Median query: the call_module filter is bound ONCE (numbered ?1) and
    // reused across every UNION ALL day block, followed by a
    // day-start/day-end pair per safe UTC day.
    const medianParams = calls[2];
    assert.equal(medianParams[0], "Balances");
    assert.equal((medianParams.length - 1) % 2, 0);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool("get_chain_fees", { window: "99d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/i);
  });

  test("rejects an over-long call_module", async () => {
    const res = await callTool(
      "get_chain_fees",
      { call_module: "x".repeat(101) },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /call_module/i);
  });

  test("returns empty series on a cold D1 store", async () => {
    const res = await callTool("get_chain_fees", {}, {});
    const out = res.body.result.structuredContent;
    assert.equal(out.day_count, 0);
    assert.deepEqual(out.daily, []);
    assert.deepEqual(out.top_fee_payers, []);
  });
});

describe("MCP get_chain_registrations", () => {
  // Route the two loadChainRegistrations reads by SQL: the network aggregate
  // (distinct_registrants + newest_observed, single row) vs the per-subnet
  // GROUP BY netuid leaderboard. The network aggregate's newest_observed must
  // be non-null or the loader short-circuits the per-subnet read.
  function registrationsD1(
    {
      network = { distinct_registrants: 7, newest_observed: 1_700_000_000_000 },
      subnets = [
        { netuid: 5, registrations: 12, distinct_registrants: 10 },
        { netuid: 2, registrations: 4, distinct_registrants: 4 },
      ],
    } = {},
    capture = [],
  ) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (/GROUP BY netuid/.test(sql)) {
                    return { results: subnets };
                  }
                  return { results: network ? [network] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  test("returns the per-subnet leaderboard and network rollup from D1", async () => {
    const capture = [];
    const res = await callTool(
      "get_chain_registrations",
      { window: "7d", limit: 20 },
      { env: registrationsD1({}, capture) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.subnet_count, 2);
    // Leaderboard ranked by registrations DESC.
    assert.equal(out.subnets[0].netuid, 5);
    assert.equal(out.subnets[0].registrations, 12);
    assert.equal(out.subnets[0].registrations_per_registrant, 1.2);
    assert.equal(out.subnets[1].netuid, 2);
    // Network rollup: distinct_registrants from the aggregate row, registrations
    // summed across subnets (12 + 4).
    assert.equal(out.network.distinct_registrants, 7);
    assert.equal(out.network.registrations, 16);
    // The aggregate read runs before the GROUP BY leaderboard read.
    assert.ok(!/GROUP BY netuid/.test(capture[0].sql));
    assert.match(capture[1].sql, /GROUP BY netuid/);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool(
      "get_chain_registrations",
      { window: "99d" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/i);
  });

  test("returns a schema-stable empty block on a cold D1 store", async () => {
    const res = await callTool("get_chain_registrations", {}, {});
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet_count, 0);
    assert.equal(out.network.registrations, 0);
    assert.equal(out.network.registrations_per_registrant, null);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
  });
});

describe("MCP get_chain_transfers", () => {
  function chainTransfersD1(
    {
      totals = {
        transfer_count: 10,
        total_volume_tao: 100,
        unique_senders: 4,
        unique_receivers: 6,
      },
      senders = [{ address: "5Sa", volume_tao: 80, transfer_count: 5 }],
      receivers = [{ address: "5Rx", volume_tao: 60, transfer_count: 4 }],
    } = {},
    capture = [],
  ) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
                    return { results: [totals] };
                  }
                  if (/GROUP BY hotkey/.test(sql)) {
                    return { results: senders };
                  }
                  if (/GROUP BY coldkey/.test(sql)) {
                    return { results: receivers };
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

  test("aggregates volume and ranks top senders/receivers", async () => {
    const capture = [];
    const env = chainTransfersD1({}, capture);
    const res = await callTool(
      "get_chain_transfers",
      { window: "7d", limit: 5 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.total_volume_tao, 100);
    assert.equal(out.top_senders[0].address, "5Sa");
    assert.equal(out.top_receivers[0].address, "5Rx");
    assert.equal(out.top_sender_share, 0.8);
    const senders = capture.find((c) => /GROUP BY hotkey/.test(c.sql));
    assert.match(senders.sql, /event_kind = \?/);
    assert.equal(senders.params.at(-1), 5);
  });

  test("defaults to the 7d window", async () => {
    const res = await callTool(
      "get_chain_transfers",
      {},
      { env: chainTransfersD1() },
    );
    assert.equal(res.body.result.structuredContent.window, "7d");
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_chain_transfers", { window: "1y" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("degrades to schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_transfers", { window: "30d" });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "30d");
    assert.equal(out.total_volume_tao, 0);
    assert.equal(out.top_sender_share, null);
    assert.deepEqual(out.top_senders, []);
    assert.deepEqual(out.top_receivers, []);
  });
});

describe("MCP stake-flow and movers economics tools", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  function stakeFlowD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /FROM account_events/.test(sql) &&
                    /GROUP BY event_kind/.test(sql)
                  ) {
                    return { results: rows };
                  }
                  if (
                    /FROM account_events/.test(sql) &&
                    /GROUP BY netuid, event_kind/.test(sql)
                  ) {
                    return { results: rows };
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

  function moversD1({ bounds, aggregateRows } = {}, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (/MIN\(snapshot_date\) AS start_date/.test(sql)) {
                    return { results: bounds };
                  }
                  if (/GROUP BY netuid, snapshot_date/.test(sql)) {
                    return { results: aggregateRows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_stake_flow always returns the schema-stable zeroed
  // card (buildStakeFlow([], netuid, {window})) regardless of `direction` --
  // covered by "degrades to zeros on cold D1" below; account_events row-shaping
  // and direction-narrowing are no longer reachable from this tool.

  test("get_subnet_stake_flow rejects an unsupported direction", async () => {
    const res = await callTool("get_subnet_stake_flow", {
      netuid: 7,
      direction: "sideways",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /direction must be one of/);
  });

  test("get_subnet_stake_flow rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_stake_flow", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_subnet_stake_flow rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_stake_flow", { window: "30d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  test("get_subnet_stake_flow degrades to zeros on cold D1", async () => {
    const res = await callTool("get_subnet_stake_flow", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.net_flow_tao, 0);
    assert.equal(out.stake_events, 0);
  });

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_stake_flow always returns the schema-stable
  // zeroed card (buildAccountStakeFlow([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping and
  // direction-narrowing are no longer reachable from this tool.

  test("get_account_stake_flow rejects a missing ss58", async () => {
    const res = await callTool("get_account_stake_flow", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_stake_flow rejects an unsupported window", async () => {
    const res = await callTool("get_account_stake_flow", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_stake_flow rejects an unsupported direction", async () => {
    const res = await callTool("get_account_stake_flow", {
      ss58: SS58,
      direction: "sideways",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /direction must be one of/);
  });

  test("get_account_stake_flow degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_stake_flow", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
  });

  function accountStakeMovesD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_coldkey/.test(sql) &&
                    /GROUP BY netuid/.test(sql)
                  ) {
                    return { results: rows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_stake_moves always returns the schema-stable
  // zeroed card (buildAccountStakeMoves([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping is no
  // longer reachable from this tool.

  test("get_account_stake_moves rejects a missing ss58", async () => {
    const res = await callTool("get_account_stake_moves", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_stake_moves rejects an unsupported window", async () => {
    const res = await callTool("get_account_stake_moves", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_stake_moves degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_stake_moves", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.total_movements, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_stake_moves payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_stake_moves",
    )?.outputSchema;
    const res = await callTool(
      "get_account_stake_moves",
      { ss58: SS58 },
      {
        env: accountStakeMovesD1([
          {
            netuid: 7,
            movements: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function accountAxonRemovalsD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_hotkey/.test(sql) &&
                    /GROUP BY netuid/.test(sql)
                  ) {
                    return { results: rows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_axon_removals always returns the schema-stable
  // zeroed card (buildAccountAxonRemovals([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping is no
  // longer reachable from this tool.

  test("get_account_axon_removals rejects a missing ss58", async () => {
    const res = await callTool("get_account_axon_removals", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_axon_removals rejects an unsupported window", async () => {
    const res = await callTool("get_account_axon_removals", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_axon_removals degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_axon_removals", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.total_removals, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_axon_removals payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_axon_removals",
    )?.outputSchema;
    const res = await callTool(
      "get_account_axon_removals",
      { ss58: SS58 },
      {
        env: accountAxonRemovalsD1([
          {
            netuid: 7,
            removals: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function accountPrometheusD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_hotkey/.test(sql) &&
                    /AS announcements/.test(sql) &&
                    /first_observed/.test(sql) &&
                    params[1] === "PrometheusServed"
                  ) {
                    return { results: rows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_prometheus always returns the schema-stable
  // zeroed card (buildAccountPrometheus([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping is no
  // longer reachable from this tool.

  test("get_account_prometheus rejects a missing ss58", async () => {
    const res = await callTool("get_account_prometheus", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_prometheus rejects an unsupported window", async () => {
    const res = await callTool("get_account_prometheus", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_prometheus degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_prometheus", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.total_announcements, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_prometheus payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_prometheus",
    )?.outputSchema;
    const res = await callTool(
      "get_account_prometheus",
      { ss58: SS58 },
      {
        env: accountPrometheusD1([
          {
            netuid: 7,
            announcements: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function accountRegistrationsD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_hotkey/.test(sql) &&
                    /AS registrations/.test(sql) &&
                    /first_observed/.test(sql)
                  ) {
                    return { results: rows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_registrations always returns the schema-stable
  // zeroed card (buildAccountRegistrations([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping is no
  // longer reachable from this tool.

  test("get_account_registrations rejects a missing ss58", async () => {
    const res = await callTool("get_account_registrations", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_registrations rejects an unsupported window", async () => {
    const res = await callTool("get_account_registrations", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_registrations degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_registrations", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.total_registrations, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_registrations payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_registrations",
    )?.outputSchema;
    const res = await callTool(
      "get_account_registrations",
      { ss58: SS58 },
      {
        env: accountRegistrationsD1([
          {
            netuid: 7,
            registrations: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function accountServingD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_hotkey/.test(sql) &&
                    /AS announcements/.test(sql) &&
                    /first_observed/.test(sql) &&
                    params[1] === "AxonServed"
                  ) {
                    return { results: rows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_serving always returns the schema-stable zeroed
  // card (buildAccountServing([], ss58, {window})) -- covered by "degrades to
  // zeros on cold D1" below; account_events row-shaping is no longer reachable
  // from this tool.

  test("get_account_serving rejects a missing ss58", async () => {
    const res = await callTool("get_account_serving", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_serving rejects an unsupported window", async () => {
    const res = await callTool("get_account_serving", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_serving degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_serving", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.total_announcements, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_serving payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_serving",
    )?.outputSchema;
    const res = await callTool(
      "get_account_serving",
      { ss58: SS58 },
      {
        env: accountServingD1([
          {
            netuid: 7,
            announcements: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function accountWeightSettersD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_hotkey/.test(sql) &&
                    /idx_account_events_netuid_uid_kind_observed/.test(sql) &&
                    /AS weight_sets/.test(sql) &&
                    /first_observed/.test(sql) &&
                    params[1] === "WeightsSet" &&
                    params[4] === "WeightsSet"
                  ) {
                    return { results: rows };
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

  function accountDeregistrationsD1(rows = [], capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  if (
                    /idx_account_events_hotkey/.test(sql) &&
                    /AS deregistrations/.test(sql) &&
                    /first_observed/.test(sql) &&
                    params[1] === "NeuronDeregistered"
                  ) {
                    return { results: rows };
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

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_deregistrations always returns the schema-stable
  // zeroed card (buildAccountDeregistrations([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping is no
  // longer reachable from this tool.

  test("get_account_deregistrations rejects a missing ss58", async () => {
    const res = await callTool("get_account_deregistrations", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_deregistrations rejects an unsupported window", async () => {
    const res = await callTool("get_account_deregistrations", {
      ss58: SS58,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_deregistrations degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_deregistrations", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.total_deregistrations, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_deregistrations payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_deregistrations",
    )?.outputSchema;
    const res = await callTool(
      "get_account_deregistrations",
      { ss58: SS58 },
      {
        env: accountDeregistrationsD1([
          {
            netuid: 7,
            deregistrations: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_weight_setters always returns the schema-stable
  // zeroed card (buildAccountWeightSetters([], ss58, {window})) -- covered by
  // "degrades to zeros on cold D1" below; account_events row-shaping is no
  // longer reachable from this tool.

  test("get_account_weight_setters rejects a missing ss58", async () => {
    const res = await callTool("get_account_weight_setters", {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /ss58/i);
  });

  test("get_account_weight_setters rejects an unsupported window", async () => {
    const res = await callTool("get_account_weight_setters", {
      ss58: SS58,
      window: "90d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_account_weight_setters degrades to zeros on cold D1", async () => {
    const res = await callTool("get_account_weight_setters", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.address, SS58);
    assert.equal(out.window, "7d");
    assert.equal(out.total_weight_sets, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.concentration, null);
    assert.equal(out.dominant_netuid, null);
    assert.deepEqual(out.subnets, []);
  });

  test("get_account_weight_setters payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_account_weight_setters",
    )?.outputSchema;
    const res = await callTool(
      "get_account_weight_setters",
      { ss58: SS58 },
      {
        env: accountWeightSettersD1([
          {
            netuid: 7,
            weight_sets: 2,
            first_observed: 1_717_000_000_000,
            last_observed: 1_717_500_000_000,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_movers always returns the schema-stable empty
  // leaderboard (buildMovers([], [], {window, startDate:null, endDate:null,
  // sort, limit})) -- covered by "degrades to an empty leaderboard on cold D1"
  // below; neuron_daily boundary-snapshot row-shaping is no longer reachable
  // from this tool.

  test("get_subnet_movers rejects an invalid sort", async () => {
    const res = await callTool("get_subnet_movers", { sort: "liquidity" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /sort must be one of/);
  });

  test("get_subnet_movers rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_movers", { window: "1y" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_subnet_movers degrades to an empty leaderboard on cold D1", async () => {
    const res = await callTool("get_subnet_movers", { window: "7d" });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.deepEqual(out.movers, []);
    assert.equal(out.subnet_count, 0);
  });

  test("stake-flow and movers payloads validate against outputSchemas", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validatorFor = (name) =>
      ajv.compile(
        listToolDefinitions().find((t) => t.name === name).outputSchema,
      );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    try {
      const subnetStake = await callTool(
        "get_subnet_stake_flow",
        { netuid: 7, window: "30d" },
        {
          env: stakeFlowD1([
            {
              event_kind: "StakeAdded",
              total_tao: 1,
              event_count: 1,
              last_observed: 1,
            },
          ]),
        },
      );
      assert.ok(
        validatorFor("get_subnet_stake_flow")(
          subnetStake.body.result.structuredContent,
        ),
      );
      const accountStake = await callTool(
        "get_account_stake_flow",
        { ss58: SS58 },
        { env: stakeFlowD1([]) },
      );
      assert.ok(
        validatorFor("get_account_stake_flow")(
          accountStake.body.result.structuredContent,
        ),
      );
      const accountMoves = await callTool(
        "get_account_stake_moves",
        { ss58: SS58 },
        { env: accountStakeMovesD1([]) },
      );
      assert.ok(
        validatorFor("get_account_stake_moves")(
          accountMoves.body.result.structuredContent,
        ),
      );
      const accountAxonRemovals = await callTool(
        "get_account_axon_removals",
        { ss58: SS58 },
        { env: accountAxonRemovalsD1([]) },
      );
      assert.ok(
        validatorFor("get_account_axon_removals")(
          accountAxonRemovals.body.result.structuredContent,
        ),
      );
      const accountPrometheus = await callTool(
        "get_account_prometheus",
        { ss58: SS58 },
        { env: accountPrometheusD1([]) },
      );
      assert.ok(
        validatorFor("get_account_prometheus")(
          accountPrometheus.body.result.structuredContent,
        ),
      );
      const accountRegistrations = await callTool(
        "get_account_registrations",
        { ss58: SS58 },
        { env: accountRegistrationsD1([]) },
      );
      assert.ok(
        validatorFor("get_account_registrations")(
          accountRegistrations.body.result.structuredContent,
        ),
      );
      const accountWeightSetters = await callTool(
        "get_account_weight_setters",
        { ss58: SS58 },
        { env: accountWeightSettersD1([]) },
      );
      assert.ok(
        validatorFor("get_account_weight_setters")(
          accountWeightSetters.body.result.structuredContent,
        ),
      );
      const accountServing = await callTool(
        "get_account_serving",
        { ss58: SS58 },
        { env: accountServingD1([]) },
      );
      assert.ok(
        validatorFor("get_account_serving")(
          accountServing.body.result.structuredContent,
        ),
      );
      const accountDeregistrations = await callTool(
        "get_account_deregistrations",
        { ss58: SS58 },
        { env: accountDeregistrationsD1([]) },
      );
      assert.ok(
        validatorFor("get_account_deregistrations")(
          accountDeregistrations.body.result.structuredContent,
        ),
      );
      const movers = await callTool(
        "get_subnet_movers",
        { limit: 3 },
        {
          env: moversD1({
            bounds: [{ start_date: "2026-06-01", end_date: "2026-06-30" }],
            aggregateRows: [],
          }),
        },
      );
      assert.ok(
        validatorFor("get_subnet_movers")(movers.body.result.structuredContent),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MCP get_subnet_event_summary", () => {
  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_event_summary always returns the schema-stable
  // empty summary (buildSubnetEventSummary([], [], netuid, {window, limit})) --
  // covered by "defaults to the 30d window and degrades to an empty summary on
  // cold D1" below; account_events row-shaping is no longer reachable from this
  // tool. `limit` is still echoed/clamped from `args`, so that assertion stays
  // meaningful without a D1 mock.
  test("echoes a custom limit even with no D1 data to shape", async () => {
    const res = await callTool("get_subnet_event_summary", {
      netuid: 7,
      window: "7d",
      limit: 2,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "7d");
    assert.equal(out.limit, 2);
    assert.equal(out.total_events, 0);
    assert.equal(out.recent_event_count, 0);
  });

  test("defaults to the 30d window and degrades to an empty summary on cold D1", async () => {
    const res = await callTool("get_subnet_event_summary", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.limit, 10);
    assert.equal(out.total_events, 0);
    assert.equal(out.recent_event_count, 0);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_event_summary", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_event_summary", { window: "30d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  test("rejects a non-integer netuid", async () => {
    const res = await callTool("get_subnet_event_summary", { netuid: "seven" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });
});

describe("MCP get_subnet_stake_moves", () => {
  function stakeMovesD1(row = null, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  return { results: row ? [row] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_stake_moves always returns the schema-stable
  // empty summary (buildSubnetStakeMoves(null, netuid, {window})) -- covered by
  // "cold subnet degrades to a schema-stable empty summary" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("cold subnet degrades to a schema-stable empty summary", async () => {
    const res = await callTool(
      "get_subnet_stake_moves",
      { netuid: 5 },
      { env: stakeMovesD1(null) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.movements, 0);
    assert.equal(out.distinct_movers, 0);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_stake_moves", {
      netuid: 5,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_stake_moves", { window: "7d" });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_stake_moves payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_subnet_stake_moves",
    )?.outputSchema;
    const res = await callTool(
      "get_subnet_stake_moves",
      { netuid: 5 },
      {
        env: stakeMovesD1({
          movements: 6,
          distinct_movers: 2,
          newest_observed: 1_717_500_000_000,
        }),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });
});

describe("MCP get_subnet_stake_transfers", () => {
  function stakeTransfersD1(row = null, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  return { results: row ? [row] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_stake_transfers always returns the schema-stable
  // empty summary (buildSubnetStakeTransfers(null, netuid, {window})) --
  // covered by "cold subnet degrades to a schema-stable empty summary" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("cold subnet degrades to a schema-stable empty summary", async () => {
    const res = await callTool(
      "get_subnet_stake_transfers",
      { netuid: 5 },
      { env: stakeTransfersD1(null) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.transfers, 0);
    assert.equal(out.distinct_senders, 0);
    assert.equal(out.transfers_per_sender, null);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_stake_transfers", {
      netuid: 5,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_stake_transfers", { window: "7d" });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_stake_transfers payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_subnet_stake_transfers",
    )?.outputSchema;
    const res = await callTool(
      "get_subnet_stake_transfers",
      { netuid: 5 },
      {
        env: stakeTransfersD1({
          transfers: 3,
          distinct_senders: 1,
          newest_observed: 1_717_500_000_000,
        }),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });
});

describe("MCP get_subnet_registrations", () => {
  function registrationsSubnetD1(row = null, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  return { results: row ? [row] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_registrations always returns the schema-stable
  // empty summary (buildSubnetRegistrations(null, netuid, {window})) -- covered
  // by "cold subnet degrades to a schema-stable empty summary" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("cold subnet degrades to a schema-stable empty summary", async () => {
    const res = await callTool(
      "get_subnet_registrations",
      { netuid: 5 },
      { env: registrationsSubnetD1(null) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.registrations, 0);
    assert.equal(out.distinct_registrants, 0);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_registrations", {
      netuid: 5,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_registrations", { window: "7d" });
    assert.equal(res.body.result.isError, true);
  });
});

describe("MCP get_subnet_weights", () => {
  function weightsD1(row = null, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  return { results: row ? [row] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_weights always returns the schema-stable zeroed
  // card (buildSubnetWeights(null, netuid, {window})) -- covered by "defaults
  // to the 7d window and degrades to a zeroed card on cold D1" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("defaults to the 7d window and degrades to a zeroed card on cold D1", async () => {
    const res = await callTool("get_subnet_weights", { netuid: 5 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.distinct_setters, 0);
    assert.equal(out.weight_sets, 0);
    assert.equal(out.sets_per_setter, null);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_weights", {
      netuid: 5,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_weights", { window: "7d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  test("get_subnet_weights payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_subnet_weights",
    )?.outputSchema;
    const res = await callTool(
      "get_subnet_weights",
      { netuid: 5 },
      {
        env: weightsD1({
          distinct_setters: 1,
          weight_sets: 3,
          newest_observed: 1_750_000_000_000,
        }),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });
});

describe("MCP get_subnet_weight_setters", () => {
  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_weight_setters always returns the schema-stable
  // empty leaderboard (buildSubnetWeightSetters([], null, netuid, {window})) --
  // covered by "defaults to the 7d window and degrades to an empty leaderboard
  // on cold D1" below; account_events row-shaping is no longer reachable from
  // this tool.

  test("defaults to the 7d window and degrades to an empty leaderboard on cold D1", async () => {
    const res = await callTool("get_subnet_weight_setters", { netuid: 5 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.weight_sets, 0);
    assert.equal(out.distinct_setters, 0);
    assert.equal(out.setter_count, 0);
    assert.deepEqual(out.setters, []);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_weight_setters", {
      netuid: 5,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_weight_setters", { window: "7d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });
});

describe("MCP get_subnet_axon_removals", () => {
  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_axon_removals always returns the schema-stable
  // zeroed card (buildSubnetAxonRemovals(null, netuid, {window})) -- covered by
  // "defaults to the 7d window and degrades to a zeroed card on cold D1" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("defaults to the 7d window and degrades to a zeroed card on cold D1", async () => {
    const res = await callTool("get_subnet_axon_removals", { netuid: 9 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.distinct_removers, 0);
    assert.equal(out.removals, 0);
    assert.equal(out.removals_per_remover, null);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_axon_removals", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_axon_removals", { window: "7d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });
});

describe("MCP get_subnet_serving", () => {
  function servingD1(row = null, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  return { results: row ? [row] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_serving always returns the schema-stable zeroed
  // card (buildSubnetServing(null, netuid, {window})) -- covered by "defaults
  // to the 7d window and degrades to a zeroed card on cold D1" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("defaults to the 7d window and degrades to a zeroed card on cold D1", async () => {
    const res = await callTool("get_subnet_serving", { netuid: 9 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.distinct_servers, 0);
    assert.equal(out.announcements, 0);
    assert.equal(out.announcements_per_server, null);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_serving", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_serving", { window: "7d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  test("get_subnet_serving payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_subnet_serving",
    )?.outputSchema;
    const res = await callTool(
      "get_subnet_serving",
      { netuid: 7 },
      {
        env: servingD1({
          distinct_servers: 1,
          announcements: 3,
          newest_observed: 1_750_000_000_000,
        }),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });
});

describe("MCP get_subnet_prometheus", () => {
  function prometheusD1(row = null, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                async all() {
                  return { results: row ? [row] : [] };
                },
              };
            },
          };
        },
      },
    };
  }

  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_prometheus always returns the schema-stable
  // zeroed card (buildSubnetPrometheus(null, netuid, {window})) -- covered by
  // "defaults to the 7d window and degrades to a zeroed card on cold D1" below;
  // account_events row-shaping is no longer reachable from this tool.

  test("defaults to the 7d window and degrades to a zeroed card on cold D1", async () => {
    const res = await callTool("get_subnet_prometheus", { netuid: 9 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.distinct_exporters, 0);
    assert.equal(out.announcements, 0);
    assert.equal(out.announcements_per_exporter, null);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_prometheus", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_prometheus", { window: "7d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  test("get_subnet_prometheus payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_subnet_prometheus",
    )?.outputSchema;
    const res = await callTool(
      "get_subnet_prometheus",
      { netuid: 7 },
      {
        env: prometheusD1({
          distinct_exporters: 1,
          announcements: 3,
          newest_observed: 1_750_000_000_000,
        }),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });
});

describe("MCP get_subnet_deregistrations", () => {
  // account_events' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_deregistrations always returns the schema-stable
  // zeroed card (buildSubnetDeregistrations(null, netuid, {window})) -- covered
  // by "defaults to the 7d window and degrades to a zeroed card on cold D1"
  // below; account_events row-shaping is no longer reachable from this tool.

  test("defaults to the 7d window and degrades to a zeroed card on cold D1", async () => {
    const res = await callTool("get_subnet_deregistrations", { netuid: 9 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.distinct_deregistered_hotkeys, 0);
    assert.equal(out.deregistrations, 0);
    assert.equal(out.deregistrations_per_hotkey, null);
  });

  test("rejects an unsupported window", async () => {
    const res = await callTool("get_subnet_deregistrations", {
      netuid: 9,
      window: "90d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_deregistrations", { window: "30d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });
});

describe("MCP get_subnet_performance_history", () => {
  // neuron_daily's D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_performance_history always returns the
  // schema-stable empty series (buildSubnetPerformanceHistory([], netuid,
  // {window, capped:false})) -- covered by "defaults to the 30d window on
  // cold D1" below; neuron_daily row-shaping is no longer reachable from this
  // tool.
  test("echoes a custom window even with no D1 data to shape", async () => {
    const res = await callTool("get_subnet_performance_history", {
      netuid: 7,
      window: "7d",
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "7d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("defaults to the 30d window on cold D1", async () => {
    const res = await callTool("get_subnet_performance_history", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool("get_subnet_performance_history", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_performance_history", {
      window: "7d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });
});

describe("MCP get_subnet_yield_history", () => {
  function yieldHistoryD1(rows = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(_sql) {
          return {
            bind(..._params) {
              return {
                async all() {
                  return { results: rows };
                },
              };
            },
          };
        },
      },
    };
  }

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_yield_history always returns the schema-stable
  // empty series (buildSubnetYieldHistory([], netuid, {window, capped:false}))
  // -- covered by "defaults to the 30d window on cold D1" below; neuron_daily
  // row-shaping is no longer reachable from this tool.

  test("defaults to the 30d window on cold D1", async () => {
    const res = await callTool("get_subnet_yield_history", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool("get_subnet_yield_history", {
      netuid: 7,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_yield_history", { window: "7d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  test("get_subnet_yield_history payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_subnet_yield_history",
    )?.outputSchema;
    const res = await callTool(
      "get_subnet_yield_history",
      { netuid: 7 },
      {
        env: yieldHistoryD1([
          {
            snapshot_date: "2026-06-27",
            stake_tao: 100,
            emission_tao: 10,
            validator_permit: 1,
          },
        ]),
      },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });
});

describe("MCP get_network_activity", () => {
  test("merges extrinsics + blocks tiers from D1", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async all() {
                  if (/FROM extrinsics/.test(sql)) {
                    assert.ok(typeof params[0] === "number");
                    return {
                      results: [
                        {
                          day: "2026-06-25",
                          extrinsic_count: 100,
                          successful_extrinsics: 99,
                          unique_signers: 40,
                        },
                      ],
                    };
                  }
                  if (/FROM blocks/.test(sql)) {
                    return {
                      results: [
                        {
                          day: "2026-06-25",
                          block_count: 7200,
                          event_count: 15000,
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
    const res = await callTool(
      "get_network_activity",
      { window: "7d" },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.day_count, 1);
    assert.equal(out.days[0].success_rate, 0.99);
    assert.equal(out.days[0].block_count, 7200);
    assert.equal(out.days[0].unique_signers, 40);
  });

  test("rejects an invalid window", async () => {
    const res = await callTool("get_network_activity", { window: "99d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/i);
  });

  test("defaults to 7d and returns schema-stable empty days on cold D1", async () => {
    const res = await callTool("get_network_activity", {}, {});
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.day_count, 0);
    assert.deepEqual(out.days, []);
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

describe("MCP call_rpc", () => {
  // Mirrors rpcEnv() in tests/request-handlers-rpc-proxy.test.mjs: rpc/pools.json
  // is R2-only, so both ASSETS and METAGRAPH_ARCHIVE are stubbed the same way
  // readArtifact's tier resolution expects.
  const RPC_POOL = {
    pools: [
      {
        id: "finney-rpc",
        endpoints: [
          {
            id: "fx",
            provider: "fx",
            pool_eligible: true,
            status: "ok",
            score: 100,
            url: "https://bittensor-finney.api.onfinality.io/public",
          },
        ],
      },
    ],
  };

  function callRpcEnv(overrides = {}) {
    return {
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      ASSETS: {
        async fetch(request) {
          const target = new URL(request.url);
          if (target.pathname === "/metagraph/rpc/pools.json") {
            return Response.json(RPC_POOL);
          }
          return new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return RPC_POOL;
            },
          };
        },
      },
      ...overrides,
    };
  }

  test("rejects a missing method as invalid_params", async () => {
    const res = await callTool("call_rpc", {}, { env: callRpcEnv() });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("rejects a non-array params as invalid_params", async () => {
    const res = await callTool(
      "call_rpc",
      { method: "system_health", params: "nope" },
      { env: callRpcEnv() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("rejects a non-string network as invalid_params", async () => {
    const res = await callTool(
      "call_rpc",
      { method: "system_health", network: 123 },
      { env: callRpcEnv() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("propagates the REST route's rpc_method_blocked error verbatim for a denied method", async () => {
    const res = await callTool(
      "call_rpc",
      { method: "author_submitExtrinsic" },
      { env: callRpcEnv() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /rpc_method_blocked/);
  });

  test("propagates rpc_network_unsupported for an unknown network", async () => {
    const res = await callTool(
      "call_rpc",
      { method: "system_health", network: "moonbeam" },
      { env: callRpcEnv() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /rpc_network_unsupported/);
  });

  test("forwards the real MCP client IP into the proxy's rate-limit key", async () => {
    let limiterKey;
    const env = callRpcEnv({
      // MCP_RATE_LIMITER absent falls back to RPC_RATE_LIMITER for the transport-
      // level MCP rate limit too (enforceMcpRateLimit) -- stub it separately so
      // only the proxy's own internal check below is under test.
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
    });
    const res = await callTool(
      "call_rpc",
      { method: "system_health" },
      { env, headers: { "cf-connecting-ip": "198.51.100.7" } },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /rpc_rate_limited/);
    assert.equal(limiterKey, "rpc:198.51.100.7");
  });

  test("returns the upstream result plus served-endpoint metadata on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { isSyncing: false, peers: 3, shouldHavePeers: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const res = await callTool(
        "call_rpc",
        { method: "system_health" },
        { env: callRpcEnv() },
      );
      const out = res.body.result.structuredContent;
      assert.equal(out.network, "finney");
      assert.equal(out.method, "system_health");
      assert.deepEqual(out.result, {
        isSyncing: false,
        peers: 3,
        shouldHavePeers: true,
      });
      assert.equal(out.error, null);
      assert.equal(out.endpoint_id, "fx");
      assert.equal(out.provider, "fx");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("defaults jsonrpc to 2.0 and result to null when the upstream body omits them", async () => {
    const originalFetch = globalThis.fetch;
    // A real JSON-RPC 2.0 upstream always includes both fields; this exercises
    // the defensive fallback for a hypothetical malformed/truncated upstream
    // body, not a shape the proxy is known to ever actually produce.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const res = await callTool(
        "call_rpc",
        { method: "system_health" },
        { env: callRpcEnv() },
      );
      const out = res.body.result.structuredContent;
      assert.equal(out.jsonrpc, "2.0");
      assert.equal(out.result, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("state_getStorage forwards to the state-query path and validates the key", async () => {
    const res = await callTool(
      "call_rpc",
      { method: "state_getStorage", params: ["not-hex"] },
      { env: callRpcEnv() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /0x-prefixed hex/);
  });

  test("rpc_invalid_response when the upstream body is not JSON", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    try {
      const res = await callTool(
        "call_rpc",
        { method: "system_health" },
        { env: callRpcEnv() },
      );
      assert.equal(res.body.result.isError, true);
      assert.match(res.body.result.content[0].text, /rpc_invalid_response/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("advertises a call_rpc-shaped outputSchema and the result validates against it", async () => {
    const ajv = new Ajv2020({ strict: false });
    const def = listToolDefinitions().find((t) => t.name === "call_rpc");
    assert.ok(def.outputSchema);
    const validate = ajv.compile(def.outputSchema);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "finney" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    try {
      const res = await callTool(
        "call_rpc",
        { method: "system_chain" },
        { env: callRpcEnv() },
      );
      assert.ok(
        validate(res.body.result.structuredContent),
        JSON.stringify(validate.errors),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("MCP query_graphql (#5591 — GraphQL bridge tool)", () => {
  test("executes a query and returns { data, errors }", async () => {
    const res = await callTool("query_graphql", { query: "{ __typename }" });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError ?? false, false);
    assert.deepEqual(out, { data: { __typename: "Query" }, errors: [] });
  });

  test("passes GraphQL variables through to the query", async () => {
    const res = await callTool("query_graphql", {
      query:
        "query Q($netuid: Int!) { subnet_serving(netuid: $netuid) { netuid schema_version } }",
      variables: { netuid: 7 },
    });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError ?? false, false);
    assert.deepEqual(out.errors, []);
    // Cold env (no Postgres flag) -> the resolver's schema-stable zeroed card.
    assert.equal(out.data.subnet_serving.netuid, 7);
    assert.equal(out.data.subnet_serving.schema_version, 1);
  });

  test("surfaces GraphQL validation errors as a populated errors[] (never bypassing the schema)", async () => {
    const res = await callTool("query_graphql", {
      query: "{ definitely_not_a_real_field }",
    });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError ?? false, false);
    assert.equal(out.data, null);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test("a query that exceeds the complexity cap is rejected, proving the cap is reused", async () => {
    // 11 aliased relationship fields (weight 5 each = 55) trip
    // GRAPHQL_MAX_COMPLEXITY (50); the shared handler's maxComplexityRule
    // rejects it, so the bridge can't bypass the GraphQL-side protection.
    const aliases = Array.from(
      { length: 11 },
      (_unused, i) => `a${i}: subnet_serving(netuid: ${i}) { netuid }`,
    ).join(" ");
    const res = await callTool("query_graphql", { query: `{ ${aliases} }` });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError ?? false, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
    assert.ok(/complex/i.test(JSON.stringify(out.errors)));
  });

  test("surfaces a non-2xx handler response (oversized query -> 413) as { data: null, errors[] }, never thrown", async () => {
    // Pins the invariant the handler relies on: every handleGraphQLRequest path,
    // including the non-2xx query-too-large (>16KB) response, returns a JSON
    // errors[] body -- so the bridge shapes it into { data, errors } rather than
    // throwing or dropping the error detail.
    // Padded with a GraphQL comment (non-whitespace, so requireString's trim
    // leaves it) to exceed GRAPHQL_MAX_QUERY_BYTES (16KB) -> the handler's 413.
    const oversized = `{ __typename }\n#${"x".repeat(17000)}`;
    const res = await callTool("query_graphql", { query: oversized });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError ?? false, false);
    assert.equal(out.data, null);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
    assert.ok(/too large/i.test(JSON.stringify(out.errors)));
  });

  test("applies the GraphQL rate limiter, surfacing a throttle as an error (never bypassing it)", async () => {
    // A saturated RPC_RATE_LIMITER makes graphqlRateLimited return its 429, so
    // the bridge is throttled identically to the REST route rather than
    // bypassing the GraphQL-specific per-client limit.
    // Saturate only the GraphQL bucket (key `gql:*`); the MCP-dispatch limiter
    // uses a different key and must still pass so the request reaches the tool.
    const env = {
      RPC_RATE_LIMITER: {
        limit: async ({ key }) => ({ success: !key.startsWith("gql:") }),
      },
    };
    const res = await callTool(
      "query_graphql",
      { query: "{ __typename }" },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.ok(/too many|rate/i.test(res.body.result.content[0].text));
  });

  test("requires a non-empty query string", async () => {
    const res = await callTool("query_graphql", { query: "   " });
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("query"));
  });

  test("rejects a non-object variables argument", async () => {
    const res = await callTool("query_graphql", {
      query: "{ __typename }",
      variables: [1, 2, 3],
    });
    assert.equal(res.body.result.isError, true);
    assert.ok(res.body.result.content[0].text.includes("variables"));
  });
});

describe("MCP get_account_counterparties", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const CP = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";

  // account_events' D1 write path is retired (#4772) and the table is dropped
  // in production, so get_account_counterparties always returns the
  // schema-stable empty rollup (list mode: buildCounterparties([], ss58,
  // {limit}); relationship mode: the composite literal seeded from
  // buildCounterpartyRelationship([], ss58, counterparty, {limit})) -- covered
  // by "degrades to an empty rollup on cold D1" below and the relationship-mode
  // assertion added there; account_events row-shaping is no longer reachable
  // from this tool.
  test("counterparty=<ss58> drills into the schema-stable empty relationship", async () => {
    const res = await callTool(
      "get_account_counterparties",
      { ss58: SS58, counterparty: CP },
      { env: {} },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.counterparty_count, 0);
    assert.deepEqual(out.counterparties, []);
    assert.equal(out.relationship.counterparty, CP);
    assert.equal(out.relationship.transfer_count, 0);
    assert.deepEqual(out.relationship.transfers, []);
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

  // Fixture: 0=root/active, 7=application/active/inference,
  // 8=application/deprecated with derived_categories ["data"].
  test("not_status / not_subnet_type / not_domain exclude matching subnets", async () => {
    const notActive = (
      await callTool("list_subnets", { not_status: "active" }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(notActive), [8]); // only the deprecated one

    const notApp = (
      await callTool(
        "list_subnets",
        { not_subnet_type: "application" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(notApp), [0]); // only the root one

    const notInference = (
      await callTool("list_subnets", { not_domain: "inference" }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(notInference), [0, 8]); // 7 (inference) dropped
  });

  test("not_domain also excludes a derived_categories match (union semantics)", async () => {
    // netuid 8 carries "data" only via derived_categories — the exclusion must
    // treat curated + derived tags as one domain set, like the inclusion does.
    const out = (
      await callTool("list_subnets", { not_domain: "data" }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [0, 7]);
  });

  test("not_<categorical> is case-insensitive (matches the inclusion form)", async () => {
    const out = (
      await callTool("list_subnets", { not_status: "ACTIVE" }, { deps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [8]);
  });

  test("a row missing the field fails inclusion but survives its exclusion (complements)", async () => {
    const localDeps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, slug: "a", name: "A", status: "active" },
          { netuid: 2, slug: "b", name: "B" }, // status absent
        ],
      },
    });
    const included = (
      await callTool("list_subnets", { status: "active" }, { deps: localDeps })
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(included), [1]); // absent-status row fails inclusion

    const excluded = (
      await callTool(
        "list_subnets",
        { not_status: "active" },
        { deps: localDeps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(excluded), [2]); // …but survives the exclusion
    // Together they partition the fixture: inclusion ∪ exclusion = all rows.
    assert.deepEqual(
      [...rangeNetuids(included), ...rangeNetuids(excluded)].sort(),
      [1, 2],
    );
  });

  test("inclusion and exclusion compose (status=active AND not_subnet_type=root)", async () => {
    const out = (
      await callTool(
        "list_subnets",
        { status: "active", not_subnet_type: "root" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(out), [7]); // active {0,7} minus root {0}
  });

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

  test("filters by coverage_level and curation_level (and their not_ exclusions)", async () => {
    const covDeps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 1,
            name: "A",
            coverage_level: "probed",
            curation_level: "maintainer-reviewed",
          },
          {
            netuid: 2,
            name: "B",
            coverage_level: "manifested",
            curation_level: "community-seeded",
          },
          {
            netuid: 3,
            name: "C",
            coverage_level: "native-only",
            curation_level: "native",
          },
        ],
      },
    });
    const rangeNetuids = (out) =>
      out.subnets.map((s) => s.netuid).sort((a, b) => a - b);

    const byCoverage = (
      await callTool(
        "list_subnets",
        { coverage_level: "probed" },
        { deps: covDeps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(byCoverage), [1]);

    const byCuration = (
      await callTool(
        "list_subnets",
        { curation_level: "community-seeded" },
        { deps: covDeps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(byCuration), [2]);

    const notCoverage = (
      await callTool(
        "list_subnets",
        { not_coverage_level: "native-only" },
        { deps: covDeps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(notCoverage), [1, 2]);

    const notCuration = (
      await callTool(
        "list_subnets",
        { not_curation_level: "native" },
        { deps: covDeps },
      )
    ).body.result.structuredContent;
    assert.deepEqual(rangeNetuids(notCuration), [1, 2]);
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

  // Realistic reserves (SN64 from the live economics.json artifact), matching
  // the fixture in tests/subnet-stake-quote-api.test.mjs.
  const STAKE_QUOTE_POOL_ROW = {
    netuid: 64,
    tao_in_pool_tao: 201959.938748425,
    alpha_in_pool: 2730860.150574127,
  };
  const STAKE_QUOTE_BLOB = { subnets: [STAKE_QUOTE_POOL_ROW] };

  test("get_subnet_stake_quote quotes a stake against the live pool reserves", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 64, amount: 1000, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, 64);
    assert.equal(out.direction, "stake");
    assert.equal(out.expected_out_unit, "alpha");
    assert.equal(out.is_root, false);
    assert.ok(out.expected_out > 0);
    assert.ok(out.price_impact_pct > 0);
    assert.equal(out.tao_in_pool_tao, STAKE_QUOTE_POOL_ROW.tao_in_pool_tao);
  });

  test("get_subnet_stake_quote quotes an unstake against the live pool reserves", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 64, amount: 500, direction: "unstake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.direction, "unstake");
    assert.equal(out.expected_out_unit, "tao");
    assert.ok(out.expected_out > 0);
  });

  test("get_subnet_stake_quote defaults direction to stake when omitted", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 64, amount: 10 },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.structuredContent.direction, "stake");
  });

  test("get_subnet_stake_quote returns a 1:1 zero-impact quote for root (netuid 0)", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 0, amount: 42, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.is_root, true);
    assert.equal(out.expected_out, 42);
    assert.equal(out.price_impact_pct, 0);
    assert.equal(out.tao_in_pool_tao, null);
  });

  test("get_subnet_stake_quote rejects a non-positive amount as invalid_amount", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 64, amount: -5, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_amount/);
  });

  test("get_subnet_stake_quote rejects an unknown direction as invalid_direction", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 64, amount: 10, direction: "swap" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_direction/);
  });

  test("get_subnet_stake_quote surfaces insufficient_liquidity when the subnet has no pool row", async () => {
    const res = await callTool(
      "get_subnet_stake_quote",
      { netuid: 999, amount: 10, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /insufficient_liquidity/);
  });

  test("get_stake_action_preview previews a stake with a human-readable summary + disclaimer", async () => {
    const res = await callTool(
      "get_stake_action_preview",
      { netuid: 64, amount: 1000, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 64);
    assert.equal(out.direction, "stake");
    assert.equal(out.estimated_out.unit, "alpha");
    assert.ok(out.estimated_out.amount > 0);
    assert.ok(out.price_impact_pct > 0);
    assert.match(out.summary, /Staking 1000 TAO on subnet 64/);
    assert.match(out.summary, /price impact \(slippage\)/);
    assert.match(out.disclaimer, /does not execute/i);
  });

  test("get_stake_action_preview defaults direction to stake when omitted", async () => {
    const res = await callTool(
      "get_stake_action_preview",
      { netuid: 64, amount: 10 },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.structuredContent.direction, "stake");
  });

  test("get_stake_action_preview previews an unstake (alpha in, TAO out)", async () => {
    const res = await callTool(
      "get_stake_action_preview",
      { netuid: 64, amount: 500, direction: "unstake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.direction, "unstake");
    assert.equal(out.estimated_out.unit, "tao");
    assert.match(out.summary, /Unstaking 500 alpha on subnet 64/);
    assert.ok(out.estimated_out.amount > 0);
  });

  test("get_stake_action_preview previews root (netuid 0) as 1:1 with no price impact", async () => {
    const res = await callTool(
      "get_stake_action_preview",
      { netuid: 0, amount: 42, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 0);
    assert.equal(out.price_impact_pct, 0);
    assert.match(out.summary, /root/);
    assert.match(out.summary, /no price impact/);
  });

  test("get_stake_action_preview output carries NO signable/extrinsic payload — only the human-readable summary", async () => {
    const res = await callTool(
      "get_stake_action_preview",
      { netuid: 64, amount: 10, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    // The read-only guarantee: the response must be a plain summary with a
    // disclaimer and expose nothing an agent could mistake for a submittable tx.
    assert.ok(out.summary && out.disclaimer);
    // Scan every field EXCEPT the disclaimer (which intentionally names these
    // words to state the tool does none of them) for any transaction shape.
    const { disclaimer: _disclaimer, ...scanned } = out;
    const serialized = JSON.stringify(scanned).toLowerCase();
    for (const forbidden of [
      "extrinsic",
      "unsigned",
      "signraw",
      "signature",
      "call_data",
      "calldata",
      "0x",
      "mortality",
      "nonce",
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `preview output must not contain a transaction-shaped field: "${forbidden}"`,
      );
    }
  });

  test("get_stake_action_preview surfaces insufficient_liquidity when the subnet has no pool row", async () => {
    const res = await callTool(
      "get_stake_action_preview",
      { netuid: 999, amount: 10, direction: "stake" },
      {
        deps: makeDeps({ "/metagraph/economics.json": STAKE_QUOTE_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /insufficient_liquidity/);
  });

  test("get_economics serves the live KV economics tier with REST list-query filters", async () => {
    const blob = {
      ...ECON_BLOB,
      subnets: [
        ECON_ROW,
        {
          ...ECON_ROW,
          netuid: 9,
          name: "Beta",
          slug: "beta",
          registration_allowed: false,
          emission_share: 0,
        },
      ],
      summary: {
        ...ECON_BLOB.summary,
        subnet_count: 2,
        with_economics_count: 2,
      },
    };
    const res = await callTool(
      "get_economics",
      { registration_allowed: "true", sort: "emission_share", order: "desc" },
      {
        deps: makeDeps({}, { "economics:current": blob }),
        env: { METAGRAPH_CONTRACT_VERSION: "test-contract" },
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "live-kv");
    assert.equal(out.subnets.length, 1);
    assert.equal(out.subnets[0].netuid, 7);
    assert.equal(out.total, 1);
  });

  test("get_economics falls back to R2 and pages with limit/cursor", async () => {
    const blob = {
      ...ECON_BLOB,
      subnets: [
        ECON_ROW,
        { ...ECON_ROW, netuid: 8, emission_share: 0.5 },
        { ...ECON_ROW, netuid: 9, emission_share: 0.1 },
      ],
    };
    const res = await callTool(
      "get_economics",
      { limit: 2, cursor: 1, sort: "netuid", order: "asc" },
      { deps: makeDeps({ "/metagraph/economics.json": blob }, {}), env: {} },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "r2-fallback");
    assert.equal(out.total, 3);
    assert.equal(out.returned, 2);
    assert.equal(out.cursor, 1);
    assert.equal(out.next_cursor, null);
    assert.deepEqual(
      out.subnets.map((row) => row.netuid),
      [8, 9],
    );
  });

  test("get_economics rejects an invalid sort field", async () => {
    const res = await callTool(
      "get_economics",
      { sort: "not_a_field" },
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("get_economics rejects invalid netuid and cursor before loading data", async () => {
    const deps = makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {});
    for (const [args, pattern] of [
      [{ netuid: -1 }, /netuid must be a non-negative integer/],
      [{ cursor: -1 }, /cursor must be a non-negative integer/],
    ]) {
      const res = await callTool("get_economics", args, { deps, env: {} });
      assert.equal(res.body.result.isError, true, JSON.stringify(args));
      assert.match(res.body.result.content[0].text, pattern);
    }
  });

  test("get_economics supports q search, fields projection, and netuid filter", async () => {
    const blob = {
      ...ECON_BLOB,
      network: "finney",
      subnets: [
        ECON_ROW,
        { ...ECON_ROW, netuid: 8, name: "Other", slug: "other" },
      ],
    };
    const res = await callTool(
      "get_economics",
      { q: "allways", fields: "netuid,name,emission_share" },
      { deps: makeDeps({ "/metagraph/economics.json": blob }, {}), env: {} },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.network, "finney");
    assert.equal(out.subnets.length, 1);
    assert.deepEqual(Object.keys(out.subnets[0]).sort(), [
      "emission_share",
      "name",
      "netuid",
    ]);

    const byNetuid = await callTool(
      "get_economics",
      { netuid: 8 },
      { deps: makeDeps({ "/metagraph/economics.json": blob }, {}), env: {} },
    );
    assert.equal(byNetuid.body.result.structuredContent.subnets[0].netuid, 8);
  });

  test("get_economics rejects unsupported fields projection", async () => {
    const res = await callTool(
      "get_economics",
      { fields: "netuid,not_a_field" },
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /fields includes unsupported/,
    );
  });

  test("get_economics returns next_cursor when more pages remain", async () => {
    const blob = {
      ...ECON_BLOB,
      subnets: [
        ECON_ROW,
        { ...ECON_ROW, netuid: 8 },
        { ...ECON_ROW, netuid: 9 },
      ],
    };
    const res = await callTool(
      "get_economics",
      { limit: 1, sort: "netuid", order: "asc" },
      { deps: makeDeps({ "/metagraph/economics.json": blob }, {}), env: {} },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.next_cursor, 1);
    assert.equal(out.subnets[0].netuid, 7);
  });

  test("get_economics defaults pagination when limit and cursor are omitted", async () => {
    const res = await callTool(
      "get_economics",
      {},
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "r2-fallback");
    assert.equal(out.subnets.length, 1);
    assert.equal(out.total, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.cursor, 0);
    assert.equal(out.next_cursor, null);
    assert.equal(out.captured_at, FRESH_RUN);
  });

  test("get_economics handler rethrows unexpected loader failures", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_economics");
    await assert.rejects(
      () =>
        tool.handler(
          {},
          {
            env: {},
            readHealthKv: async () => null,
            readArtifact: async () => {
              throw new Error("kaboom");
            },
          },
        ),
      /kaboom/,
    );
  });

  test("get_economics payload validates against its declared outputSchema", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(
      listToolDefinitions().find((t) => t.name === "get_economics")
        .outputSchema,
    );
    const res = await callTool(
      "get_economics",
      { sort: "netuid", order: "asc" },
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_economics surfaces not_found when neither tier has data", async () => {
    const res = await callTool(
      "get_economics",
      {},
      { deps: makeDeps({}, {}), env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /not_found/);
  });

  const PROFILES_BLOB = {
    captured_at: "2026-06-20T00:00:00Z",
    profiles: [
      {
        netuid: 7,
        slug: "allways",
        name: "Allways",
        completeness_score: 82,
        curation_level: "machine-verified",
        review_state: "verified",
        confidence: "high",
        profile_level: "complete",
      },
      {
        netuid: 1,
        slug: "alpha",
        name: "Alpha",
        completeness_score: 60,
        confidence: "medium",
      },
    ],
  };

  test("list_profiles serves profiles.json with REST list-query filters", async () => {
    const res = await callTool(
      "list_profiles",
      { netuid: 7, sort: "completeness_score", order: "desc" },
      {
        deps: makeDeps({ "/metagraph/profiles.json": PROFILES_BLOB }),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.profiles.length, 1);
    assert.equal(out.profiles[0].netuid, 7);
    assert.equal(out.total, 1);
  });

  test("list_profiles rejects an invalid sort field", async () => {
    const res = await callTool(
      "list_profiles",
      { sort: "not_a_field" },
      {
        deps: makeDeps({ "/metagraph/profiles.json": PROFILES_BLOB }),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("list_profiles surfaces not_found when profiles.json is absent", async () => {
    const res = await callTool(
      "list_profiles",
      {},
      { deps: makeDeps({}, {}), env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /not_found/);
  });

  test("list_profiles handler rethrows unexpected loader failures", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "list_profiles");
    await assert.rejects(
      () =>
        tool.handler(
          {},
          {
            env: {},
            readArtifact: async () => {
              throw new Error("kaboom");
            },
          },
        ),
      /kaboom/,
    );
  });

  test("get_subnet_profile returns the per-netuid profile artifact", async () => {
    const detail = {
      subnet: { netuid: 7, slug: "allways" },
      profile: { completeness_score: 82 },
    };
    const res = await callTool(
      "get_subnet_profile",
      { netuid: 7 },
      {
        deps: makeDeps({ "/metagraph/profiles/7.json": detail }),
        env: {},
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet.netuid, 7);
    assert.equal(out.profile.completeness_score, 82);
  });

  test("get_subnet_profile surfaces not_found for a missing netuid", async () => {
    const res = await callTool(
      "get_subnet_profile",
      { netuid: 99999 },
      { deps: makeDeps({}, {}), env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /not_found/);
  });

  test("get_subnet_profile handler rethrows unexpected loader failures", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_subnet_profile");
    await assert.rejects(
      () =>
        tool.handler(
          { netuid: 7 },
          {
            env: {},
            readArtifact: async () => {
              throw new Error("kaboom");
            },
          },
        ),
      /kaboom/,
    );
  });

  test("get_subnet_profile maps profilesMcp loader errors to tool errors", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_subnet_profile");
    const err = profilesMcp.profilesMcpError("not_found", "Profile gone.");
    const spy = vi
      .spyOn(profilesMcp, "loadSubnetProfile")
      .mockRejectedValue(err);
    try {
      await assert.rejects(
        () => tool.handler({ netuid: 7 }, { env: {} }),
        (thrown) => {
          assert.equal(thrown.toolError, true);
          assert.equal(thrown.code, "not_found");
          assert.match(thrown.message, /Profile gone/);
          return true;
        },
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("list_profiles maps profilesMcp loader errors to tool errors", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "list_profiles");
    const err = profilesMcp.profilesMcpError("invalid_params", "bad filter");
    const spy = vi
      .spyOn(profilesMcp, "loadProfilesList")
      .mockRejectedValue(err);
    try {
      await assert.rejects(
        () => tool.handler({}, { env: {} }),
        (thrown) => {
          assert.equal(thrown.toolError, true);
          assert.equal(thrown.code, "invalid_params");
          assert.match(thrown.message, /bad filter/);
          return true;
        },
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("list_profiles payload validates against its declared outputSchema", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(
      listToolDefinitions().find((t) => t.name === "list_profiles")
        .outputSchema,
    );
    const res = await callTool(
      "list_profiles",
      { sort: "netuid", order: "asc" },
      {
        deps: makeDeps({ "/metagraph/profiles.json": PROFILES_BLOB }),
        env: {},
      },
    );
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_subnet_profile payload validates against its declared outputSchema", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(
      listToolDefinitions().find((t) => t.name === "get_subnet_profile")
        .outputSchema,
    );
    const detail = {
      subnet: { netuid: 7, slug: "allways" },
      profile: { completeness_score: 82 },
      surfaces: [],
      endpoints: [],
    };
    const res = await callTool(
      "get_subnet_profile",
      { netuid: 7 },
      {
        deps: makeDeps({ "/metagraph/profiles/7.json": detail }),
        env: {},
      },
    );
    assert.ok(validate(res.body.result.structuredContent));
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
    blocks = [],
    accountEvents = [],
    weightsNetworkRows = [],
    weightsSubnetRows = [],
    stakeMovesNetworkRows = [],
    stakeMovesSubnetRows = [],
    stakeTransfersNetworkRows = [],
    stakeTransfersSubnetRows = [],
    axonRemovalsNetworkRows = [],
    axonRemovalsSubnetRows = [],
    chainDeregistrationsNetworkRows = [],
    chainDeregistrationsSubnetRows = [],
    chainPrometheusNetworkRows = [],
    chainPrometheusSubnetRows = [],
    chainServingNetworkRows = [],
    chainServingSubnetRows = [],
    transferPairTotals = [],
    transferPairRows = [],
  } = {}) {
    return {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              all() {
                if (sql.includes("FROM account_events")) {
                  // get_chain_weights reads a network aggregate (newest_observed
                  // + weight_sets) then a per-subnet GROUP BY (weight_sets);
                  // get_chain_stake_moves reads a network aggregate
                  // (newest_observed + distinct_movers, no weight_sets) then a
                  // per-subnet GROUP BY (AS movements); get_chain_stake_transfers
                  // reads a network aggregate (newest_observed + distinct_senders)
                  // then a per-subnet GROUP BY (AS transfers);
                  // get_chain_axon_removals reads a network aggregate
                  // (newest_observed + distinct_removers) then a per-subnet
                  // GROUP BY (AS removals); get_chain_deregistrations reads a
                  // network aggregate (newest_observed +
                  // distinct_deregistered_hotkeys) then a per-subnet GROUP BY
                  // (AS deregistrations + distinct_deregistered_hotkeys);
                  // get_chain_prometheus reads a network aggregate
                  // (newest_observed + distinct_exporters) then a per-subnet GROUP BY
                  // (AS announcements + distinct_exporters);
                  // get_chain_serving reads a network aggregate
                  // (newest_observed + distinct_servers) then a per-subnet GROUP BY
                  // (AS announcements + distinct_servers);
                  // get_chain_transfer_pairs reads a totals CTE
                  // (top_pair_volume_tao) then per-corridor rows (AS from_address);
                  // everything else uses the flat account_events fixture.
                  if (sql.includes("newest_observed")) {
                    if (sql.includes("weight_sets")) {
                      return Promise.resolve({ results: weightsNetworkRows });
                    }
                    if (sql.includes("distinct_movers")) {
                      return Promise.resolve({
                        results: stakeMovesNetworkRows,
                      });
                    }
                    if (sql.includes("distinct_senders")) {
                      return Promise.resolve({
                        results: stakeTransfersNetworkRows,
                      });
                    }
                    if (sql.includes("distinct_removers")) {
                      return Promise.resolve({
                        results: axonRemovalsNetworkRows,
                      });
                    }
                    if (sql.includes("distinct_deregistered_hotkeys")) {
                      return Promise.resolve({
                        results: chainDeregistrationsNetworkRows,
                      });
                    }
                    if (sql.includes("distinct_exporters")) {
                      return Promise.resolve({
                        results: chainPrometheusNetworkRows,
                      });
                    }
                    if (sql.includes("distinct_servers")) {
                      return Promise.resolve({
                        results: chainServingNetworkRows,
                      });
                    }
                    return Promise.resolve({ results: weightsNetworkRows });
                  }
                  if (sql.includes("weight_sets")) {
                    return Promise.resolve({ results: weightsSubnetRows });
                  }
                  if (sql.includes("AS movements")) {
                    return Promise.resolve({ results: stakeMovesSubnetRows });
                  }
                  if (sql.includes("AS transfers")) {
                    return Promise.resolve({
                      results: stakeTransfersSubnetRows,
                    });
                  }
                  if (sql.includes("AS removals")) {
                    return Promise.resolve({ results: axonRemovalsSubnetRows });
                  }
                  if (
                    sql.includes("AS deregistrations") &&
                    sql.includes("distinct_deregistered_hotkeys")
                  ) {
                    return Promise.resolve({
                      results: chainDeregistrationsSubnetRows,
                    });
                  }
                  if (
                    sql.includes("AS announcements") &&
                    sql.includes("distinct_exporters")
                  ) {
                    return Promise.resolve({
                      results: chainPrometheusSubnetRows,
                    });
                  }
                  if (
                    sql.includes("AS announcements") &&
                    sql.includes("distinct_servers")
                  ) {
                    return Promise.resolve({
                      results: chainServingSubnetRows,
                    });
                  }
                  if (sql.includes("top_pair_volume_tao")) {
                    return Promise.resolve({ results: transferPairTotals });
                  }
                  if (sql.includes("AS from_address")) {
                    return Promise.resolve({ results: transferPairRows });
                  }
                  return Promise.resolve({ results: accountEvents });
                }
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
                if (sql.includes("FROM blocks")) {
                  return Promise.resolve({ results: blocks });
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

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_metagraph always returns the schema-stable empty
  // metagraph (buildSubnetMetagraph([], netuid)) regardless of validator_permit
  // -- a D1 mock, if bound, is never queried.
  test("get_subnet_metagraph returns a schema-stable empty metagraph (neurons D1 tier retired)", async () => {
    const res = await callTool(
      "get_subnet_metagraph",
      { netuid: 7 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.block_number, null);
    assert.equal(out.captured_at, null);
    assert.deepEqual(out.neurons, []);
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

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so list_subnet_validators always ranks over the schema-stable
  // empty base list (buildSubnetValidators([], netuid)) -- a D1 mock, if
  // bound, is never queried. Each test still exercises a distinct branch of
  // the handler's post-fetch limit/min_stake_tao filtering ternary.
  test("list_subnet_validators returns a schema-stable empty list (neurons D1 tier retired)", async () => {
    const res = await callTool(
      "list_subnet_validators",
      { netuid: 7 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.validator_count, 0);
    assert.deepEqual(out.validators, []);
  });

  test("list_subnet_validators limit is a no-op on an empty base list", async () => {
    const res = await callTool(
      "list_subnet_validators",
      { netuid: 7, limit: 2 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.validator_count, 0);
    assert.deepEqual(out.validators, []);
  });

  test("list_subnet_validators min_stake_tao is a no-op on an empty base list", async () => {
    const res = await callTool(
      "list_subnet_validators",
      { netuid: 7, min_stake_tao: 50 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.validator_count, 0);
    assert.deepEqual(out.validators, []);
  });

  test("list_subnet_validators combines min_stake_tao and limit on an empty base list", async () => {
    const res = await callTool(
      "list_subnet_validators",
      { netuid: 7, min_stake_tao: 6, limit: 1 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.validator_count, 0);
    assert.deepEqual(out.validators, []);
  });

  test("list_subnet_validators rejects limit=0 and a negative min_stake_tao", async () => {
    const zeroLimit = await callTool(
      "list_subnet_validators",
      { netuid: 7, limit: 0 },
      { env: d1Env },
    );
    assert.equal(zeroLimit.body.result.isError, true);
    assert.match(zeroLimit.body.result.content[0].text, /invalid_params/);

    const negStake = await callTool(
      "list_subnet_validators",
      { netuid: 7, min_stake_tao: -1 },
      { env: d1Env },
    );
    assert.equal(negStake.body.result.isError, true);
    assert.match(negStake.body.result.content[0].text, /invalid_params/);
  });

  test("list_global_validators returns schema-stable empty list on cold D1", async () => {
    const res = await callTool("list_global_validators", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.sort, "subnet_count");
    assert.equal(out.limit, 20);
    assert.equal(out.validator_count, 0);
    assert.deepEqual(out.validators, []);
    assert.equal(out.captured_at, null);
  });

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so list_global_validators always ranks over the schema-stable
  // empty base list (buildGlobalValidators([], {sort, limit})) -- a D1 mock,
  // if bound, is never queried. Row-shaping/sorting across a real leaderboard
  // is still covered directly against the pure builder in
  // tests/metagraph-neurons.test.mjs; this only proves each REST-supported
  // sort key is still accepted and echoed back with an empty leaderboard.
  test("list_global_validators accepts each REST-supported sort key with an empty leaderboard", async () => {
    for (const sort of [
      "subnet_count",
      "uid_count",
      "total_stake",
      "total_emission",
      "max_validator_trust",
      "avg_validator_trust",
      "stake_dominance",
    ]) {
      const res = await callTool("list_global_validators", { sort, limit: 1 });
      const out = res.body.result.structuredContent;
      assert.equal(out.sort, sort, `sort echo for ${sort}`);
      assert.equal(out.limit, 1);
      assert.equal(out.validator_count, 0);
      assert.deepEqual(out.validators, []);
    }
  });

  test("list_global_validators rejects an invalid sort", async () => {
    const res = await callTool("list_global_validators", { sort: "bogus" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /sort/i);
  });

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_neuron always returns the schema-stable neuron:null
  // detail (buildNeuronDetail(null, netuid)) regardless of uid -- a D1 mock,
  // if bound, is never queried.
  test("get_neuron returns a schema-stable neuron:null detail (neurons D1 tier retired)", async () => {
    const res = await callTool(
      "get_neuron",
      { netuid: 7, uid: 0 },
      { env: d1Env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron, null);
    assert.equal(out.captured_at, null);
    assert.equal(out.block_number, null);
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
    assert.equal(out.days[1].total_stake_tao, "1000.000000000");
  });

  test("get_economics_trends rejects an invalid window", async () => {
    const res = await callTool(
      "get_economics_trends",
      { window: "99d" },
      { env: d1Env },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /is not a supported window/);
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

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_concentration always returns the schema-stable
  // null-block card (buildConcentration([], netuid)) -- covered by "returns
  // schema-stable null blocks on cold D1" above; entity-collapsing row-shaping
  // is still covered directly against the pure builder in
  // tests/concentration.test.mjs.

  test("get_chain_concentration returns schema-stable null blocks on cold D1", async () => {
    const res = await callTool("get_chain_concentration", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.stake, null);
    assert.equal(out.emission, null);
  });

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_chain_concentration always returns the schema-stable
  // null-block card (buildChainConcentration([])) -- covered by "returns
  // schema-stable null blocks on cold D1" above; entity-collapsing row-shaping
  // is still covered directly against the pure builder in
  // tests/chain-concentration.test.mjs.

  test("get_chain_performance returns schema-stable null blocks on cold D1", async () => {
    const res = await callTool("get_chain_performance", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.incentive, null);
    assert.equal(out.trust, null);
    assert.equal(out.validator_trust, null);
  });

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_chain_performance always returns the schema-stable
  // null-block card (buildChainPerformance([])) -- covered by "returns
  // schema-stable null blocks on cold D1" above; reward/score row-shaping is
  // still covered directly against the pure builder in
  // tests/chain-performance.test.mjs.

  test("get_chain_identity_history returns a schema-stable empty feed on cold D1", async () => {
    const res = await callTool("get_chain_identity_history", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.schema_version, 1);
    assert.equal(out.count, 0);
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.changes, []);
  });

  test("get_chain_identity_history summarizes recent changes across subnets", async () => {
    const identityDb = {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              all() {
                if (sql.includes("FROM subnet_identity_history")) {
                  assert.equal(params[params.length - 1], 2); // clamped limit bound
                  return Promise.resolve({
                    results: [
                      {
                        id: 2,
                        netuid: 12,
                        block_number: 200,
                        observed_at: 1_700_000_000_000,
                        subnet_name: "Beta",
                        symbol: "β",
                        description: null,
                        github_repo: null,
                        subnet_url: null,
                        discord: null,
                        logo_url: null,
                        identity_hash: "h2",
                      },
                      {
                        id: 1,
                        netuid: 7,
                        block_number: 100,
                        observed_at: 1_600_000_000_000,
                        subnet_name: "Alpha",
                        symbol: "α",
                        description: null,
                        github_repo: null,
                        subnet_url: null,
                        discord: null,
                        logo_url: null,
                        identity_hash: "h1",
                      },
                    ],
                  });
                }
                return Promise.resolve({ results: [] });
              },
            };
          },
        };
      },
    };
    const res = await callTool(
      "get_chain_identity_history",
      { limit: 2 },
      { env: { METAGRAPH_HEALTH_DB: identityDb } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.count, 2);
    assert.equal(out.subnet_count, 2); // spans netuids 12 and 7
    assert.equal(out.changes[0].netuid, 12);
    assert.equal(out.changes[0].subnet_name, "Beta");
    assert.equal(out.changes[1].netuid, 7);
  });

  // #4832 gap-closure: get_chain_identity_history mirrors REST's
  // handleChainIdentityHistory tier-selection exactly (same
  // METAGRAPH_SUBNET_IDENTITY_SOURCE flag, same tryPostgresTier fallback
  // contract) -- see the equivalent "flag=postgres" tests for
  // handleSubnetIdentityHistory in tests/request-handlers-entities.test.mjs.
  describe("get_chain_identity_history D1 -> Postgres serving cutover", () => {
    function identityHistoryD1(rows, capture = []) {
      return {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  if (sql.includes("FROM subnet_identity_history")) {
                    return Promise.resolve({ results: rows });
                  }
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      };
    }
    const ALPHA_ROW = {
      id: 1,
      netuid: 7,
      block_number: 100,
      observed_at: 1_600_000_000_000,
      subnet_name: "Alpha",
      symbol: "α",
      description: null,
      github_repo: null,
      subnet_url: null,
      discord: null,
      logo_url: null,
      identity_hash: "h1",
    };

    test("flag=postgres uses Postgres data, D1 never queried", async () => {
      const capture = [];
      const env = {
        METAGRAPH_HEALTH_DB: identityHistoryD1([], capture),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              count: 1,
              subnet_count: 1,
              changes: [{ netuid: 99, subnet_name: "pg-only" }],
            }),
        },
      };
      const res = await callTool("get_chain_identity_history", {}, { env });
      const out = res.body.result.structuredContent;
      assert.equal(out.changes[0].subnet_name, "pg-only");
      assert.deepEqual(capture, []);
    });

    test("flag=postgres falls back to D1 on failure", async () => {
      const capture = [];
      const env = {
        METAGRAPH_HEALTH_DB: identityHistoryD1([ALPHA_ROW], capture),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool("get_chain_identity_history", {}, { env });
      const out = res.body.result.structuredContent;
      assert.equal(out.changes[0].subnet_name, "Alpha");
      assert.ok(capture.length > 0, "D1 must actually be queried on fallback");
    });

    test("flag absent uses D1 even when DATA_API is bound (zero regression, unflipped)", async () => {
      const capture = [];
      const env = {
        METAGRAPH_HEALTH_DB: identityHistoryD1([ALPHA_ROW], capture),
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              count: 0,
              subnet_count: 0,
              changes: [],
            }),
        },
      };
      const res = await callTool("get_chain_identity_history", {}, { env });
      const out = res.body.result.structuredContent;
      assert.equal(out.changes[0].subnet_name, "Alpha");
      assert.ok(capture.length > 0, "D1 must actually be queried");
    });

    test("flag=postgres forwards limit as a REST-equivalent query param", async () => {
      let seenUrl;
      const env = {
        METAGRAPH_HEALTH_DB: identityHistoryD1([]),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async (request) => {
            seenUrl = new URL(request.url);
            return Response.json({
              schema_version: 1,
              count: 0,
              subnet_count: 0,
              changes: [],
            });
          },
        },
      };
      await callTool("get_chain_identity_history", { limit: 25 }, { env });
      assert.equal(seenUrl.pathname, "/api/v1/chain/identity-history");
      assert.equal(seenUrl.searchParams.get("limit"), "25");
    });

    test("flag=postgres omits the limit param when not supplied", async () => {
      let seenUrl;
      const env = {
        METAGRAPH_HEALTH_DB: identityHistoryD1([]),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async (request) => {
            seenUrl = new URL(request.url);
            return Response.json({
              schema_version: 1,
              count: 0,
              subnet_count: 0,
              changes: [],
            });
          },
        },
      };
      await callTool("get_chain_identity_history", {}, { env });
      assert.equal(seenUrl.pathname, "/api/v1/chain/identity-history");
      assert.equal(seenUrl.searchParams.has("limit"), false);
    });
  });

  test("get_chain_yield returns schema-stable null blocks on cold D1", async () => {
    const res = await callTool("get_chain_yield", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.network_yield, null);
    assert.equal(out.validator_yield, null);
    assert.equal(out.distribution, null);
  });

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_chain_yield always returns the schema-stable
  // null-block card (buildChainYield([])) -- covered by "returns schema-stable
  // null blocks on cold D1" above; return/distribution row-shaping is still
  // covered directly against the pure builder in tests/chain-yield.test.mjs.

  test("get_blocks_summary returns a schema-stable zeroed card on cold D1", async () => {
    const res = await callTool("get_blocks_summary", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.block_count, 0);
    assert.equal(out.block_time, null);
    assert.equal(out.throughput, null);
    assert.equal(out.author_concentration, null);
  });

  // blocks' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_blocks_summary always returns the schema-stable
  // zeroed card (buildBlocksSummary([])) -- covered by "returns a
  // schema-stable zeroed card on cold D1" above; block-production row-shaping
  // is still covered directly against the pure builder in
  // tests/blocks-summary.test.mjs.

  // A validator-permit neuron_daily row for one boundary snapshot; keeps the
  // turnover fixtures compact so the churn arithmetic under test stays legible.
  function turnoverRow(snapshot_date, netuid, hotkey) {
    return { snapshot_date, netuid, hotkey, validator_permit: 1 };
  }

  // A metagraphD1 env wired for the chain-turnover boundary reads: the MIN/MAX
  // bounds row plus the two-snapshot validator rows the loader reads.
  function chainTurnoverEnv(
    rows,
    { start = "2026-06-01", end = "2026-06-30" } = {},
  ) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          turnoverBounds: [{ start_date: start, end_date: end }],
          turnoverRows: rows,
        }),
      },
    };
  }

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped in
  // production, so get_chain_turnover always returns the schema-stable empty
  // scorecard (buildChainTurnover([], {window, startDate:null, endDate:null,
  // limit})) -- churn-ranking row-shaping is still covered directly against
  // the pure builder in tests/chain-turnover.test.mjs; this only proves the
  // window/limit args are still accepted and echoed with an empty rollup.
  test("get_chain_turnover returns schema-stable empty on cold D1", async () => {
    const res = await callTool("get_chain_turnover", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "30d"); // REST default window parity
    assert.equal(out.comparable, false);
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.stability_distribution, null);
    assert.equal(out.network.validators_start, 0);
  });

  test("get_chain_turnover rejects an unsupported window", async () => {
    const res = await callTool("get_chain_turnover", { window: "1y" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_turnover echoes a custom window and limit with an empty rollup", async () => {
    const res = await callTool("get_chain_turnover", {
      window: "7d",
      limit: 1,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
  });

  test("get_chain_turnover payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_turnover",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_turnover",
      {},
      chainTurnoverEnv([
        turnoverRow("2026-06-01", 1, "V1"),
        turnoverRow("2026-06-30", 1, "V2"),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // A grouped account_events aggregate row (one per netuid+event_kind), the
  // shape loadChainStakeFlow's SUM/COUNT/MAX query returns.
  function stakeFlowRow(netuid, event_kind, total_tao, event_count) {
    return {
      netuid,
      event_kind,
      total_tao,
      event_count,
      last_observed: 1_750_000_000_000,
    };
  }

  function chainStakeFlowEnv(rows) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({ accountEvents: rows }),
      },
    };
  }

  test("get_chain_stake_flow returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_stake_flow", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.net_flow_distribution, null);
    assert.equal(out.network.net_flow_tao, 0);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_stake_flow ranks subnets by net flow with a network rollup", async () => {
    const res = await callTool(
      "get_chain_stake_flow",
      { window: "30d", limit: 10 },
      chainStakeFlowEnv([
        // netuid 1: net +80 (inflow, biggest) -> ranks first.
        stakeFlowRow(1, "StakeAdded", 100, 5),
        stakeFlowRow(1, "StakeRemoved", 20, 2),
        // netuid 2: net -30 (outflow) -> ranks last.
        stakeFlowRow(2, "StakeAdded", 10, 1),
        stakeFlowRow(2, "StakeRemoved", 40, 3),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].net_flow_tao, 80);
    assert.equal(out.subnets[0].direction, "inflow");
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].direction, "outflow");
    // Network rollup: staked 110, unstaked 60 -> net +50; 1 gaining, 1 losing.
    assert.equal(out.network.net_flow_tao, 50);
    assert.equal(out.network.gaining, 1);
    assert.equal(out.network.losing, 1);
    assert.equal(out.net_flow_distribution.count, 2);
  });

  test("get_chain_stake_flow rejects an unsupported window", async () => {
    const res = await callTool("get_chain_stake_flow", { window: "90d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_stake_flow caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_stake_flow",
      { limit: 1 },
      chainStakeFlowEnv([
        stakeFlowRow(1, "StakeAdded", 100, 5),
        stakeFlowRow(2, "StakeAdded", 50, 3),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets are counted in the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.net_flow_distribution.count, 2);
  });

  test("get_chain_stake_flow payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_stake_flow",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_stake_flow",
      {},
      chainStakeFlowEnv([
        stakeFlowRow(1, "StakeAdded", 100, 5),
        stakeFlowRow(1, "StakeRemoved", 20, 2),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // One GROUP BY netuid, event_kind row from account_events, the shape
  // loadChainAlphaVolume's SUM/COUNT/MAX query returns.
  function alphaVolumeRow(
    netuid,
    event_kind,
    alpha_volume,
    tao_volume,
    event_count,
  ) {
    return {
      netuid,
      event_kind,
      alpha_volume,
      tao_volume,
      event_count,
      last_observed: 1_750_000_000_000,
    };
  }

  function chainAlphaVolumeEnv(rows) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({ accountEvents: rows }),
      },
    };
  }

  test("get_chain_alpha_volume returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_alpha_volume", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "24h");
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.volume_distribution, null);
    assert.equal(out.network.total_volume_tao, 0);
    assert.equal(out.network.sentiment, "neutral");
    assert.equal(out.observed_at, null);
  });

  test("get_chain_alpha_volume ranks subnets by total volume with a network rollup", async () => {
    const res = await callTool(
      "get_chain_alpha_volume",
      { limit: 10 },
      chainAlphaVolumeEnv([
        // netuid 1: total 130 (biggest) -> ranks first.
        alphaVolumeRow(1, "StakeAdded", 100, 100, 5),
        alphaVolumeRow(1, "StakeRemoved", 30, 30, 2),
        // netuid 2: total 100 -> ranks second.
        alphaVolumeRow(2, "StakeAdded", 20, 20, 1),
        alphaVolumeRow(2, "StakeRemoved", 80, 80, 3),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "24h");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].total_volume_tao, 130);
    assert.equal(out.subnets[0].sentiment, "bullish");
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].sentiment, "bearish");
    // Network rollup: buy 120, sell 110 -> net +10, total 230.
    assert.equal(out.network.buy_volume_tao, 120);
    assert.equal(out.network.sell_volume_tao, 110);
    assert.equal(out.network.total_volume_tao, 230);
    assert.equal(out.volume_distribution.count, 2);
  });

  test("get_chain_alpha_volume rejects a window arg (no window param on this tool)", async () => {
    // Unlike get_chain_stake_flow, this tool has no window enum: the fixed 24h
    // window is not a parameter, so `additionalProperties: false` on its
    // inputSchema rejects a `window` arg outright (validateToolArguments),
    // rather than silently accepting and ignoring it.
    const res = await callTool("get_chain_alpha_volume", { window: "7d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("get_chain_alpha_volume caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_alpha_volume",
      { limit: 1 },
      chainAlphaVolumeEnv([
        alphaVolumeRow(1, "StakeAdded", 100, 100, 5),
        alphaVolumeRow(2, "StakeAdded", 50, 50, 3),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets are counted in the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.volume_distribution.count, 2);
  });

  test("get_chain_alpha_volume payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_alpha_volume",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_alpha_volume",
      {},
      chainAlphaVolumeEnv([
        alphaVolumeRow(1, "StakeAdded", 100, 100, 5),
        alphaVolumeRow(1, "StakeRemoved", 20, 20, 2),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainWeights reads first (its COUNT/
  // COUNT(DISTINCT)/MAX(observed_at) probe); a non-null newest_observed unlocks
  // the per-subnet read.
  function weightsNetwork(weight_sets, distinct_setters) {
    return {
      weight_sets,
      distinct_setters,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT weight_sets + distinct setters).
  function weightsRow(netuid, weight_sets, distinct_setters) {
    return { netuid, weight_sets, distinct_setters };
  }

  function chainWeightsEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          weightsNetworkRows: network ? [network] : [],
          weightsSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_weights returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_weights", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.weight_sets, 0);
    assert.equal(out.network.sets_per_setter, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_weights ranks subnets by weight sets with a network rollup", async () => {
    const res = await callTool(
      "get_chain_weights",
      { window: "30d", limit: 10 },
      chainWeightsEnv(weightsNetwork(30, 8), [
        // netuid 2: fewer sets -> ranks last despite higher intensity.
        weightsRow(2, 10, 4),
        // netuid 1: most WeightsSet events -> ranks first.
        weightsRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].weight_sets, 20);
    assert.equal(out.subnets[0].sets_per_setter, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].sets_per_setter, 2.5); // 10 / 4
    // Network rollup: total sets 30 over 8 distinct setters -> 3.75.
    assert.equal(out.network.weight_sets, 30);
    assert.equal(out.network.distinct_setters, 8);
    assert.equal(out.network.sets_per_setter, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_weights rejects an unsupported window", async () => {
    const res = await callTool("get_chain_weights", { window: "90d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_weights caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_weights",
      { limit: 1 },
      chainWeightsEnv(weightsNetwork(30, 8), [
        weightsRow(1, 20, 5),
        weightsRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_weights payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_weights",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_weights",
      {},
      chainWeightsEnv(weightsNetwork(30, 8), [
        weightsRow(1, 20, 5),
        weightsRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function chainWeightSettersD1(
    { leaderboardRows = [], totalsRow = null } = {},
    capture = [],
  ) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: {
          prepare(sql) {
            return {
              bind(...params) {
                capture.push({ sql, params });
                return {
                  async all() {
                    if (/GROUP BY/.test(sql)) {
                      return { results: leaderboardRows };
                    }
                    return { results: totalsRow ? [totalsRow] : [] };
                  },
                };
              },
            };
          },
        },
      },
    };
  }

  test("get_chain_weight_setters ranks setters with network-wide shares", async () => {
    const res = await callTool(
      "get_chain_weight_setters",
      { window: "7d", limit: 10 },
      chainWeightSettersD1({
        leaderboardRows: [
          {
            hotkey: "5Val1",
            uid: 3,
            weight_sets: 6,
            first_set: 1_717_000_000_000,
            last_set: 1_717_500_000_000,
          },
          {
            hotkey: "5Val2",
            uid: 7,
            weight_sets: 4,
            first_set: 1_717_100_000_000,
            last_set: 1_717_400_000_000,
          },
        ],
        totalsRow: {
          weight_sets: 10,
          distinct_setters: 2,
          newest_observed: 1_717_500_000_000,
        },
      }),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.weight_sets, 10);
    assert.equal(out.distinct_setters, 2);
    assert.equal(out.setter_count, 2);
    assert.equal(out.setters[0].hotkey, "5Val1");
    assert.equal(out.setters[0].share, 0.6);
  });

  test("get_chain_weight_setters returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_weight_setters", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.weight_sets, 0);
    assert.equal(out.distinct_setters, 0);
    assert.equal(out.setter_count, 0);
    assert.deepEqual(out.setters, []);
  });

  test("get_chain_weight_setters rejects an unsupported window", async () => {
    const res = await callTool("get_chain_weight_setters", { window: "90d" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window must be one of/);
  });

  test("get_chain_weight_setters caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_weight_setters",
      { limit: 1 },
      chainWeightSettersD1({
        leaderboardRows: [
          { hotkey: "5Val1", uid: 3, weight_sets: 6 },
          { hotkey: "5Val2", uid: 7, weight_sets: 4 },
        ],
        totalsRow: {
          weight_sets: 10,
          distinct_setters: 2,
          newest_observed: 1_717_500_000_000,
        },
      }),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.distinct_setters, 2);
    assert.equal(out.setter_count, 1);
    assert.equal(out.setters.length, 1);
  });

  test("get_chain_weight_setters payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_weight_setters",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_weight_setters",
      {},
      chainWeightSettersD1({
        leaderboardRows: [{ hotkey: "5Val1", uid: 3, weight_sets: 6 }],
        totalsRow: {
          weight_sets: 6,
          distinct_setters: 1,
          newest_observed: 1_717_500_000_000,
        },
      }),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainStakeMoves reads first (its
  // COUNT(DISTINCT coldkey)/MAX(observed_at) probe); a non-null newest_observed
  // unlocks the per-subnet read.
  function stakeMovesNetwork(distinct_movers) {
    return {
      distinct_movers,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT movements + distinct movers).
  function stakeMovesRow(netuid, movements, distinct_movers) {
    return { netuid, movements, distinct_movers };
  }

  function chainStakeMovesEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          stakeMovesNetworkRows: network ? [network] : [],
          stakeMovesSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_stake_moves returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_stake_moves", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.movements, 0);
    assert.equal(out.network.movements_per_mover, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_stake_moves ranks subnets by movements with a network rollup", async () => {
    const res = await callTool(
      "get_chain_stake_moves",
      { window: "30d", limit: 10 },
      chainStakeMovesEnv(stakeMovesNetwork(8), [
        // netuid 2: fewer movements -> ranks last despite higher intensity.
        stakeMovesRow(2, 10, 4),
        // netuid 1: most StakeMoved events -> ranks first.
        stakeMovesRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].movements, 20);
    assert.equal(out.subnets[0].movements_per_mover, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].movements_per_mover, 2.5); // 10 / 4
    // Network rollup: total movements 30 over 8 distinct movers -> 3.75.
    assert.equal(out.network.movements, 30);
    assert.equal(out.network.distinct_movers, 8);
    assert.equal(out.network.movements_per_mover, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_stake_moves rejects an unsupported window", async () => {
    const res = await callTool("get_chain_stake_moves", { window: "90d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_stake_moves caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_stake_moves",
      { limit: 1 },
      chainStakeMovesEnv(stakeMovesNetwork(8), [
        stakeMovesRow(1, 20, 5),
        stakeMovesRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_stake_moves payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_stake_moves",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_stake_moves",
      {},
      chainStakeMovesEnv(stakeMovesNetwork(8), [
        stakeMovesRow(1, 20, 5),
        stakeMovesRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainStakeTransfers reads first (its
  // COUNT(DISTINCT coldkey)/MAX(observed_at) probe); a non-null newest_observed
  // unlocks the per-subnet read.
  function stakeTransfersNetwork(distinct_senders) {
    return {
      distinct_senders,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT transfers + distinct senders).
  function stakeTransfersRow(netuid, transfers, distinct_senders) {
    return { netuid, transfers, distinct_senders };
  }

  function chainStakeTransfersEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          stakeTransfersNetworkRows: network ? [network] : [],
          stakeTransfersSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_stake_transfers returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_stake_transfers", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.transfers, 0);
    assert.equal(out.network.transfers_per_sender, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_stake_transfers ranks subnets by transfers with a network rollup", async () => {
    const res = await callTool(
      "get_chain_stake_transfers",
      { window: "30d", limit: 10 },
      chainStakeTransfersEnv(stakeTransfersNetwork(8), [
        // netuid 2: fewer transfers -> ranks last despite higher intensity.
        stakeTransfersRow(2, 10, 4),
        // netuid 1: most StakeTransferred events -> ranks first.
        stakeTransfersRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].transfers, 20);
    assert.equal(out.subnets[0].transfers_per_sender, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].transfers_per_sender, 2.5); // 10 / 4
    // Network rollup: total transfers 30 over 8 distinct senders -> 3.75.
    assert.equal(out.network.transfers, 30);
    assert.equal(out.network.distinct_senders, 8);
    assert.equal(out.network.transfers_per_sender, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_stake_transfers rejects an unsupported window", async () => {
    const res = await callTool(
      "get_chain_stake_transfers",
      { window: "90d" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_stake_transfers caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_stake_transfers",
      { limit: 1 },
      chainStakeTransfersEnv(stakeTransfersNetwork(8), [
        stakeTransfersRow(1, 20, 5),
        stakeTransfersRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_stake_transfers payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_stake_transfers",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_stake_transfers",
      {},
      chainStakeTransfersEnv(stakeTransfersNetwork(8), [
        stakeTransfersRow(1, 20, 5),
        stakeTransfersRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainAxonRemovals reads first (its
  // COUNT(DISTINCT hotkey)/MAX(observed_at) probe); a non-null newest_observed
  // unlocks the per-subnet read.
  function axonRemovalsNetwork(distinct_removers) {
    return {
      distinct_removers,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT removals + distinct removers).
  function axonRemovalsRow(netuid, removals, distinct_removers) {
    return { netuid, removals, distinct_removers };
  }

  function chainAxonRemovalsEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          axonRemovalsNetworkRows: network ? [network] : [],
          axonRemovalsSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_axon_removals returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_axon_removals", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.removals, 0);
    assert.equal(out.network.removals_per_remover, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_axon_removals ranks subnets by removals with a network rollup", async () => {
    const res = await callTool(
      "get_chain_axon_removals",
      { window: "30d", limit: 10 },
      chainAxonRemovalsEnv(axonRemovalsNetwork(8), [
        // netuid 2: fewer removals -> ranks last despite higher intensity.
        axonRemovalsRow(2, 10, 4),
        // netuid 1: most AxonInfoRemoved events -> ranks first.
        axonRemovalsRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].removals, 20);
    assert.equal(out.subnets[0].removals_per_remover, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].removals_per_remover, 2.5); // 10 / 4
    // Network rollup: total removals 30 over 8 distinct removers -> 3.75.
    assert.equal(out.network.removals, 30);
    assert.equal(out.network.distinct_removers, 8);
    assert.equal(out.network.removals_per_remover, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_axon_removals rejects an unsupported window", async () => {
    const res = await callTool(
      "get_chain_axon_removals",
      { window: "90d" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_axon_removals caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_axon_removals",
      { limit: 1 },
      chainAxonRemovalsEnv(axonRemovalsNetwork(8), [
        axonRemovalsRow(1, 20, 5),
        axonRemovalsRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_axon_removals payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_axon_removals",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_axon_removals",
      {},
      chainAxonRemovalsEnv(axonRemovalsNetwork(8), [
        axonRemovalsRow(1, 20, 5),
        axonRemovalsRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainDeregistrations reads first (its
  // COUNT(DISTINCT hotkey)/MAX(observed_at) probe); a non-null newest_observed
  // unlocks the per-subnet read.
  function chainDeregistrationsNetwork(distinct_deregistered_hotkeys) {
    return {
      distinct_deregistered_hotkeys,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT deregistrations + distinct hotkeys).
  function chainDeregistrationsRow(
    netuid,
    deregistrations,
    distinct_deregistered_hotkeys,
  ) {
    return { netuid, deregistrations, distinct_deregistered_hotkeys };
  }

  function chainDeregistrationsEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          chainDeregistrationsNetworkRows: network ? [network] : [],
          chainDeregistrationsSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_deregistrations returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_deregistrations", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.deregistrations, 0);
    assert.equal(out.network.deregistrations_per_hotkey, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_deregistrations ranks subnets by deregistrations with a network rollup", async () => {
    const res = await callTool(
      "get_chain_deregistrations",
      { window: "30d", limit: 10 },
      chainDeregistrationsEnv(chainDeregistrationsNetwork(8), [
        // netuid 2: fewer deregistrations -> ranks last despite higher intensity.
        chainDeregistrationsRow(2, 10, 4),
        // netuid 1: most NeuronDeregistered events -> ranks first.
        chainDeregistrationsRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].deregistrations, 20);
    assert.equal(out.subnets[0].deregistrations_per_hotkey, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].deregistrations_per_hotkey, 2.5); // 10 / 4
    // Network rollup: total deregistrations 30 over 8 distinct hotkeys -> 3.75.
    assert.equal(out.network.deregistrations, 30);
    assert.equal(out.network.distinct_deregistered_hotkeys, 8);
    assert.equal(out.network.deregistrations_per_hotkey, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_deregistrations rejects an unsupported window", async () => {
    const res = await callTool(
      "get_chain_deregistrations",
      { window: "90d" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_deregistrations caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_deregistrations",
      { limit: 1 },
      chainDeregistrationsEnv(chainDeregistrationsNetwork(8), [
        chainDeregistrationsRow(1, 20, 5),
        chainDeregistrationsRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_deregistrations payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_deregistrations",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_deregistrations",
      {},
      chainDeregistrationsEnv(chainDeregistrationsNetwork(8), [
        chainDeregistrationsRow(1, 20, 5),
        chainDeregistrationsRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainServing reads first (its
  // COUNT(DISTINCT hotkey)/MAX(observed_at) probe); a non-null newest_observed
  // unlocks the per-subnet read.
  function chainServingNetwork(distinct_servers) {
    return {
      distinct_servers,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT announcements + distinct servers).
  function chainServingRow(netuid, announcements, distinct_servers) {
    return { netuid, announcements, distinct_servers };
  }

  function chainServingEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          chainServingNetworkRows: network ? [network] : [],
          chainServingSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_serving returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_serving", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.announcements, 0);
    assert.equal(out.network.announcements_per_server, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_serving ranks subnets by announcements with a network rollup", async () => {
    const res = await callTool(
      "get_chain_serving",
      { window: "30d", limit: 10 },
      chainServingEnv(chainServingNetwork(8), [
        // netuid 2: fewer announcements -> ranks last despite higher intensity.
        chainServingRow(2, 10, 4),
        // netuid 1: most AxonServed events -> ranks first.
        chainServingRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].announcements, 20);
    assert.equal(out.subnets[0].announcements_per_server, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].announcements_per_server, 2.5); // 10 / 4
    // Network rollup: total announcements 30 over 8 distinct servers -> 3.75.
    assert.equal(out.network.announcements, 30);
    assert.equal(out.network.distinct_servers, 8);
    assert.equal(out.network.announcements_per_server, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_serving rejects an unsupported window", async () => {
    const res = await callTool("get_chain_serving", { window: "90d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_serving caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_serving",
      { limit: 1 },
      chainServingEnv(chainServingNetwork(8), [
        chainServingRow(1, 20, 5),
        chainServingRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_serving payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_serving",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_serving",
      {},
      chainServingEnv(chainServingNetwork(8), [
        chainServingRow(1, 20, 5),
        chainServingRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The network-wide aggregate row loadChainPrometheus reads first (its
  // COUNT(DISTINCT hotkey)/MAX(observed_at) probe); a non-null newest_observed
  // unlocks the per-subnet read.
  function chainPrometheusNetwork(distinct_exporters) {
    return {
      distinct_exporters,
      newest_observed: 1_750_000_000_000,
    };
  }

  // A per-subnet GROUP BY netuid row (COUNT announcements + distinct exporters).
  function chainPrometheusRow(netuid, announcements, distinct_exporters) {
    return { netuid, announcements, distinct_exporters };
  }

  function chainPrometheusEnv(network, subnets) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          chainPrometheusNetworkRows: network ? [network] : [],
          chainPrometheusSubnetRows: subnets,
        }),
      },
    };
  }

  test("get_chain_prometheus returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_prometheus", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.intensity_distribution, null);
    assert.equal(out.network.announcements, 0);
    assert.equal(out.network.announcements_per_exporter, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_prometheus ranks subnets by announcements with a network rollup", async () => {
    const res = await callTool(
      "get_chain_prometheus",
      { window: "30d", limit: 10 },
      chainPrometheusEnv(chainPrometheusNetwork(8), [
        // netuid 2: fewer announcements -> ranks last despite higher intensity.
        chainPrometheusRow(2, 10, 4),
        // netuid 1: most PrometheusServed events -> ranks first.
        chainPrometheusRow(1, 20, 5),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets[0].netuid, 1);
    assert.equal(out.subnets[0].announcements, 20);
    assert.equal(out.subnets[0].announcements_per_exporter, 4); // 20 / 5
    assert.equal(out.subnets[1].netuid, 2);
    assert.equal(out.subnets[1].announcements_per_exporter, 2.5); // 10 / 4
    // Network rollup: total announcements 30 over 8 distinct exporters -> 3.75.
    assert.equal(out.network.announcements, 30);
    assert.equal(out.network.distinct_exporters, 8);
    assert.equal(out.network.announcements_per_exporter, 3.75);
    assert.equal(out.intensity_distribution.count, 2);
    assert.equal(out.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("get_chain_prometheus rejects an unsupported window", async () => {
    const res = await callTool("get_chain_prometheus", { window: "90d" }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_prometheus caps the leaderboard by limit", async () => {
    const res = await callTool(
      "get_chain_prometheus",
      { limit: 1 },
      chainPrometheusEnv(chainPrometheusNetwork(8), [
        chainPrometheusRow(1, 20, 5),
        chainPrometheusRow(2, 10, 4),
      ]),
    );
    const out = res.body.result.structuredContent;
    // Both subnets feed the rollup/distribution, but the page is capped.
    assert.equal(out.subnet_count, 2);
    assert.equal(out.subnets.length, 1);
    assert.equal(out.intensity_distribution.count, 2);
  });

  test("get_chain_prometheus payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_prometheus",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_prometheus",
      {},
      chainPrometheusEnv(chainPrometheusNetwork(8), [
        chainPrometheusRow(1, 20, 5),
        chainPrometheusRow(2, 10, 4),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // The full-window totals row loadChainTransferPairs reads first (its pair_totals
  // CTE rollup carrying top_pair_volume_tao).
  function transferPairTotals(
    total_volume_tao,
    transfer_count,
    unique_pairs,
    top,
  ) {
    return {
      total_volume_tao,
      transfer_count,
      unique_pairs,
      top_pair_volume_tao: top,
    };
  }

  // A per-corridor row (hotkey AS from_address, coldkey AS to_address).
  function transferPairRow(
    from_address,
    to_address,
    volume_tao,
    transfer_count,
  ) {
    return {
      from_address,
      to_address,
      volume_tao,
      transfer_count,
      last_block: 5_000_000,
      last_observed_at: 1_750_000_000_000,
    };
  }

  function chainTransferPairsEnv(totals, pairs) {
    return {
      env: {
        METAGRAPH_HEALTH_DB: metagraphD1({
          transferPairTotals: totals ? [totals] : [],
          transferPairRows: pairs,
        }),
      },
    };
  }

  test("get_chain_transfer_pairs returns schema-stable zeros on cold D1", async () => {
    const res = await callTool("get_chain_transfer_pairs", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d"); // REST default window parity
    assert.equal(out.sort, "volume"); // REST default sort parity
    assert.equal(out.pair_count, 0);
    assert.deepEqual(out.pairs, []);
    assert.equal(out.total_volume_tao, 0);
    assert.equal(out.top_pair_share, null);
    assert.equal(out.observed_at, null);
  });

  test("get_chain_transfer_pairs ranks corridors with a network rollup", async () => {
    const res = await callTool(
      "get_chain_transfer_pairs",
      { window: "30d", limit: 10 },
      chainTransferPairsEnv(transferPairTotals(250, 30, 3, 150), [
        transferPairRow("A", "B", 150, 10),
        transferPairRow("C", "D", 100, 20),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "30d");
    assert.equal(out.pair_count, 2);
    assert.equal(out.pairs[0].from, "A");
    assert.equal(out.pairs[0].to, "B");
    assert.equal(out.pairs[0].volume_tao, 150);
    assert.equal(out.total_volume_tao, 250);
    assert.equal(out.unique_pairs, 3);
    assert.equal(out.transfer_count, 30);
    assert.equal(out.top_pair_share, 0.6); // 150 / 250
  });

  test("get_chain_transfer_pairs drops self-transfers and honors the sort argument", async () => {
    const res = await callTool(
      "get_chain_transfer_pairs",
      { sort: "count" },
      chainTransferPairsEnv(transferPairTotals(250, 30, 2, 150), [
        // Self-transfer (from === to) must be filtered out.
        transferPairRow("Z", "Z", 999, 99),
        transferPairRow("C", "D", 100, 20),
      ]),
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.sort, "count");
    assert.equal(out.pair_count, 1);
    assert.equal(out.pairs[0].from, "C");
  });

  test("get_chain_transfer_pairs rejects an unsupported window", async () => {
    const res = await callTool(
      "get_chain_transfer_pairs",
      { window: "90d" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  test("get_chain_transfer_pairs rejects an unsupported sort", async () => {
    const res = await callTool(
      "get_chain_transfer_pairs",
      { sort: "recency" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /sort/);
  });

  test("get_chain_transfer_pairs payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_chain_transfer_pairs",
    )?.outputSchema;
    const res = await callTool(
      "get_chain_transfer_pairs",
      {},
      chainTransferPairsEnv(transferPairTotals(250, 30, 3, 150), [
        transferPairRow("A", "B", 150, 10),
        transferPairRow("C", "D", 100, 20),
      ]),
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped
  // in production, so get_subnet_concentration_history always returns the
  // schema-stable empty series (buildConcentrationHistory([], netuid,
  // {window, capped:false})) -- per-day row-shaping is still covered directly
  // against the pure builder in tests/concentration.test.mjs; this only
  // proves the default window is still echoed with an empty series.
  test("get_subnet_concentration_history defaults to 30d with an empty series", async () => {
    const res = await callTool("get_subnet_concentration_history", {
      netuid: 7,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
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

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped
  // in production, so get_subnet_turnover always returns the schema-stable
  // comparable:false scorecard (buildTurnover([], netuid, {window,
  // startDate:null, endDate:null})) -- covered by "returns schema-stable
  // empty on cold D1" above; validator-churn row-shaping is still covered
  // directly against the pure builder in tests/turnover.test.mjs.

  test("get_subnet_turnover rejects an invalid window", async () => {
    const res = await callTool("get_subnet_turnover", {
      netuid: 7,
      window: "400d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /is not a supported window/);
  });

  test("get_subnet_turnover accepts the all window with an empty scorecard", async () => {
    const res = await callTool("get_subnet_turnover", {
      netuid: 9,
      window: "all",
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "all");
    assert.equal(out.comparable, false);
    assert.equal(out.validator_retention, null);
  });

  test("get_subnet_turnover omits changes detail unless changes=true", async () => {
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
                uid: 1,
                hotkey: "V2",
                validator_permit: 1,
              },
              {
                snapshot_date: "2026-06-30",
                uid: 1,
                hotkey: "V3",
                validator_permit: 1,
              },
            ],
          }),
        },
      },
    );
    assert.equal("changes" in res.body.result.structuredContent, false);
  });

  test("get_subnet_turnover with changes=true returns schema-stable empty detail on cold D1", async () => {
    const res = await callTool("get_subnet_turnover", {
      netuid: 7,
      changes: true,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.comparable, false);
    assert.deepEqual(out.changes.validators_entered, []);
    assert.deepEqual(out.changes.validators_exited, []);
    assert.deepEqual(out.changes.uid_reassignments, []);
  });

  // account_events/neuron_daily row-shaping for the changes=true detail
  // (entered/exited validators, UID reassignments) is covered directly
  // against the pure builders (buildTurnoverChanges/turnoverChangeDetail) in
  // tests/turnover.test.mjs -- see "with changes=true returns schema-stable
  // empty detail on cold D1" above for this tool's now-only-reachable path.

  test("get_subnet_turnover rejects a non-boolean changes flag", async () => {
    const res = await callTool("get_subnet_turnover", {
      netuid: 7,
      changes: "true",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /changes.*boolean/);
  });

  test("get_subnet_yield returns schema-stable empty on cold D1", async () => {
    const res = await callTool("get_subnet_yield", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.subnet_yield, null);
    assert.deepEqual(out.neurons, []);
  });

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_subnet_yield always returns the schema-stable empty
  // card (buildSubnetYield([], netuid)) -- covered by "returns schema-stable
  // empty on cold D1" above; per-UID yield row-shaping is still covered
  // directly against the pure builder in tests/subnet-yield.test.mjs.

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

  test("get_health_trends returns schema-stable empty windows on cold D1", async () => {
    const res = await callTool("get_health_trends", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.schema_version, 1);
    assert.equal(out.windows["7d"].subnet_count, 0);
    assert.deepEqual(out.windows["7d"].subnets, []);
    assert.equal(out.windows["30d"].subnet_count, 0);
    assert.deepEqual(out.windows["30d"].subnets, []);
  });

  test("get_network_health returns unknown when the live store is cold", async () => {
    const res = await callTool("get_network_health", {});
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.scope, "operational");
    assert.equal(out.health_source, "unavailable");
    assert.equal(out.global.surface_count, 0);
    assert.deepEqual(out.subnets, []);
  });

  test("get_network_health overlays the live KV rollup", async () => {
    const globalLiveKv = {
      generated_at: "2026-06-11T00:00:00.000Z",
      last_run_at: FRESH_RUN,
      health_source: "live-cron-prober",
      summary: {
        surface_count: 58,
        status_counts: { ok: 57, degraded: 1, failed: 0, unknown: 0 },
      },
      subnets: [{ netuid: 0, status: "ok", surface_count: 2, ok_count: 2 }],
    };
    const deps = makeDeps({}, { "health:current": globalLiveKv });
    const res = await callTool("get_network_health", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.health_source, "live-cron-prober");
    assert.equal(out.operational_observed_at, FRESH_RUN);
    assert.equal(out.global.surface_count, 58);
    assert.equal(out.subnets[0].netuid, 0);
  });

  test("get_network_health payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_network_health",
    )?.outputSchema;
    const globalLiveKv = {
      last_run_at: FRESH_RUN,
      summary: { surface_count: 1, status_counts: { ok: 1 } },
      subnets: [{ netuid: 0, status: "ok" }],
    };
    const deps = makeDeps({}, { "health:current": globalLiveKv });
    const res = await callTool("get_network_health", {}, { deps });
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_health_history serves a dated snapshot with list-query filters", async () => {
    const deps = makeDeps({
      [`/metagraph/health/history/${HEALTH_HISTORY_BLOB.date}.json`]:
        HEALTH_HISTORY_BLOB,
    });
    const res = await callTool(
      "get_health_history",
      {
        date: HEALTH_HISTORY_BLOB.date,
        netuid: 7,
        limit: 10,
      },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.date, HEALTH_HISTORY_BLOB.date);
    assert.equal(out.surfaces.length, 1);
    assert.equal(out.surfaces[0].netuid, 7);
  });

  test("get_health_history rejects malformed dates", async () => {
    const res = await callTool("get_health_history", { date: "June" });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /date must be a YYYY-MM-DD day/,
    );
  });

  test("get_health_history rejects invalid sort fields", async () => {
    const deps = makeDeps({
      [`/metagraph/health/history/${HEALTH_HISTORY_BLOB.date}.json`]:
        HEALTH_HISTORY_BLOB,
    });
    const res = await callTool(
      "get_health_history",
      { date: HEALTH_HISTORY_BLOB.date, sort: "not_a_field" },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("get_health_history surfaces not_found when the dated artifact is absent", async () => {
    const res = await callTool("get_health_history", {
      date: HEALTH_HISTORY_BLOB.date,
    });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /No resource at the requested identifier/,
    );
  });

  test("get_health_history maps loader not_found when artifact data is empty", async () => {
    const path = `/metagraph/health/history/${HEALTH_HISTORY_BLOB.date}.json`;
    const deps = {
      ...makeDeps(),
      readArtifact(_env, artifactPath) {
        if (artifactPath === path) {
          return Promise.resolve({ ok: true, data: null, source: "test" });
        }
        return makeDeps().readArtifact(_env, artifactPath);
      },
    };
    const res = await callTool(
      "get_health_history",
      { date: HEALTH_HISTORY_BLOB.date },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /No health-history snapshot/);
  });

  test("get_health_history callTool rethrows unexpected readArtifact failures", async () => {
    const deps = {
      ...makeDeps({
        [`/metagraph/health/history/${HEALTH_HISTORY_BLOB.date}.json`]:
          HEALTH_HISTORY_BLOB,
      }),
      readArtifact() {
        return Promise.reject(new Error("kaboom"));
      },
    };
    const res = await callTool(
      "get_health_history",
      { date: HEALTH_HISTORY_BLOB.date },
      { deps },
    );
    assert.equal(res.body.error?.message || res.body.result?.isError, true);
  });

  test("get_health_history handler rethrows unexpected loader failures", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_health_history");
    await assert.rejects(
      () =>
        tool.handler(
          { date: HEALTH_HISTORY_BLOB.date },
          {
            env: {},
            readArtifact: async () => {
              throw new Error("kaboom");
            },
          },
        ),
      /kaboom/,
    );
  });

  test("get_health_history handler maps healthHistoryMcp loader errors", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_health_history");
    const err = healthHistoryMcp.healthHistoryMcpError(
      "invalid_params",
      "bad filter",
    );
    const spy = vi
      .spyOn(healthHistoryMcp, "loadHealthHistory")
      .mockRejectedValue(err);
    try {
      await assert.rejects(
        () => tool.handler({ date: HEALTH_HISTORY_BLOB.date }, { env: {} }),
        (thrown) => {
          assert.equal(thrown.toolError, true);
          assert.equal(thrown.code, "invalid_params");
          assert.match(thrown.message, /bad filter/);
          return true;
        },
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("get_health_history payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_health_history",
    )?.outputSchema;
    const deps = makeDeps({
      [`/metagraph/health/history/${HEALTH_HISTORY_BLOB.date}.json`]:
        HEALTH_HISTORY_BLOB,
    });
    const res = await callTool(
      "get_health_history",
      { date: HEALTH_HISTORY_BLOB.date },
      { deps },
    );
    const validate = new Ajv2020().compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_health_trends aggregates bulk trend rows from D1", async () => {
    // loadBulkHealthTrends windows rows by `date >= now - Nd`, so a fixed seed
    // date must be pinned against a fixed `now` — otherwise the 2026-06-28 row
    // ages out of the 7d window once wall-clock time passes 2026-07-05 and the
    // test flakes. Freeze the clock like the sibling D1-window tests above.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    try {
      const env = {
        METAGRAPH_HEALTH_DB: {
          prepare(sql) {
            return {
              bind() {
                return {
                  async all() {
                    assert.match(sql, /FROM surface_uptime_daily/);
                    return {
                      results: [
                        {
                          netuid: 7,
                          date: "2026-06-28",
                          total: 20,
                          ok_count: 18,
                          avg_latency_ms: 42,
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
      const deps = makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } });
      const res = await callTool("get_health_trends", {}, { deps, env });
      const out = res.body.result.structuredContent;
      assert.equal(out.observed_at, FRESH_RUN);
      assert.equal(out.windows["7d"].subnet_count, 1);
      assert.equal(out.windows["7d"].subnets[0].netuid, 7);
      assert.equal(out.windows["7d"].subnets[0].samples, 20);
    } finally {
      vi.useRealTimers();
    }
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

  test("get_chain_calls rejects an over-long call_module", async () => {
    const res = await callTool(
      "get_chain_calls",
      { call_module: "x".repeat(101) },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /call_module/i);
  });

  test("get_chain_calls scopes grouped rows and totals by call_module", async () => {
    const captured = [];
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              captured.push({ sql, params });
              const rows = /GROUP BY call_module, call_function/.test(sql)
                ? [
                    {
                      call_module: "SubtensorModule",
                      call_function: "add_stake",
                      count: 50,
                    },
                  ]
                : /COUNT\(\*\) AS total/.test(sql)
                  ? [{ total: 80 }]
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
      {
        window: "7d",
        group_by: "module_function",
        call_module: "SubtensorModule",
        limit: 3,
      },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.group_by, "module_function");
    assert.equal(out.total_extrinsics, 80);
    assert.equal(out.calls[0].share, 0.625);
    const extrinsicsQueries = captured.filter((q) =>
      /FROM extrinsics/.test(q.sql),
    );
    assert.equal(extrinsicsQueries.length, 2);
    for (const q of extrinsicsQueries) {
      assert.match(q.sql, /AND call_module = \?/);
      assert.ok(q.params.includes("SubtensorModule"));
    }
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

  // compare_subnets doesn't fit the generic marker-passthrough Postgres-tier
  // contract used elsewhere: handleCompare has no single D1 route to
  // forward, so its health dimension synthesizes its own internal
  // /api/v1/internal/compare-health request (netuids only, no dimensions --
  // structure/economics never touch D1/Postgres, they're registry+
  // economics-tier reads) and only when the health dimension is requested.
  // The DATA_API response also isn't returned verbatim: composeCompareData
  // folds it down to surface_count/ok_count/avg_latency_ms per netuid, so
  // there's no top-level `marker` field to assert on -- same two-test
  // contract as the shared CASES loops, adapted to that shape.
  test("compare_subnets: health dimension flag=postgres uses Postgres data at the internal REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            rows: [
              { netuid: 7, surface_count: 9, ok_count: 8, avg_latency_ms: 55 },
            ],
          });
        },
      },
    };
    const res = await callTool(
      "compare_subnets",
      { netuids: [7], dimensions: ["health"] },
      { deps: liveAnalyticsDeps, env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(captured, "/api/v1/internal/compare-health?netuids=7");
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.subnets[0].health, {
      surface_count: 9,
      ok_count: 8,
      avg_latency_ms: 55,
    });
  });

  test("compare_subnets: health+economics dimensions flag=postgres still includes economicsRows", async () => {
    let captured;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            rows: [
              { netuid: 7, surface_count: 9, ok_count: 8, avg_latency_ms: 55 },
            ],
          });
        },
      },
    };
    const res = await callTool(
      "compare_subnets",
      { netuids: [7], dimensions: ["health", "economics"] },
      { deps: liveAnalyticsDeps, env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(captured, "/api/v1/internal/compare-health?netuids=7");
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.subnets[0].health, {
      surface_count: 9,
      ok_count: 8,
      avg_latency_ms: 55,
    });
    assert.ok(out.subnets[0].economics);
  });

  test("compare_subnets: health dimension flag=postgres falls back to D1 on DATA_API failure", async () => {
    const env = {
      ...d1Env,
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "compare_subnets",
      { netuids: [7], dimensions: ["health"] },
      { deps: liveAnalyticsDeps, env },
    );
    assert.equal(res.body.result.isError, false);
    const out = res.body.result.structuredContent;
    // Same surfaceStatus fixture d1Env's METAGRAPH_HEALTH_DB serves the
    // existing "composes health-only dimensions" test above.
    assert.deepEqual(out.subnets[0].health, {
      surface_count: 3,
      ok_count: 2,
      avg_latency_ms: 120,
    });
  });

  test("compare_subnets: non-health dimensions never attempt Postgres even when flag=postgres", async () => {
    let dataApiCalled = false;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          dataApiCalled = true;
          return Response.json({ rows: [] });
        },
      },
    };
    const res = await callTool(
      "compare_subnets",
      { netuids: [7], dimensions: ["structure"] },
      { deps: liveAnalyticsDeps, env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(dataApiCalled, false);
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

  // get_subnet_health_incidents issues TWO surface_checks reads (SLA rollup +
  // gap-island incident scan); route each to the right rows by a unique clause.
  function incidentsEnv(slaRows = [], incidentRows = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all() {
                  return Promise.resolve({
                    results: /WITH checks AS/.test(sql)
                      ? incidentRows
                      : slaRows,
                  });
                },
              };
            },
          };
        },
      },
    };
  }

  test("get_subnet_health_incidents joins SLA + downtime incidents from D1", async () => {
    const env = incidentsEnv(
      [
        {
          surface_id: "api-root",
          surface_key: "api-root",
          total: 100,
          ok_count: 96,
        },
      ],
      [
        {
          surface_id: "api-root",
          surface_key: "api-root",
          started_at: 1000,
          ended_at: 1300,
          failed_samples: 4,
        },
      ],
    );
    const deps = makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } });
    const res = await callTool(
      "get_subnet_health_incidents",
      { netuid: 7, window: "30d" },
      { deps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "30d");
    assert.equal(out.observed_at, FRESH_RUN);
    const surface = out.surfaces[0];
    assert.equal(surface.surface_id, "api-root");
    assert.equal(surface.samples, 100);
    assert.equal(surface.uptime_ratio, 0.96);
    assert.equal(surface.incident_count, 1);
    assert.equal(surface.downtime_ms, 300);
    assert.equal(surface.incidents[0].failed_samples, 4);
  });

  test("get_subnet_health_incidents returns schema-stable empty surfaces (default 7d) on cold D1", async () => {
    const res = await callTool("get_subnet_health_incidents", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.window, "7d");
    assert.deepEqual(out.surfaces, []);
  });

  test("get_subnet_health_incidents rejects an invalid window", async () => {
    const res = await callTool(
      "get_subnet_health_incidents",
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

  test("get_feed requires kind and rejects an unknown one", async () => {
    const missing = await callTool("get_feed", {});
    assert.equal(missing.body.result.isError, true);
    assert.match(missing.body.result.content[0].text, /kind.*required/);

    const bogus = await callTool("get_feed", { kind: "bogus" });
    assert.equal(bogus.body.result.isError, true);
  });

  test("get_feed requires netuid for kind subnet and rejects it otherwise", async () => {
    const noNetuid = await callTool("get_feed", { kind: "subnet" });
    assert.equal(noNetuid.body.result.isError, true);
    assert.match(noNetuid.body.result.content[0].text, /netuid.*required/);

    const strayNetuid = await callTool("get_feed", {
      kind: "registry",
      netuid: 7,
    });
    assert.equal(strayNetuid.body.result.isError, true);
    assert.match(
      strayNetuid.body.result.content[0].text,
      /netuid.*only used when kind is `subnet`/,
    );
  });

  test("get_feed kind=registry returns items from the changelog artifact", async () => {
    const feedDeps = makeDeps({
      "/metagraph/changelog.json": {
        generated_at: "2026-06-15T00:00:00.000Z",
        summary: {},
        artifacts: { added: [], modified: [], removed: [] },
        subnets: {
          added: [{ netuid: 7, name: "Allways" }],
          removed: [],
          renamed: [],
        },
      },
    });
    const res = await callTool(
      "get_feed",
      { kind: "registry" },
      { deps: feedDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.kind, "registry");
    assert.equal(out.returned, 1);
    assert.equal(out.items[0].tags.includes("subnet"), true);
    assert.match(out.items[0].title, /Subnet 7 added/);
  });

  test("get_feed kind=registry degrades to an empty feed when the changelog artifact is missing", async () => {
    const res = await callTool(
      "get_feed",
      { kind: "registry" },
      { deps: makeDeps() },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 0);
    assert.deepEqual(out.items, []);
  });

  test("get_feed kind=incidents returns items from the live D1 incident ledger", async () => {
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
      "get_feed",
      { kind: "incidents" },
      {
        deps: makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } }),
        env,
      },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.items[0].tags.includes("sn7"), true);
  });

  test("get_feed kind=gaps returns items from the enrichment-queue artifact", async () => {
    const feedDeps = makeDeps({
      "/metagraph/review/enrichment-queue.json": {
        generated_at: "2026-06-15T00:00:00.000Z",
        queue: [
          {
            netuid: 7,
            name: "Allways",
            lane: "direct-submission",
            priority_score: 42,
            missing_kinds: ["openapi"],
            direct_submission_kinds: ["openapi"],
            recommended_action: "Submit an OpenAPI schema.",
          },
        ],
      },
    });
    const res = await callTool(
      "get_feed",
      { kind: "gaps" },
      { deps: feedDeps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.items[0].tags.includes("sn7"), true);
    assert.match(out.items[0].title, /SN7 Allways/);
  });

  test("get_feed kind=gaps degrades to an empty feed when the enrichment-queue artifact is missing", async () => {
    const res = await callTool(
      "get_feed",
      { kind: "gaps" },
      { deps: makeDeps() },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 0);
    assert.deepEqual(out.items, []);
  });

  test("get_feed kind=subnet combines that subnet's registry changes and incidents", async () => {
    const now = Date.now();
    const feedDeps = makeDeps({
      "/metagraph/changelog.json": {
        generated_at: "2026-06-15T00:00:00.000Z",
        summary: {},
        artifacts: { added: [], modified: [], removed: [] },
        subnets: {
          added: [{ netuid: 7, name: "Allways" }],
          removed: [],
          renamed: [],
        },
      },
    });
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
      "get_feed",
      { kind: "subnet", netuid: 7 },
      { deps: feedDeps, env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.returned, 2);
    const tagSets = out.items.map((item) => item.tags);
    assert.ok(tagSets.some((tags) => tags.includes("registry")));
    assert.ok(tagSets.some((tags) => tags.includes("incident")));
  });

  test("get_feed filters by tag, since/until, and caps with limit", async () => {
    const feedDeps = makeDeps({
      "/metagraph/changelog.json": {
        generated_at: "2026-06-15T00:00:00.000Z",
        summary: {},
        artifacts: { added: [], modified: [], removed: [] },
        subnets: {
          added: [
            { netuid: 7, name: "Allways" },
            { netuid: 8, name: "Second" },
          ],
          removed: [],
          renamed: [],
        },
      },
    });
    const byTag = await callTool(
      "get_feed",
      { kind: "registry", tag: "sn9-does-not-exist" },
      { deps: feedDeps },
    );
    assert.equal(byTag.body.result.structuredContent.returned, 0);

    const limited = await callTool(
      "get_feed",
      { kind: "registry", limit: 1 },
      { deps: feedDeps },
    );
    assert.equal(limited.body.result.structuredContent.returned, 1);
    assert.equal(limited.body.result.structuredContent.filters.limit, 1);

    const windowed = await callTool(
      "get_feed",
      {
        kind: "registry",
        since: "2026-06-16",
        until: "2026-06-17",
      },
      { deps: feedDeps },
    );
    assert.equal(windowed.body.result.structuredContent.returned, 0);
  });

  test("get_feed rejects a malformed since/until/limit", async () => {
    const badSince = await callTool("get_feed", {
      kind: "registry",
      since: "not-a-date",
    });
    assert.equal(badSince.body.result.isError, true);

    const badUntil = await callTool("get_feed", {
      kind: "registry",
      until: "not-a-date",
    });
    assert.equal(badUntil.body.result.isError, true);

    const badLimit = await callTool("get_feed", {
      kind: "registry",
      limit: 0,
    });
    assert.equal(badLimit.body.result.isError, true);

    // tools/call does not enforce inputSchema types, so a non-string tag/
    // since/until must be rejected by the handler itself, not just a bad
    // string value.
    const nonStringSince = await callTool("get_feed", {
      kind: "registry",
      since: 123,
    });
    assert.equal(nonStringSince.body.result.isError, true);

    const nonStringTag = await callTool("get_feed", {
      kind: "registry",
      tag: 123,
    });
    assert.equal(nonStringTag.body.result.isError, true);
  });

  test("get_feed payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_feed",
    )?.outputSchema;
    const feedDeps = makeDeps({
      "/metagraph/changelog.json": {
        generated_at: "2026-06-15T00:00:00.000Z",
        summary: {},
        artifacts: { added: [], modified: [], removed: [] },
        subnets: {
          added: [{ netuid: 7, name: "Allways" }],
          removed: [],
          renamed: [],
        },
      },
    });
    const res = await callTool(
      "get_feed",
      { kind: "registry" },
      { deps: feedDeps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
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

  // account_events/neurons' D1 write path is retired (#4772) and both tables
  // are dropped in production, so get_account always returns the
  // schema-stable zero summary (buildAccountSummary(ss58, {})) -- covered by
  // "the account tools degrade to schema-stable empty payloads when D1 is
  // cold" below; cross-subnet row-shaping is still covered directly against
  // the pure builder in tests/account-events.test.mjs.

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

  // account_events' D1 write path is retired (#4772) and the table is dropped
  // in production, so get_account_events always returns the schema-stable
  // empty feed (buildAccountEvents([], ss58, {limit, offset, nextCursor:
  // null})) -- kind/netuid filtering row-shaping is still covered directly
  // against the pure builder in tests/account-events.test.mjs; this only
  // proves kind/netuid/limit are still accepted (or validated) with an empty
  // feed.
  test("get_account_events accepts kind and echoes the limit with an empty feed", async () => {
    const res = await callTool("get_account_events", {
      ss58: SS58,
      kind: "StakeRemoved",
      limit: 50,
    });
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.events, []);
    assert.equal(out.limit, 50);
    assert.equal(out.offset, 0);
  });

  test("get_account_events accepts netuid with an empty feed (#2585 parity)", async () => {
    const res = await callTool("get_account_events", {
      ss58: SS58,
      netuid: 74,
    });
    assert.deepEqual(res.body.result.structuredContent.events, []);
  });

  test("get_account_events rejects a malformed netuid", async () => {
    const env = accountD1({ events: [] });
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, netuid: -1 },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  test("get_account_events clamps an over-range limit the same way the REST route does", async () => {
    const res = await callTool("get_account_events", {
      ss58: SS58,
      limit: 5000,
    });
    // clampLimit(5000, 100, 1000) → 1000, echoed in the payload.
    assert.equal(res.body.result.structuredContent.limit, 1000);
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

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_subnets always returns the schema-stable
  // empty footprint (buildAccountSubnets([], ss58)) -- covered by "the
  // account tools degrade to schema-stable empty payloads when D1 is cold"
  // below; cross-subnet row-shaping is still covered directly against the
  // pure builder in tests/account-events.test.mjs.

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_portfolio always returns the schema-stable
  // empty portfolio (buildAccountPortfolio([], ss58)) -- position row-shaping
  // is still covered directly against the pure builder in
  // tests/account-portfolio.test.mjs.
  test("get_account_portfolio returns an empty portfolio on cold D1", async () => {
    const res = await callTool(
      "get_account_portfolio",
      { ss58: SS58 },
      { env: accountD1({ registrations: [] }) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.position_count, 0);
    assert.equal(out.stake_concentration, null);
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

  // account_events' D1 write path is retired (#4772) and the table is dropped
  // in production, so get_account_events never issues a D1 query at all --
  // cursor/offset row-value-seek SQL shaping is no longer reachable from this
  // tool (buildAccountEvents([], ss58, {limit, offset, nextCursor: null})
  // always echoes next_cursor: null). block_start/block_end/cursor are still
  // accepted (validated) with an empty feed.
  test("get_account_events accepts block_start/block_end/cursor with an empty feed and null next_cursor", async () => {
    const res = await callTool("get_account_events", {
      ss58: SS58,
      block_start: 100,
      block_end: 900,
      cursor: "200.2",
      limit: 1,
      offset: 99,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.event_count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_cursor, null);
    assert.equal(out.limit, 1);
  });

  test("get_account_events rejects a non-integer block_start", async () => {
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, block_start: "bad" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /block_start/i);
  });

  test("get_account_events rejects an unknown event kind before D1", async () => {
    let called = false;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              called = true;
              return { all: () => Promise.resolve({ results: [] }) };
            },
          };
        },
      },
    };
    const res = await callTool(
      "get_account_events",
      { ss58: SS58, kind: "Nonexistent" },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /supported event kind/i);
    assert.equal(called, false);
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

  test("get_account_history rejects malformed from/to dates before D1", async () => {
    const res = await callTool("get_account_history", {
      ss58: SS58,
      from: "June",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /YYYY-MM-DD/i);
  });

  test("get_account_history rejects a non-integer netuid filter", async () => {
    const res = await callTool("get_account_history", {
      ss58: SS58,
      netuid: 7.5,
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /netuid/i);
  });

  // extrinsics' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_account_extrinsics always returns the schema-stable
  // empty feed (buildAccountExtrinsics([], ss58, {limit, offset, nextCursor:
  // null})) -- covered by "degrades to empty payload on cold D1" below.
  // buildAccountExtrinsics's populated-row shaping (the same builder REST's
  // handleAccountExtrinsics also now calls with []) is unreachable in
  // production either way; block_start/block_end/cursor are still accepted
  // (validated) with an empty feed and a null next_cursor.
  test("get_account_extrinsics echoes the limit with an empty feed", async () => {
    const res = await callTool("get_account_extrinsics", {
      ss58: SS58,
      limit: 50,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.extrinsic_count, 0);
    assert.equal(out.limit, 50);
    assert.deepEqual(out.extrinsics, []);
  });

  test("get_account_extrinsics degrades to empty payload on cold D1", async () => {
    const res = await callTool("get_account_extrinsics", { ss58: SS58 });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    assert.deepEqual(res.body.result.structuredContent.extrinsics, []);
  });

  test("get_account_extrinsics accepts block_start/block_end/cursor with an empty feed and null next_cursor", async () => {
    const res = await callTool("get_account_extrinsics", {
      ss58: SS58,
      block_start: 100,
      block_end: 900,
      cursor: "200.2",
      limit: 1,
      offset: 99,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.extrinsic_count, 0);
    assert.deepEqual(out.extrinsics, []);
    assert.equal(out.next_cursor, null);
  });

  test("get_account_extrinsics rejects a non-integer block_start", async () => {
    const res = await callTool(
      "get_account_extrinsics",
      { ss58: SS58, block_start: "bad" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /block_start/i);
  });

  // account_events' D1 write path is retired (#4772) and the table is dropped
  // in production, so get_account_transfers always returns the schema-stable
  // empty feed (buildAccountTransfers([], ss58, {limit, offset, nextCursor:
  // null, direction})) -- covered by "degrades to empty payload on cold D1"
  // below; direction-labeled row-shaping is still covered directly against
  // the pure builder in tests/account-events.test.mjs. direction/
  // block_start/block_end/cursor are still accepted (validated) with an
  // empty feed and a null next_cursor.
  test("get_account_transfers accepts direction/block bounds/cursor with an empty feed and null next_cursor", async () => {
    const res = await callTool("get_account_transfers", {
      ss58: SS58,
      direction: "sent",
      block_start: 100,
      block_end: 900,
      cursor: "200.2",
      limit: 1,
      offset: 99,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.transfer_count, 0);
    assert.deepEqual(out.transfers, []);
    assert.equal(out.next_cursor, null);
  });

  test("get_account_transfers rejects a non-integer block_end", async () => {
    const res = await callTool(
      "get_account_transfers",
      { ss58: SS58, block_end: "bad" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /block_end/i);
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

describe("MCP block-explorer tools (list_blocks, get_block, list_block_extrinsics, get_block_events, list_extrinsics, get_extrinsic)", () => {
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
                    /FROM extrinsics WHERE block_number = \? ORDER BY extrinsic_index/.test(
                      sql,
                    )
                  )
                    return Promise.resolve({
                      results: fixtures.blockExtrinsics || [],
                    });
                  if (
                    /FROM extrinsics WHERE block_number = \? AND extrinsic_index/.test(
                      sql,
                    )
                  )
                    return Promise.resolve({
                      results: fixtures.extrinsic ? [fixtures.extrinsic] : [],
                    });
                  if (
                    /FROM account_events WHERE block_number = \? AND extrinsic_index = \?/.test(
                      sql,
                    )
                  )
                    return Promise.resolve({
                      results: fixtures.extrinsicEvents || [],
                    });
                  if (
                    /FROM account_events WHERE block_number = \? ORDER BY event_index/.test(
                      sql,
                    )
                  )
                    return Promise.resolve({
                      results: fixtures.blockEvents || [],
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

  const EVENT_ROW = {
    block_number: 4200000,
    event_index: 0,
    event_kind: "WeightsSet",
    hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    coldkey: null,
    netuid: 7,
    uid: 3,
    amount_tao: null,
    observed_at: 1750009000000,
  };

  // blocks' D1 write path is retired (#4772) and the table is dropped in
  // production, so list_blocks always returns the schema-stable empty feed
  // (buildBlockFeed([], {limit, offset, nextCursor: null})) -- covered by
  // "degrades to empty payload on cold D1" below; row-shaping/pagination
  // (including keyset cursor emission) is still covered directly against the
  // pure builder in tests/blocks.test.mjs. A D1 mock, if bound, is never
  // queried -- cursor is still accepted (validated) with an empty feed.
  test("list_blocks accepts a cursor with an empty feed (D1 never queried)", async () => {
    const res = await callTool("list_blocks", {
      cursor: "4200000",
      limit: 50,
      offset: 10,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.block_count, 0);
    assert.deepEqual(out.blocks, []);
    assert.equal(out.next_cursor, null);
    assert.equal(out.offset, 10);
  });

  test("list_blocks degrades to empty payload on cold D1", async () => {
    const res = await callTool("list_blocks", {});
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.block_count, 0);
    assert.deepEqual(res.body.result.structuredContent.blocks, []);
  });

  test("list_blocks accepts every REST filter parity param with an empty feed (D1 never queried)", async () => {
    const res = await callTool("list_blocks", {
      author: BLOCK_ROW.author,
      spec_version: 207,
      block_start: 100,
      block_end: 200,
      from: 1_000,
      to: 2_000,
      min_extrinsics: 1,
      min_events: 5,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.block_count, 0);
    assert.deepEqual(out.blocks, []);
  });

  test("list_blocks short-circuits impossible count floors without querying D1", async () => {
    const capture = [];
    const env = chainD1({ blocks: [BLOCK_ROW] }, capture);
    const res = await callTool(
      "list_blocks",
      { min_events: 9_007_199_254_740_991 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.block_count, 0);
    assert.equal(capture.filter((c) => /FROM blocks/.test(c.sql)).length, 0);
  });

  // blocks' D1 write path is retired (#4772) and the table is dropped in
  // production, so get_block always returns the schema-stable block:null
  // detail (buildBlock(undefined, ref)) -- no D1 lookup (numeric or hash ref,
  // or prev/next neighbor query) happens at all. Row-shaping is still
  // covered directly against the pure builder in tests/blocks.test.mjs.
  test("get_block accepts a 0x hash ref with block:null (D1 never queried)", async () => {
    const hash = "0x" + "a".repeat(64);
    const res = await callTool("get_block", { ref: hash });
    const out = res.body.result.structuredContent;
    assert.equal(out.ref, hash);
    assert.equal(out.block, null);
    assert.equal(out.prev_block_number, null);
    assert.equal(out.next_block_number, null);
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

  // extrinsics'/account_events' D1 write paths are retired (#4772) and both
  // tables are dropped in production, so list_block_extrinsics and
  // get_block_events always return the schema-stable block_number:null
  // detail (buildBlockExtrinsics([], ref, null, {...}) /
  // buildBlockEvents([], ref, null, {...})) -- no block-ref resolution (numeric
  // or hash) or sub-resource query happens at all. Covered by "returns empty
  // payload for unknown ref" below for each tool.

  test("list_block_extrinsics returns empty payload for unknown ref", async () => {
    const res = await callTool("list_block_extrinsics", {
      ref: "9999999",
      offset: 5,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.block_number, null);
    assert.deepEqual(out.extrinsics, []);
    assert.equal(out.offset, 5);
  });

  test("get_block_events returns empty payload for unknown ref", async () => {
    const res = await callTool("get_block_events", {
      ref: "9999999",
      offset: 5,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.block_number, null);
    assert.deepEqual(out.events, []);
    assert.equal(out.offset, 5);
  });

  // extrinsics' D1 write path is retired (#4772) and the table is dropped in
  // production, so list_extrinsics/get_extrinsic (D1 tail, past a failed/
  // absent Postgres tier) always return the schema-stable empty feed/detail
  // (buildExtrinsicFeed([], {...}) / buildExtrinsic(undefined, ref)) -- no
  // filter/cursor SQL is built at all. Covered by "degrades to empty payload
  // on cold D1" / "returns extrinsic:null for an unknown ref" below; feed and
  // detail row-shaping (including success coercion, composite-ref parsing) is
  // still covered directly against the pure builders in
  // tests/extrinsics.test.mjs.
  test("list_extrinsics accepts every REST filter parity param with an empty feed (D1 never queried)", async () => {
    const toMs = Date.now();
    const fromMs = toMs - 60_000;
    const res = await callTool("list_extrinsics", {
      block: 4200000,
      signer: EXTRINSIC_ROW.signer,
      call_module: "SubtensorModule",
      call_function: "set_weights",
      call_hash: "0x" + "a".repeat(64),
      success: true,
      block_start: 100,
      block_end: 200,
      from: fromMs,
      to: toMs,
      cursor: "4200000.3",
      offset: 15,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.extrinsic_count, 0);
    assert.deepEqual(out.extrinsics, []);
    assert.equal(out.offset, 15);
  });

  test("list_extrinsics degrades to empty payload on cold D1", async () => {
    const res = await callTool("list_extrinsics", {});
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    assert.deepEqual(res.body.result.structuredContent.extrinsics, []);
  });

  test("list_extrinsics short-circuits impossible time ranges without querying D1", async () => {
    const capture = [];
    const env = chainD1({ extrinsics: [EXTRINSIC_ROW] }, capture);
    const res = await callTool(
      "list_extrinsics",
      { from: 200, to: 100 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    assert.equal(
      capture.filter((c) => /FROM extrinsics/.test(c.sql)).length,
      0,
    );
  });

  test("list_extrinsics rejects a non-boolean success filter", async () => {
    const res = await callTool("list_extrinsics", { success: "maybe" });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /success/);
  });

  test("get_extrinsic returns extrinsic:null by 0x hash (D1 never queried)", async () => {
    const hash = "0x" + "c".repeat(64);
    const res = await callTool("get_extrinsic", { ref: hash });
    const out = res.body.result.structuredContent;
    assert.equal(out.ref, hash);
    assert.equal(out.extrinsic, null);
    assert.deepEqual(out.events, []);
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

  // #4694: list_extrinsics/get_extrinsic mirror REST's handleExtrinsics/
  // handleExtrinsic tier-selection exactly (same METAGRAPH_EXTRINSICS_SOURCE
  // flag, same tryPostgresTier fallback contract) -- see the equivalent
  // "flag=postgres" tests for handleExtrinsics/handleExtrinsic in
  // tests/request-handlers-entities.test.mjs, which this block mirrors.
  describe("D1 -> Postgres serving cutover (#4694)", () => {
    function dataApi(response) {
      return { fetch: async (request) => response ?? { request } };
    }

    test("list_extrinsics: flag=postgres uses Postgres data, D1 never queried", async () => {
      const capture = [];
      const env = chainD1({ extrinsics: [] }, capture);
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 99,
          limit: 50,
          offset: 0,
          next_cursor: null,
          extrinsics: [],
        }),
      );
      const res = await callTool("list_extrinsics", {}, { env });
      assert.equal(res.body.result.structuredContent.extrinsic_count, 99);
      assert.deepEqual(capture, []);
    });

    // extrinsics' D1 write path is retired (#4772) and the table is dropped
    // in production, so the tail of the tryPostgresTier ?? chain is now the
    // schema-stable empty feed (buildExtrinsicFeed([], {...})), not a live D1
    // query -- a D1 mock, if bound, is never queried either way.
    test("list_extrinsics: flag=postgres falls back to the schema-stable empty feed on Postgres failure", async () => {
      const env = {};
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = {
        fetch: async () => {
          throw new Error("boom");
        },
      };
      const res = await callTool("list_extrinsics", {}, { env });
      assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    });

    test("list_extrinsics: flag absent returns the schema-stable empty feed even when DATA_API is bound (unflipped)", async () => {
      const env = {};
      env.DATA_API = dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 99,
          extrinsics: [],
        }),
      );
      const res = await callTool("list_extrinsics", {}, { env });
      assert.equal(res.body.result.structuredContent.extrinsic_count, 0);
    });

    test("list_extrinsics: flag=postgres forwards filters as REST-equivalent query params", async () => {
      const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
      let seenUrl;
      const env = chainD1({ extrinsics: [] });
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = {
        fetch: async (request) => {
          seenUrl = new URL(request.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            extrinsics: [],
          });
        },
      };
      const callHash = "0x" + "b".repeat(64);
      await callTool(
        "list_extrinsics",
        {
          block: 4200000,
          signer: SS58,
          call_module: "SubtensorModule",
          call_function: "set_weights",
          call_hash: callHash,
          success: true,
          limit: 10,
          offset: 20,
        },
        { env },
      );
      assert.equal(seenUrl.pathname, "/api/v1/extrinsics");
      assert.equal(seenUrl.searchParams.get("block"), "4200000");
      assert.equal(seenUrl.searchParams.get("offset"), "20");
      assert.equal(seenUrl.searchParams.get("signer"), SS58);
      assert.equal(seenUrl.searchParams.get("call_module"), "SubtensorModule");
      assert.equal(seenUrl.searchParams.get("call_function"), "set_weights");
      assert.equal(seenUrl.searchParams.get("call_hash"), callHash);
      assert.equal(seenUrl.searchParams.get("success"), "true");
      assert.equal(seenUrl.searchParams.get("limit"), "10");
    });

    test("get_extrinsic: flag=postgres uses Postgres data, D1 never queried", async () => {
      const hash = "0x" + "c".repeat(64);
      const capture = [];
      const env = chainD1({ extrinsic: EXTRINSIC_ROW }, capture);
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = dataApi(
        Response.json({
          schema_version: 1,
          ref: hash,
          extrinsic: { ...EXTRINSIC_ROW, signer: "postgres-signer" },
          events: [],
        }),
      );
      const res = await callTool("get_extrinsic", { ref: hash }, { env });
      assert.equal(
        res.body.result.structuredContent.extrinsic.signer,
        "postgres-signer",
      );
      assert.deepEqual(capture, []);
    });

    // extrinsics' D1 write path is retired (#4772) and the table is dropped
    // in production, so the tail of the tryPostgresTier ?? chain is now the
    // schema-stable extrinsic:null detail (buildExtrinsic(undefined, ref)),
    // not a live D1 query.
    test("get_extrinsic: flag=postgres falls back to the schema-stable empty detail on Postgres failure", async () => {
      const hash = "0x" + "c".repeat(64);
      const env = {};
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = {
        fetch: async () => new Response("err", { status: 500 }),
      };
      const res = await callTool("get_extrinsic", { ref: hash }, { env });
      const out = res.body.result.structuredContent;
      assert.equal(out.ref, hash);
      assert.equal(out.extrinsic, null);
    });

    test("get_extrinsic: flag=postgres forwards the ref in the request path", async () => {
      let seenUrl;
      const env = chainD1({ extrinsic: EXTRINSIC_ROW });
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = {
        fetch: async (request) => {
          seenUrl = new URL(request.url);
          return Response.json({
            schema_version: 1,
            ref: "4200000-3",
            extrinsic: null,
            events: [],
          });
        },
      };
      await callTool("get_extrinsic", { ref: "4200000-3" }, { env });
      assert.equal(seenUrl.pathname, "/api/v1/extrinsics/4200000-3");
    });
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
      [
        "list_block_extrinsics",
        chainD1({ block: BLOCK_ROW, blockExtrinsics: [EXTRINSIC_ROW] }),
        { ref: "4200000" },
      ],
      [
        "get_block_events",
        chainD1({ block: BLOCK_ROW, blockEvents: [EVENT_ROW] }),
        { ref: "4200000" },
      ],
      ["list_extrinsics", chainD1({ extrinsics: [EXTRINSIC_ROW] }), {}],
      [
        "get_extrinsic",
        chainD1({
          extrinsic: EXTRINSIC_ROW,
          extrinsicEvents: [EVENT_ROW],
        }),
        { ref: hash },
      ],
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

describe("MCP all-events tier tools (get_block_chain_events, get_extrinsic_chain_events)", () => {
  // Exact upstream JSON from workers/data-api.mjs (see tests/data-api.test.mjs).
  const DATA_API_BLOCK_CHAIN_EVENTS_PAYLOAD = {
    block_number: 123,
    count: 1,
    events: [
      {
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: { x: 1 },
        phase: "ApplyExtrinsic",
        extrinsic_index: 2,
        observed_at: 100,
      },
    ],
  };
  const DATA_API_EXTRINSIC_CHAIN_EVENTS_PAYLOAD = {
    count: 1,
    next_before: 123,
    next_cursor: "123.0",
    events: [
      {
        block_number: 123,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: { x: 1 },
        phase: "ApplyExtrinsic",
        extrinsic_index: 2,
        observed_at: 100,
      },
    ],
  };

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

  test("get_block_chain_events returns raw events for a block", async () => {
    const dataApi = makeDataApi({
      payload: {
        block_number: 4200000,
        count: 1,
        events: [
          {
            event_index: 0,
            pallet: "Balances",
            method: "Transfer",
            observed_at: 1,
          },
        ],
      },
    });
    const res = await callTool(
      "get_block_chain_events",
      { block_number: 4200000 },
      { env: { DATA_API: dataApi } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.event_count, 1);
    assert.equal(out.events[0].pallet, "Balances");
    assert.match(dataApi.calls[0].pathname, /\/blocks\/4200000\/chain-events$/);
  });

  test("get_block_chain_events round-trips the DATA_API block chain-events contract", async () => {
    const dataApi = makeDataApi({
      payload: DATA_API_BLOCK_CHAIN_EVENTS_PAYLOAD,
    });
    const res = await callTool(
      "get_block_chain_events",
      { block_number: 123 },
      { env: { DATA_API: dataApi } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.block_number, 123);
    assert.equal(out.event_count, 1);
    assert.deepEqual(out.events, DATA_API_BLOCK_CHAIN_EVENTS_PAYLOAD.events);
    assert.equal(typeof out.events[0].observed_at, "number");
  });

  test("get_extrinsic_chain_events forwards block+extrinsic filters", async () => {
    const dataApi = makeDataApi({ payload: { count: 0, events: [] } });
    const res = await callTool(
      "get_extrinsic_chain_events",
      { ref: "4200000-3" },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(dataApi.calls[0].searchParams.get("block"), "4200000");
    assert.equal(dataApi.calls[0].searchParams.get("extrinsic"), "3");
    assert.equal(dataApi.calls[0].searchParams.get("limit"), "50");
    assert.deepEqual(res.body.result.structuredContent.events, []);
  });

  test("get_extrinsic_chain_events round-trips the DATA_API chain-events feed contract", async () => {
    const dataApi = makeDataApi({
      payload: DATA_API_EXTRINSIC_CHAIN_EVENTS_PAYLOAD,
    });
    const res = await callTool(
      "get_extrinsic_chain_events",
      { ref: "5870000-3" },
      { env: { DATA_API: dataApi } },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.event_count, 1);
    assert.equal(out.next_cursor, "123.0");
    assert.deepEqual(
      out.events,
      DATA_API_EXTRINSIC_CHAIN_EVENTS_PAYLOAD.events,
    );
    assert.equal(typeof out.events[0].observed_at, "number");
    assert.equal(dataApi.calls[0].searchParams.get("block"), "5870000");
    assert.equal(dataApi.calls[0].searchParams.get("extrinsic"), "3");
  });

  test("get_extrinsic_chain_events follows next_cursor on a follow-up page", async () => {
    const calls = [];
    const dataApi = {
      calls,
      fetch(request) {
        calls.push(new URL(request.url));
        const cursor = new URL(request.url).searchParams.get("cursor");
        const payload = cursor
          ? {
              count: 1,
              events: [{ pallet: "System", method: "ExtrinsicSuccess" }],
            }
          : { count: 0, next_cursor: "4200000.9", events: [] };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    };
    const first = await callTool(
      "get_extrinsic_chain_events",
      { ref: "4200000-3", limit: 10 },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(first.body.result.isError, false);
    assert.equal(first.body.result.structuredContent.next_cursor, "4200000.9");
    const second = await callTool(
      "get_extrinsic_chain_events",
      { ref: "4200000-3", cursor: "4200000.9" },
      { env: { DATA_API: dataApi } },
    );
    assert.equal(second.body.result.isError, false);
    assert.equal(calls[1].searchParams.get("cursor"), "4200000.9");
    assert.equal(
      second.body.result.structuredContent.events[0].method,
      "ExtrinsicSuccess",
    );
  });

  test("get_extrinsic_chain_events rejects a hash ref", async () => {
    const res = await callTool(
      "get_extrinsic_chain_events",
      { ref: "0x" + "a".repeat(64) },
      { env: { DATA_API: makeDataApi({ payload: {} }) } },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /composite/i);
  });

  test("tier_unavailable when DATA_API is absent", async () => {
    for (const [name, args] of [
      ["get_block_chain_events", { block_number: 1 }],
      ["get_extrinsic_chain_events", { ref: "1-0" }],
    ]) {
      const res = await callTool(name, args, { env: {} });
      assert.equal(res.body.result.isError, true, name);
      assert.match(res.body.result.content[0].text, /unavailable/i);
    }
  });

  test("all-events tool payloads validate against their declared outputSchemas", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validatorFor = (name) =>
      ajv.compile(
        listToolDefinitions().find((t) => t.name === name).outputSchema,
      );
    const dataApi = makeDataApi({
      payload: DATA_API_BLOCK_CHAIN_EVENTS_PAYLOAD,
    });
    const blockRes = await callTool(
      "get_block_chain_events",
      { block_number: 123 },
      { env: { DATA_API: dataApi } },
    );
    assert.ok(
      validatorFor("get_block_chain_events")(
        blockRes.body.result.structuredContent,
      ),
    );
    const extrinsicDataApi = makeDataApi({
      payload: DATA_API_EXTRINSIC_CHAIN_EVENTS_PAYLOAD,
    });
    const extrinsicRes = await callTool(
      "get_extrinsic_chain_events",
      { ref: "5870000-3", limit: 10 },
      { env: { DATA_API: extrinsicDataApi } },
    );
    assert.ok(
      validatorFor("get_extrinsic_chain_events")(
        extrinsicRes.body.result.structuredContent,
      ),
    );
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
  // A D1 binding routing by SQL shape over neuron_daily + account_events, so the
  // parity loaders' WHERE/GROUP-BY clauses get realistic rows. `capture` records
  // each bound (sql, params) so a test can assert what reached the query.
  function parityD1(
    { dailyAgg, dailyRows, concentrationRows, events, identityHistory } = {},
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
                  if (/FROM subnet_identity_history/.test(sql))
                    return Promise.resolve({ results: identityHistory || [] });
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
  }

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped
  // in production, so get_subnet_history always returns the schema-stable
  // empty series (buildSubnetHistory([], netuid, {window})) -- no D1 query
  // (GROUP BY snapshot_date, date-cutoff bind) happens at all. Per-day
  // row-shaping is still covered directly against the pure builder in
  // tests/neuron-history.test.mjs.
  test("get_subnet_history returns a schema-stable empty series (D1 never queried)", async () => {
    const res = await callTool("get_subnet_history", {
      netuid: 1,
      window: "7d",
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.window, "7d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("get_subnet_history accepts the all window with an empty series", async () => {
    const res = await callTool("get_subnet_history", {
      netuid: 1,
      window: "all",
    });
    assert.equal(res.body.result.structuredContent.window, "all");
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

  test("get_subnet_identity_history returns the append-only identity timeline", async () => {
    const env = parityD1({
      identityHistory: [
        {
          id: 2,
          block_number: 100,
          observed_at: 1_700_000_000_000,
          subnet_name: "MIAO",
          symbol: "α",
          description: "sound AI",
          github_repo: null,
          subnet_url: null,
          discord: null,
          logo_url: null,
          identity_hash: "hash-1",
        },
      ],
    });
    const res = await callTool(
      "get_subnet_identity_history",
      { netuid: 86, limit: 10 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 86);
    assert.equal(out.entry_count, 1);
    assert.equal(out.entries[0].subnet_name, "MIAO");
    assert.equal(out.limit, 10);
  });

  // #4832 gap-closure: get_subnet_identity_history mirrors REST's
  // handleSubnetIdentityHistory tier-selection exactly (same
  // METAGRAPH_SUBNET_IDENTITY_SOURCE flag, same tryPostgresTier fallback
  // contract) -- see the equivalent "flag=postgres" tests for
  // handleSubnetIdentityHistory in tests/request-handlers-entities.test.mjs,
  // which this block mirrors. Also mirrors list_extrinsics/get_extrinsic's own
  // "D1 -> Postgres serving cutover (#4694)" block in the block-explorer
  // describe above.
  describe("get_subnet_identity_history D1 -> Postgres serving cutover", () => {
    const MIAO_ROW = {
      id: 2,
      block_number: 100,
      observed_at: 1_700_000_000_000,
      subnet_name: "MIAO",
      symbol: "α",
      description: "sound AI",
      github_repo: null,
      subnet_url: null,
      discord: null,
      logo_url: null,
      identity_hash: "hash-1",
    };

    test("flag=postgres uses Postgres data, D1 never queried", async () => {
      const capture = [];
      const env = {
        ...parityD1({ identityHistory: [] }, capture),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              netuid: 86,
              entry_count: 1,
              limit: null,
              offset: null,
              next_cursor: null,
              entries: [{ identity_hash: "pg-hash" }],
            }),
        },
      };
      const res = await callTool(
        "get_subnet_identity_history",
        { netuid: 86 },
        { env },
      );
      const out = res.body.result.structuredContent;
      assert.equal(out.entries[0].identity_hash, "pg-hash");
      assert.deepEqual(capture, []);
    });

    test("flag=postgres falls back to D1 on failure", async () => {
      const env = {
        ...parityD1({ identityHistory: [MIAO_ROW] }),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(
        "get_subnet_identity_history",
        { netuid: 86 },
        { env },
      );
      const out = res.body.result.structuredContent;
      assert.equal(out.entries[0].identity_hash, "hash-1");
    });

    test("flag absent uses D1 even when DATA_API is bound (zero regression, unflipped)", async () => {
      const capture = [];
      const env = {
        ...parityD1({ identityHistory: [MIAO_ROW] }, capture),
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              netuid: 86,
              entry_count: 0,
              entries: [],
            }),
        },
      };
      const res = await callTool(
        "get_subnet_identity_history",
        { netuid: 86 },
        { env },
      );
      const out = res.body.result.structuredContent;
      assert.equal(out.entries[0].identity_hash, "hash-1");
      assert.ok(capture.length > 0, "D1 must actually be queried");
    });

    test("flag=postgres forwards netuid + limit/offset/cursor as a REST-equivalent request", async () => {
      let seenUrl;
      const env = {
        ...parityD1({ identityHistory: [] }),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async (request) => {
            seenUrl = new URL(request.url);
            return Response.json({
              schema_version: 1,
              netuid: 86,
              entry_count: 0,
              entries: [],
            });
          },
        },
      };
      await callTool(
        "get_subnet_identity_history",
        { netuid: 86, limit: 10, offset: 5, cursor: "abc" },
        { env },
      );
      assert.equal(seenUrl.pathname, "/api/v1/subnets/86/identity-history");
      assert.equal(seenUrl.searchParams.get("limit"), "10");
      assert.equal(seenUrl.searchParams.get("offset"), "5");
      assert.equal(seenUrl.searchParams.get("cursor"), "abc");
    });

    test("flag=postgres omits pagination params when not supplied", async () => {
      let seenUrl;
      const env = {
        ...parityD1({ identityHistory: [] }),
        METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async (request) => {
            seenUrl = new URL(request.url);
            return Response.json({
              schema_version: 1,
              netuid: 86,
              entry_count: 0,
              entries: [],
            });
          },
        },
      };
      await callTool("get_subnet_identity_history", { netuid: 86 }, { env });
      assert.equal(seenUrl.pathname, "/api/v1/subnets/86/identity-history");
      assert.equal(seenUrl.searchParams.has("limit"), false);
      assert.equal(seenUrl.searchParams.has("offset"), false);
      assert.equal(seenUrl.searchParams.has("cursor"), false);
    });
  });

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped
  // in production, so get_neuron_history always returns the schema-stable
  // empty series (buildNeuronHistory([], netuid, uid, {window})) -- no D1
  // query happens at all. Per-day row-shaping is still covered directly
  // against the pure builder in tests/neuron-history.test.mjs.
  test("get_neuron_history returns a schema-stable empty series (D1 never queried)", async () => {
    const res = await callTool("get_neuron_history", {
      netuid: 1,
      uid: 3,
      window: "30d",
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.uid, 3);
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("get_neuron_history requires a non-negative uid", async () => {
    const res = await callTool("get_neuron_history", { netuid: 1 });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /uid/);
  });

  // neuron_daily's D1 write path is retired (#4772) and the table is dropped
  // in production, so get_subnet_concentration_history always returns the
  // schema-stable empty series (buildConcentrationHistory([], netuid,
  // {window, capped:false})) -- covered by the equivalent empty-series
  // assertion in the "MCP economics + metagraph data tools" describe block
  // above; per-day row-shaping is still covered directly against the pure
  // builder in tests/concentration.test.mjs.

  test("get_subnet_concentration_history rejects the 1y window (smaller set)", async () => {
    const res = await callTool("get_subnet_concentration_history", {
      netuid: 1,
      window: "1y",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });

  // account_events' D1 write path is retired (#4772) and the table is
  // dropped in production, so get_subnet_events always returns the
  // schema-stable empty feed (buildSubnetEvents([], netuid, {limit, offset,
  // nextCursor: null})) -- covered by "the parity history/events tools
  // degrade to empty payloads on cold D1" below. buildSubnetEvents shares
  // formatAccountEvent's row-mapping with buildAccountEvents, which is
  // covered with real rows in tests/account-events.test.mjs; kind is still
  // validated (and other args accepted) with an empty feed and a null
  // next_cursor.
  test("get_subnet_events accepts kind and echoes the limit with an empty feed", async () => {
    const res = await callTool("get_subnet_events", {
      netuid: 1,
      kind: "WeightsSet",
      limit: 1,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 1);
    assert.equal(out.event_count, 0);
    assert.equal(out.limit, 1);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_cursor, null);
  });

  test("get_subnet_events rejects an unknown event kind before D1", async () => {
    let called = false;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              called = true;
              return { all: () => Promise.resolve({ results: [] }) };
            },
          };
        },
      },
    };
    const res = await callTool(
      "get_subnet_events",
      { netuid: 1, kind: "Nonexistent" },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /supported event kind/i);
    assert.equal(called, false);
  });

  test("get_subnet_events accepts an ingested non-indexed kind (Transfer) with an empty feed", async () => {
    const res = await callTool("get_subnet_events", {
      netuid: 1,
      kind: "Transfer",
    });
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(res.body.result.structuredContent.events, []);
  });

  test("get_subnet_events accepts block_start/block_end/cursor with an empty feed and null next_cursor", async () => {
    const res = await callTool("get_subnet_events", {
      netuid: 1,
      block_start: 100,
      block_end: 900,
      cursor: "200.2",
      limit: 1,
      offset: 99,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.event_count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_cursor, null);
  });

  test("get_subnet_events rejects a non-integer block_start", async () => {
    const res = await callTool(
      "get_subnet_events",
      { netuid: 1, block_start: "bad" },
      {},
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /block_start/i);
  });

  test("get_subnet_events clamps an over-range limit like the REST route", async () => {
    const res = await callTool("get_subnet_events", {
      netuid: 1,
      limit: 5000,
    });
    // clampLimit(5000, 100, 1000) → 1000, echoed in the payload.
    assert.equal(res.body.result.structuredContent.limit, 1000);
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

  test("list_search_index returns filtered document rows", async () => {
    const deps = makeDeps({
      "/metagraph/search-index.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        documents: [
          {
            id: "subnet-7",
            kind: "subnet",
            netuid: 7,
            slug: "sn-7",
            title: "Subnet Seven",
          },
          {
            id: "provider-datura",
            kind: "provider",
            slug: "datura",
            title: "Datura",
          },
        ],
      },
    });
    const res = await callTool(
      "list_search_index",
      { q: "Subnet", limit: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.documents[0].netuid, 7);
  });

  test("list_search_index reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_search_index", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Search index snapshot unavailable/,
    );
  });

  test("list_search_index payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_search_index",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/search-index.json": {
        documents: [{ id: "subnet-7", title: "Subnet Seven" }],
      },
    });
    const res = await callTool("list_search_index", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_providers returns filtered provider rows", async () => {
    const deps = makeDeps({
      "/metagraph/providers.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        schema_version: 1,
        providers: [
          {
            id: "datura",
            kind: "data-provider",
            authority: "official",
            name: "Datura",
          },
          {
            id: "community-x",
            kind: "data-provider",
            authority: "community",
            name: "Community X",
          },
        ],
      },
    });
    const res = await callTool(
      "list_providers",
      { authority: "official", limit: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.providers[0].id, "datura");
    assert.equal(out.generated_at, "2026-07-01T00:00:00.000Z");
  });

  test("list_providers reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_providers", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Providers index unavailable/,
    );
  });

  test("list_providers payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_providers",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/providers.json": {
        providers: [{ id: "datura", kind: "data-provider", name: "Datura" }],
      },
    });
    const res = await callTool("list_providers", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function providersDeps() {
    return makeDeps({
      "/metagraph/providers.json": {
        generated_at: "2026-01-01T00:00:00Z",
        providers: [
          {
            id: "datura",
            kind: "data-provider",
            authority: "official",
            name: "Datura",
          },
          {
            id: "chutes",
            kind: "infrastructure-provider",
            authority: "official",
            name: "Chutes",
          },
          {
            id: "community-x",
            kind: "data-provider",
            authority: "community",
            name: "Community X",
          },
        ],
      },
    });
  }

  test("list_providers filters by id, kind, and authority", async () => {
    const deps = providersDeps();
    const byId = (await callTool("list_providers", { id: "chutes" }, { deps }))
      .body.result.structuredContent;
    assert.equal(byId.total, 1);
    assert.equal(byId.providers[0].name, "Chutes");

    const byKind = (
      await callTool(
        "list_providers",
        { kind: "infrastructure-provider" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.equal(byKind.total, 1);
    assert.equal(byKind.providers[0].id, "chutes");

    const byAuthority = (
      await callTool("list_providers", { authority: "official" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byAuthority.total, 2);
  });

  test("list_providers combines filters (AND) and reports total vs returned", async () => {
    const deps = providersDeps();
    const res = await callTool(
      "list_providers",
      { kind: "data-provider", authority: "community" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.providers[0].id, "community-x");
  });

  test("list_providers paginates the filtered list with limit/cursor", async () => {
    const deps = providersDeps();
    const res = await callTool(
      "list_providers",
      { sort: "name", order: "asc", limit: 1, cursor: 1 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 3);
    assert.equal(out.returned, 1);
    assert.equal(out.cursor, 1);
    assert.equal(out.providers[0].id, "community-x");
  });

  test("list_providers rejects an unknown kind/authority enum value", async () => {
    const deps = providersDeps();
    const badKind = await callTool(
      "list_providers",
      { kind: "not-a-kind" },
      { deps },
    );
    assert.equal(badKind.body.result.isError, true);

    const badAuthority = await callTool(
      "list_providers",
      { authority: "not-an-authority" },
      { deps },
    );
    assert.equal(badAuthority.body.result.isError, true);
  });

  test("list_providers is schema-stable when the artifact has no providers array", async () => {
    const deps = makeDeps({
      "/metagraph/providers.json": { generated_at: "2026-01-01T00:00:00Z" },
    });
    const res = await callTool("list_providers", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.providers, []);
    assert.equal(out.total, 0);
    assert.equal(out.returned, 0);
  });

  test("list_surfaces returns filtered surface rows", async () => {
    const deps = makeDeps({
      "/metagraph/surfaces.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        schema_version: 1,
        surfaces: [
          { netuid: 7, kind: "openapi", provider: "datura" },
          { netuid: 12, kind: "openapi", provider: "datura" },
        ],
      },
    });
    const res = await callTool(
      "list_surfaces",
      { netuid: 7, limit: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].netuid, 7);
    assert.equal(out.generated_at, "2026-07-01T00:00:00.000Z");
  });

  test("list_surfaces reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_surfaces", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Curated surfaces catalog unavailable/,
    );
  });

  test("list_surfaces payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_surfaces",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/surfaces.json": {
        surfaces: [{ netuid: 7, kind: "openapi", provider: "datura" }],
      },
    });
    const res = await callTool("list_surfaces", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  function surfacesDeps() {
    return makeDeps({
      "/metagraph/surfaces.json": {
        generated_at: "2026-01-01T00:00:00Z",
        surfaces: [
          { netuid: 7, kind: "openapi", provider: "datura" },
          { netuid: 7, kind: "subnet-api", provider: "chutes" },
          { netuid: 12, kind: "openapi", provider: "datura" },
        ],
      },
    });
  }

  test("list_surfaces filters by netuid, kind, and provider", async () => {
    const deps = surfacesDeps();
    const byNetuid = (await callTool("list_surfaces", { netuid: 12 }, { deps }))
      .body.result.structuredContent;
    assert.equal(byNetuid.total, 1);
    assert.equal(byNetuid.surfaces[0].provider, "datura");

    const byKind = (
      await callTool("list_surfaces", { kind: "subnet-api" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byKind.total, 1);
    assert.equal(byKind.surfaces[0].provider, "chutes");

    const byProvider = (
      await callTool("list_surfaces", { provider: "datura" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byProvider.total, 2);
  });

  test("list_surfaces combines filters (AND) and reports total vs returned", async () => {
    const deps = surfacesDeps();
    const res = await callTool(
      "list_surfaces",
      { netuid: 7, provider: "datura" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].kind, "openapi");
  });

  test("list_surfaces paginates the filtered list with limit/cursor", async () => {
    const deps = surfacesDeps();
    const res = await callTool(
      "list_surfaces",
      { sort: "provider", order: "asc", limit: 1, cursor: 1 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 3);
    assert.equal(out.returned, 1);
    assert.equal(out.cursor, 1);
    assert.equal(out.surfaces[0].provider, "datura");
    assert.equal(out.surfaces[0].netuid, 7);
  });

  test("list_surfaces rejects an unknown kind enum value", async () => {
    const deps = surfacesDeps();
    const res = await callTool(
      "list_surfaces",
      { kind: "not-a-kind" },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
  });

  test("list_surfaces is schema-stable when the artifact has no surfaces array", async () => {
    const deps = makeDeps({
      "/metagraph/surfaces.json": { generated_at: "2026-01-01T00:00:00Z" },
    });
    const res = await callTool("list_surfaces", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
    assert.equal(out.returned, 0);
  });

  test("list_candidates returns the candidates catalog artifact", async () => {
    const deps = makeDeps({
      "/metagraph/candidates.json": {
        generated_at: "2026-01-01T00:00:00Z",
        candidates: [{ netuid: 7, kind: "openapi", provider: "datura" }],
      },
    });
    const res = await callTool("list_candidates", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.candidates[0].netuid, 7);
    assert.equal(out.generated_at, "2026-01-01T00:00:00Z");
  });

  test("list_candidates rejects an unexpected argument", async () => {
    const res = await callTool("list_candidates", { bogus: 1 });
    assert.equal(res.body.result.isError, true);
  });

  function candidatesDeps() {
    return makeDeps({
      "/metagraph/candidates.json": {
        generated_at: "2026-01-01T00:00:00Z",
        candidates: [
          {
            netuid: 7,
            kind: "openapi",
            provider: "datura",
            state: "verified",
          },
          {
            netuid: 7,
            kind: "subnet-api",
            provider: "chutes",
            state: "schema-valid",
          },
          {
            netuid: 12,
            kind: "openapi",
            provider: "datura",
            state: "stale",
          },
        ],
      },
    });
  }

  test("list_candidates filters by netuid, kind, provider, and state", async () => {
    const deps = candidatesDeps();
    const byNetuid = (
      await callTool("list_candidates", { netuid: 12 }, { deps })
    ).body.result.structuredContent;
    assert.equal(byNetuid.total, 1);
    assert.equal(byNetuid.candidates[0].provider, "datura");

    const byKind = (
      await callTool("list_candidates", { kind: "subnet-api" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byKind.total, 1);
    assert.equal(byKind.candidates[0].provider, "chutes");

    const byProvider = (
      await callTool("list_candidates", { provider: "datura" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byProvider.total, 2);

    const byState = (
      await callTool("list_candidates", { state: "stale" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byState.total, 1);
    assert.equal(byState.candidates[0].netuid, 12);
  });

  test("list_candidates combines filters (AND) and reports total vs returned", async () => {
    const deps = candidatesDeps();
    const res = await callTool(
      "list_candidates",
      { netuid: 7, provider: "datura" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].kind, "openapi");
  });

  test("list_candidates paginates the filtered list with limit/offset", async () => {
    const deps = candidatesDeps();
    const res = await callTool(
      "list_candidates",
      { limit: 1, offset: 1 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 3);
    assert.equal(out.returned, 1);
    assert.equal(out.offset, 1);
    assert.equal(out.candidates[0].provider, "chutes");
  });

  test("list_candidates rejects an unknown kind/state enum value", async () => {
    const deps = candidatesDeps();
    const badKind = await callTool(
      "list_candidates",
      { kind: "not-a-kind" },
      { deps },
    );
    assert.equal(badKind.body.result.isError, true);
    assert.match(badKind.body.result.content[0].text, /invalid_params/);

    const badState = await callTool(
      "list_candidates",
      { state: "not-a-state" },
      { deps },
    );
    assert.equal(badState.body.result.isError, true);
  });

  test("list_candidates is schema-stable when the artifact has no candidates array", async () => {
    const deps = makeDeps({
      "/metagraph/candidates.json": { generated_at: "2026-01-01T00:00:00Z" },
    });
    const res = await callTool("list_candidates", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.candidates, []);
    assert.equal(out.total, 0);
    assert.equal(out.returned, 0);
  });

  test("list_endpoints returns the endpoints catalog artifact", async () => {
    const deps = makeDeps({
      "/metagraph/endpoints.json": {
        generated_at: "2026-01-01T00:00:00Z",
        endpoints: [{ netuid: 7, kind: "rest", provider: "datura" }],
      },
    });
    const res = await callTool("list_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].netuid, 7);
    assert.equal(out.generated_at, "2026-01-01T00:00:00Z");
  });

  test("list_endpoints rejects an unexpected argument", async () => {
    const deps = makeDeps({
      "/metagraph/endpoints.json": {
        generated_at: "2026-01-01T00:00:00Z",
        endpoints: [{ netuid: 7, kind: "rest", provider: "datura" }],
      },
    });
    const res = await callTool("list_endpoints", { bogus: 1 }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /invalid_params/);
  });

  function endpointsDeps() {
    return makeDeps({
      "/metagraph/endpoints.json": {
        generated_at: "2026-01-01T00:00:00Z",
        endpoints: [
          {
            netuid: 7,
            kind: "subnet-api",
            layer: "subnet-app",
            provider: "datura",
            publication_state: "monitored",
            status: "ok",
            pool_eligible: false,
          },
          {
            netuid: 7,
            kind: "openapi",
            layer: "docs-provider",
            provider: "chutes",
            publication_state: "verified",
            status: "degraded",
            pool_eligible: false,
          },
          {
            netuid: 12,
            kind: "subtensor-rpc",
            layer: "bittensor-base",
            provider: "datura",
            publication_state: "pool-eligible",
            status: "ok",
            pool_eligible: true,
          },
        ],
      },
    });
  }

  test("list_endpoints filters by kind, layer, netuid, provider, publication_state, status, pool_eligible", async () => {
    const deps = endpointsDeps();
    const byKind = (
      await callTool("list_endpoints", { kind: "openapi" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byKind.total, 1);
    assert.equal(byKind.endpoints[0].provider, "chutes");

    const byLayer = (
      await callTool("list_endpoints", { layer: "bittensor-base" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byLayer.total, 1);
    assert.equal(byLayer.endpoints[0].netuid, 12);

    const byNetuid = (await callTool("list_endpoints", { netuid: 7 }, { deps }))
      .body.result.structuredContent;
    assert.equal(byNetuid.total, 2);

    const byProvider = (
      await callTool("list_endpoints", { provider: "datura" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byProvider.total, 2);

    const byPubState = (
      await callTool(
        "list_endpoints",
        { publication_state: "verified" },
        { deps },
      )
    ).body.result.structuredContent;
    assert.equal(byPubState.total, 1);
    assert.equal(byPubState.endpoints[0].kind, "openapi");

    const byStatus = (
      await callTool("list_endpoints", { status: "degraded" }, { deps })
    ).body.result.structuredContent;
    assert.equal(byStatus.total, 1);

    const byPoolEligible = (
      await callTool("list_endpoints", { pool_eligible: true }, { deps })
    ).body.result.structuredContent;
    assert.equal(byPoolEligible.total, 1);
    assert.equal(byPoolEligible.endpoints[0].netuid, 12);
  });

  test("list_endpoints combines filters (AND) and reports total vs returned", async () => {
    const deps = endpointsDeps();
    const res = await callTool(
      "list_endpoints",
      { netuid: 7, status: "ok" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].provider, "datura");
  });

  test("list_endpoints paginates the filtered list with limit/offset", async () => {
    const deps = endpointsDeps();
    const res = await callTool(
      "list_endpoints",
      { limit: 1, offset: 1 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total, 3);
    assert.equal(out.returned, 1);
    assert.equal(out.offset, 1);
    assert.equal(out.endpoints[0].provider, "chutes");
  });

  test("list_endpoints rejects an unknown kind/layer/publication_state/status enum value", async () => {
    const deps = endpointsDeps();
    const badKind = await callTool(
      "list_endpoints",
      { kind: "not-a-kind" },
      { deps },
    );
    assert.equal(badKind.body.result.isError, true);

    const badLayer = await callTool(
      "list_endpoints",
      { layer: "not-a-layer" },
      { deps },
    );
    assert.equal(badLayer.body.result.isError, true);

    const badPubState = await callTool(
      "list_endpoints",
      { publication_state: "not-a-state" },
      { deps },
    );
    assert.equal(badPubState.body.result.isError, true);

    const badStatus = await callTool(
      "list_endpoints",
      { status: "not-a-status" },
      { deps },
    );
    assert.equal(badStatus.body.result.isError, true);
  });

  test("list_endpoints rejects a non-boolean pool_eligible", async () => {
    const deps = endpointsDeps();
    const res = await callTool(
      "list_endpoints",
      { pool_eligible: "yes" },
      { deps },
    );
    assert.equal(res.body.result.isError, true);
  });

  test("list_endpoints is schema-stable when the artifact has no endpoints array", async () => {
    const deps = makeDeps({
      "/metagraph/endpoints.json": { generated_at: "2026-01-01T00:00:00Z" },
    });
    const res = await callTool("list_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
    assert.equal(out.returned, 0);
  });

  test("list_evidence returns filtered claim rows", async () => {
    const deps = makeDeps({
      "/metagraph/evidence-ledger.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        schema_version: 1,
        summary: { claim_count: 2 },
        claims: [
          {
            subject: "SN7 openapi",
            claim: "SN7 publishes machine-readable OpenAPI",
            source_url: "https://example.com/openapi.json",
          },
          {
            subject: "SN8 website",
            claim: "SN8 website documents integration",
            source_url: "https://example.com/docs",
          },
        ],
      },
    });
    const res = await callTool(
      "list_evidence",
      { q: "openapi", limit: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.match(out.claims[0].claim, /OpenAPI/);
    assert.equal(out.generated_at, "2026-07-01T00:00:00.000Z");
  });

  test("list_evidence reports not_found when the artifact is absent", async () => {
    const res = await callTool("list_evidence", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Public evidence ledger snapshot unavailable/,
    );
  });

  test("list_evidence payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_evidence",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/evidence-ledger.json": {
        claims: [{ subject: "SN7", claim: "verified openapi" }],
      },
    });
    const res = await callTool("list_evidence", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_rpc_endpoints returns the rpc endpoints artifact", async () => {
    const deps = makeDeps({
      "/metagraph/rpc-endpoints.json": {
        generated_at: "2026-01-01T00:00:00Z",
        endpoints: [{ url: "wss://rpc.example", network: "finney" }],
      },
    });
    const res = await callTool("list_rpc_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].network, "finney");
    assert.equal(out.generated_at, "2026-01-01T00:00:00Z");
  });

  test("list_rpc_endpoints rejects an unexpected argument", async () => {
    const res = await callTool("list_rpc_endpoints", { netuid: 7 });
    assert.equal(res.body.result.isError, true);
  });

  test("list_source_snapshots returns filtered source rows", async () => {
    const deps = makeDeps({
      "/metagraph/source-snapshots.json": {
        generated_at: "2026-01-01T00:00:00Z",
        schema_version: 1,
        summary: { source_count: 2 },
        sources: [
          {
            id: "native-subnets",
            kind: "native",
            path: "/native/subnets",
            record_count: 42,
          },
          {
            id: "chain",
            kind: "chain",
            path: "/chain",
            record_count: 10,
          },
        ],
      },
    });
    const res = await callTool(
      "list_source_snapshots",
      { q: "native", limit: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.sources[0].id, "native-subnets");
    assert.equal(out.generated_at, "2026-01-01T00:00:00Z");
  });

  test("list_source_snapshots reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_source_snapshots",
      {},
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /Source snapshots ledger unavailable/,
    );
  });

  test("list_source_snapshots payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_source_snapshots",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/source-snapshots.json": {
        sources: [{ id: "chain", hash: "0xabc", record_count: 42 }],
      },
    });
    const res = await callTool("list_source_snapshots", { limit: 1 }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("list_profile_completeness returns the profile-completeness artifact", async () => {
    const deps = makeDeps({
      "/metagraph/review/profile-completeness.json": {
        generated_at: "2026-01-01T00:00:00Z",
        profiles: [{ netuid: 7, profile_level: "partial" }],
        summary: { profile_count: 1 },
      },
    });
    const res = await callTool("list_profile_completeness", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.profiles[0].netuid, 7);
    assert.equal(out.summary.profile_count, 1);
    assert.equal(out.generated_at, "2026-01-01T00:00:00Z");
  });

  test("list_profile_completeness rejects an unexpected argument", async () => {
    const res = await callTool("list_profile_completeness", { netuid: 7 });
    assert.equal(res.body.result.isError, true);
  });

  test("list_rpc_pools returns the rpc pools artifact", async () => {
    const deps = makeDeps({
      "/metagraph/rpc/pools.json": {
        generated_at: "2026-01-01T00:00:00Z",
        pools: [{ network: "finney", score: 0.98 }],
      },
    });
    const res = await callTool("list_rpc_pools", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.pools[0].network, "finney");
    assert.equal(out.generated_at, "2026-01-01T00:00:00Z");
  });

  test("list_rpc_pools overlays live RPC pool eligibility", async () => {
    const deps = makeDeps(
      {
        "/metagraph/rpc/pools.json": {
          generated_at: "2026-01-01T00:00:00Z",
          source: "build-prober",
          pools: [
            {
              network: "finney",
              endpoints: [
                {
                  id: "attacker-wrong-chain",
                  status: "ok",
                  health_source: "build-prober",
                  pool_eligible: true,
                },
              ],
            },
          ],
        },
      },
      {
        [KV_HEALTH_RPC_POOL]: {
          last_run_at: "2026-01-01T00:15:00Z",
          endpoints: [
            {
              id: "attacker-wrong-chain",
              status: "ok",
              classification: "wrong-chain",
              latency_ms: 321,
              latest_block: 12345,
            },
          ],
        },
      },
    );
    const res = await callTool("list_rpc_pools", {}, { deps });
    const out = res.body.result.structuredContent;
    const endpoint = out.pools[0].endpoints[0];
    assert.equal(out.source, "live-cron-prober");
    assert.equal(out.operational_observed_at, "2026-01-01T00:15:00Z");
    assert.equal(endpoint.pool_eligible, false);
    assert.equal(endpoint.health_source, "live-cron-prober");
    assert.equal(endpoint.latency_ms, 321);
    assert.equal(endpoint.latest_block, 12345);
  });

  test("list_rpc_pools falls back to the static pools when no readHealthKv dep is provided", async () => {
    const depsNoKvFn = {
      readArtifact() {
        return Promise.resolve({
          ok: true,
          data: {
            generated_at: "2026-01-01T00:00:00Z",
            source: "build-prober",
            pools: [{ network: "finney", endpoints: [] }],
          },
        });
      },
    };
    const res = await callTool("list_rpc_pools", {}, { deps: depsNoKvFn });
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "build-prober");
  });

  test("list_rpc_pools falls back to the static pools when the live snapshot has no endpoints array", async () => {
    const deps = makeDeps(
      {
        "/metagraph/rpc/pools.json": {
          generated_at: "2026-01-01T00:00:00Z",
          source: "build-prober",
          pools: [{ network: "finney", endpoints: [] }],
        },
      },
      { [KV_HEALTH_RPC_POOL]: { last_run_at: "2026-01-01T00:15:00Z" } },
    );
    const res = await callTool("list_rpc_pools", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "build-prober");
  });

  test("list_rpc_pools falls back to the static artifact when its pools field is not an array", async () => {
    const deps = makeDeps(
      {
        "/metagraph/rpc/pools.json": {
          generated_at: "2026-01-01T00:00:00Z",
          source: "build-prober",
          pools: { 0: { network: "finney", endpoints: [] } },
        },
      },
      {
        [KV_HEALTH_RPC_POOL]: {
          last_run_at: "2026-01-01T00:15:00Z",
          endpoints: [{ id: "a", status: "ok" }],
        },
      },
    );
    const res = await callTool("list_rpc_pools", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "build-prober");
  });

  test("list_rpc_pools reports operational_observed_at:null when the live snapshot has no last_run_at", async () => {
    const deps = makeDeps(
      {
        "/metagraph/rpc/pools.json": {
          generated_at: "2026-01-01T00:00:00Z",
          pools: [{ network: "finney", endpoints: [] }],
        },
      },
      { [KV_HEALTH_RPC_POOL]: { endpoints: [{ id: "a", status: "ok" }] } },
    );
    const res = await callTool("list_rpc_pools", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "live-cron-prober");
    assert.equal(out.operational_observed_at, null);
  });

  test("list_rpc_pools rejects an unexpected argument", async () => {
    const res = await callTool("list_rpc_pools", { netuid: 7 });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_endpoints returns one subnet's endpoints artifact", async () => {
    const deps = makeDeps({
      "/metagraph/endpoints/5.json": {
        generated_at: "2026-01-01T00:00:00Z",
        netuid: 5,
        endpoints: [{ kind: "rest", provider: "datura" }],
      },
    });
    const res = await callTool("get_subnet_endpoints", { netuid: 5 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 5);
    assert.equal(out.endpoints[0].kind, "rest");
  });

  test("get_subnet_endpoints rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_endpoints", {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_candidates returns one subnet's candidates artifact", async () => {
    const deps = makeDeps({
      "/metagraph/candidates/5.json": {
        generated_at: "2026-01-01T00:00:00Z",
        netuid: 5,
        candidates: [{ kind: "openapi", provider: "datura" }],
      },
    });
    const res = await callTool(
      "get_subnet_candidates",
      { netuid: 5 },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 5);
    assert.equal(out.candidates[0].kind, "openapi");
  });

  test("get_subnet_candidates rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_candidates", {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_evidence returns one subnet's evidence artifact", async () => {
    const deps = makeDeps({
      "/metagraph/evidence/5.json": {
        generated_at: "2026-01-01T00:00:00Z",
        netuid: 5,
        claims: [{ check: "openapi", outcome: "verified" }],
      },
    });
    const res = await callTool("get_subnet_evidence", { netuid: 5 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 5);
    assert.equal(out.claims[0].outcome, "verified");
  });

  test("get_subnet_evidence rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_evidence", {});
    assert.equal(res.body.result.isError, true);
  });

  test("list_subnet_evidence returns filtered claim rows", async () => {
    const deps = makeDeps({
      "/metagraph/evidence/7.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        netuid: 7,
        claims: [
          {
            subject: "SN7 openapi",
            claim: "SN7 publishes machine-readable OpenAPI",
          },
          {
            subject: "SN7 website",
            claim: "SN7 website documents integration",
          },
        ],
      },
    });
    const res = await callTool(
      "list_subnet_evidence",
      { netuid: 7, q: "openapi" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.match(out.claims[0].claim, /OpenAPI/);
    assert.equal(out.netuid, 7);
  });

  test("list_subnet_evidence reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "list_subnet_evidence",
      { netuid: 7 },
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /No evidence snapshot exists for netuid 7/,
    );
  });

  test("list_subnet_evidence payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "list_subnet_evidence",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/evidence/7.json": {
        generated_at: "2026-07-01T00:00:00.000Z",
        netuid: 7,
        claims: [{ subject: "SN7", claim: "verified openapi" }],
      },
    });
    const res = await callTool(
      "list_subnet_evidence",
      { netuid: 7, limit: 1 },
      { deps },
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_subnet_surfaces returns one subnet's surfaces artifact", async () => {
    const deps = makeDeps({
      "/metagraph/surfaces/5.json": {
        generated_at: "2026-01-01T00:00:00Z",
        netuid: 5,
        surfaces: [{ kind: "openapi", provider: "datura" }],
      },
    });
    const res = await callTool("get_subnet_surfaces", { netuid: 5 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 5);
    assert.equal(out.surfaces[0].kind, "openapi");
  });

  test("get_subnet_surfaces rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_surfaces", {});
    assert.equal(res.body.result.isError, true);
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

  test("get_contracts returns the contracts artifact", async () => {
    const deps = makeDeps({
      "/metagraph/contracts.json": {
        schema_version: 1,
        contract_version: "2026-07-03.2",
        artifacts: [{ id: "subnets", path: "/metagraph/subnets.json" }],
      },
    });
    const res = await callTool("get_contracts", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.schema_version, 1);
    assert.equal(out.artifacts[0].id, "subnets");
  });

  test("get_contracts reports not_found when the artifact is absent", async () => {
    const res = await callTool("get_contracts", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /unavailable in this environment/,
    );
  });

  test("get_contracts payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_contracts",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/contracts.json": {
        schema_version: 1,
        artifacts: [{ id: "contracts", path: "/metagraph/contracts.json" }],
      },
    });
    const res = await callTool("get_contracts", {}, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
  });

  test("get_adapter returns the adapter snapshot artifact", async () => {
    const deps = makeDeps({
      "/metagraph/adapters/gittensor.json": {
        schema_version: 1,
        slug: "gittensor",
        netuid: 74,
        snapshot: { status: "captured" },
        extensions: { generic_adapter: { kind: "generic-openapi" } },
      },
    });
    const res = await callTool("get_adapter", { slug: "gittensor" }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.slug, "gittensor");
    assert.equal(out.netuid, 74);
    assert.equal(out.snapshot.status, "captured");
  });

  test("get_adapter reports not_found when the artifact is absent", async () => {
    const res = await callTool(
      "get_adapter",
      { slug: "missing" },
      { deps: makeDeps() },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /No adapter snapshot exists/i,
    );
  });

  test("get_adapter rejects invalid slug characters", async () => {
    const deps = makeDeps({
      "/metagraph/adapters/gittensor.json": {
        schema_version: 1,
        slug: "gittensor",
      },
    });
    const res = await callTool("get_adapter", { slug: "Gittensor" }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /slug must match/);
  });

  test("get_adapter rejects a missing slug argument", async () => {
    const res = await callTool("get_adapter", {}, { deps: makeDeps() });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /slug/i);
  });

  test("get_adapter payload validates against its declared outputSchema", async () => {
    const schema = listToolDefinitions().find(
      (t) => t.name === "get_adapter",
    )?.outputSchema;
    const deps = makeDeps({
      "/metagraph/adapters/gittensor.json": {
        schema_version: 1,
        slug: "gittensor",
        netuid: 74,
        snapshot: { status: "captured" },
      },
    });
    const res = await callTool("get_adapter", { slug: "gittensor" }, { deps });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.ok(validate(res.body.result.structuredContent));
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

// Read-only MCP tools for webhook subscriptions + chain alert triggers, added
// after the 2026-07-14/15 exhaustive audit found neither had any MCP
// presence despite REST support -- deliberately scoped to GET-by-known-id
// only (no create/delete), matching the exact auth posture of the REST
// routes they mirror so no new exposure is introduced (#5589/#5590).
describe("MCP webhook/alert-trigger read tools (2026-07-14/15 audit follow-up)", () => {
  function makeControlKv(records = {}) {
    return {
      async get(key, opts) {
        const value = records[key];
        if (value === undefined) return null;
        return opts?.type === "json" ? value : JSON.stringify(value);
      },
      async list() {
        return { keys: [] };
      },
    };
  }

  test("get_webhook_subscription returns the public view + delivery status for a known id, never the secret", async () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const env = {
      METAGRAPH_CONTROL: makeControlKv({
        [`webhooks:sub:${id}`]: {
          id,
          url: "https://hooks.example.com/mg",
          secret: "should-never-be-returned",
          filters: { kinds: ["subnet.updated"] },
          created_at: "2026-07-01T00:00:00.000Z",
          active: true,
        },
      }),
    };
    const res = await callTool("get_webhook_subscription", { id }, { env });
    assert.equal(res.body.result.isError, false);
    const out = res.body.result.structuredContent;
    assert.equal(out.id, id);
    assert.equal(out.url, "https://hooks.example.com/mg");
    assert.equal(out.secret, undefined);
    assert.equal(out.active, true);
    assert.deepEqual(out.filters, { kinds: ["subnet.updated"] });
    assert.equal(out.delivery.status, "ok");
    assert.equal(out.delivery.pending, 0);
    assert.equal(out.delivery.dead_letter, 0);
  });

  test("get_webhook_subscription treats a KV read failure the same as not-found rather than throwing", async () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("KV unavailable");
        },
      },
    };
    const res = await callTool("get_webhook_subscription", { id }, { env });
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
  });

  test("get_webhook_subscription surfaces a not_found tool error (not a thrown exception) for an unknown id", async () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const env = { METAGRAPH_CONTROL: makeControlKv({}) };
    const res = await callTool("get_webhook_subscription", { id }, { env });
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
  });

  test("get_webhook_subscription rejects a malformed id before touching KV", async () => {
    const res = await callTool(
      "get_webhook_subscription",
      { id: "not-a-uuid" },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "invalid_params",
    );
  });

  test("get_webhook_subscription returns webhooks_unavailable when METAGRAPH_CONTROL is unbound", async () => {
    const res = await callTool(
      "get_webhook_subscription",
      { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "webhooks_unavailable",
    );
  });

  test("get_alert_trigger forwards the id + owner_token to DATA_API and relays the response", async () => {
    let capturedPath;
    let capturedToken;
    const env = {
      DATA_API: {
        fetch: async (req) => {
          const url = new URL(req.url);
          capturedPath = url.pathname;
          capturedToken = req.headers.get("x-alert-trigger-owner-token");
          return Response.json({
            id: "trigger-1",
            name: "Big stake moves",
            channel: "discord",
            destination: "https://discord.example/webhook",
            active: true,
            match_count: 3,
          });
        },
      },
    };
    const res = await callTool(
      "get_alert_trigger",
      { id: "trigger-1", owner_token: "owner-secret" },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(capturedPath, "/api/v1/alerts/triggers/trigger-1");
    assert.equal(capturedToken, "owner-secret");
    assert.equal(res.body.result.structuredContent.name, "Big stake moves");
    assert.equal(res.body.result.structuredContent.match_count, 3);
  });

  test("get_alert_trigger surfaces a not_found tool error for a wrong owner_token or unknown id (same 404 as REST, no enumeration oracle)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ error: "no such trigger" }, { status: 404 }),
      },
    };
    const res = await callTool(
      "get_alert_trigger",
      { id: "trigger-1", owner_token: "wrong" },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.structuredContent.error.code, "not_found");
  });

  test("get_alert_trigger returns alert_triggers_unavailable when the upstream response body is unreadable", async () => {
    const env = {
      DATA_API: {
        fetch: async () => new Response("not json", { status: 200 }),
      },
    };
    const res = await callTool(
      "get_alert_trigger",
      { id: "trigger-1", owner_token: "token" },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "alert_triggers_unavailable",
    );
  });

  test("get_alert_trigger returns alert_triggers_unavailable when DATA_API is unbound", async () => {
    const res = await callTool(
      "get_alert_trigger",
      { id: "trigger-1", owner_token: "token" },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "alert_triggers_unavailable",
    );
  });

  test("get_alert_trigger rejects a missing owner_token", async () => {
    const res = await callTool(
      "get_alert_trigger",
      { id: "trigger-1" },
      { env: {} },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "invalid_params",
    );
  });

  test("get_alert_trigger falls back to the generic error message when the upstream error field is not a string", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ error: { unexpected: "shape" } }, { status: 500 }),
      },
    };
    const res = await callTool(
      "get_alert_trigger",
      { id: "trigger-1", owner_token: "token" },
      { env },
    );
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "alert_trigger_error",
    );
    assert.equal(
      res.body.result.structuredContent.error.message,
      "The alert triggers tier returned an error.",
    );
  });

  // readMcpWebhookDeliveryStatus (src/mcp-server.mjs) is a best-effort helper --
  // the tests above only exercise its happy path (a working `.list` returning no
  // keys). These target its other branches directly: no `.list` method at all, a
  // `.list` that throws, and a `.list` that returns real keys worth `.get`-ing.
  test("get_webhook_subscription degrades delivery status to empty when METAGRAPH_CONTROL has no list method", async () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const env = {
      METAGRAPH_CONTROL: {
        async get(key, opts) {
          if (key !== `webhooks:sub:${id}`) return null;
          const record = {
            id,
            url: "https://hooks.example.com/mg",
            secret: "s",
            filters: {},
            created_at: "2026-07-01T00:00:00.000Z",
            active: true,
          };
          return opts?.type === "json" ? record : JSON.stringify(record);
        },
        // No `list` method -- matches an older/partial KV mock shape.
      },
    };
    const res = await callTool("get_webhook_subscription", { id }, { env });
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(res.body.result.structuredContent.delivery, {
      status: "ok",
      pending: 0,
      dead_letter: 0,
      last_failure: null,
    });
  });

  test("get_webhook_subscription degrades delivery status to empty when listing delivery records throws", async () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const env = {
      METAGRAPH_CONTROL: {
        async get(key, opts) {
          if (key !== `webhooks:sub:${id}`) return null;
          const record = {
            id,
            url: "https://hooks.example.com/mg",
            secret: "s",
            filters: {},
            created_at: "2026-07-01T00:00:00.000Z",
            active: true,
          };
          return opts?.type === "json" ? record : JSON.stringify(record);
        },
        async list() {
          throw new Error("KV list unavailable");
        },
      },
    };
    const res = await callTool("get_webhook_subscription", { id }, { env });
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(res.body.result.structuredContent.delivery, {
      status: "ok",
      pending: 0,
      dead_letter: 0,
      last_failure: null,
    });
  });

  test("get_webhook_subscription summarizes real delivery records returned by list", async () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const subKey = `webhooks:sub:${id}`;
    const deliveryKey = `webhooks:delivery:${id}:evt-1`;
    const deliveryRecord = {
      state: "dead",
      last_attempt_at: "2026-07-14T00:00:00.000Z",
    };
    const env = {
      METAGRAPH_CONTROL: {
        async get(key, opts) {
          const value =
            key === subKey
              ? {
                  id,
                  url: "https://hooks.example.com/mg",
                  secret: "s",
                  filters: {},
                  created_at: "2026-07-01T00:00:00.000Z",
                  active: true,
                }
              : key === deliveryKey
                ? deliveryRecord
                : null;
          if (value === null) return null;
          return opts?.type === "json" ? value : JSON.stringify(value);
        },
        async list({ prefix }) {
          assert.equal(prefix, `webhooks:delivery:${id}:`);
          return { keys: [{ name: deliveryKey }] };
        },
      },
    };
    const res = await callTool("get_webhook_subscription", { id }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(
      res.body.result.structuredContent.delivery.status,
      "dead_letter",
    );
    assert.equal(res.body.result.structuredContent.delivery.dead_letter, 1);
    assert.equal(res.body.result.structuredContent.delivery.pending, 0);
  });
});

// MCP feature-parity tools (#5225): validator detail/nominators/history, subnet
// hyperparameters/volume/recycled, account identity/position-history,
// sudo/governance-config feeds, the runtime spec-version timeline, and the
// site-wide accounts leaderboard. Each mirrors an existing REST route the MCP
// surface was previously missing.
describe("MCP validator detail/nominators/history tools (#5225 parity)", () => {
  const HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  // neurons' D1 write path is retired (#4772) and the table is dropped in
  // production, so all three tools always rank over a schema-stable empty
  // base (buildValidatorDetail/buildValidatorNominators/buildValidatorHistory
  // called with []) -- row-shaping over real rows is covered directly against
  // the pure builders in tests/validator-nominators.test.mjs and
  // tests/validator-history.test.mjs; this only proves the MCP wiring.
  test("get_validator_detail returns a schema-stable zeroed aggregate", async () => {
    const res = await callTool("get_validator_detail", { hotkey: HOTKEY });
    const out = res.body.result.structuredContent;
    assert.equal(out.hotkey, HOTKEY);
    assert.equal(out.coldkey, null);
    assert.equal(out.subnet_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.take, null);
  });

  test("get_validator_detail rejects a missing/invalid hotkey", async () => {
    const missing = await callTool("get_validator_detail", {});
    assert.equal(missing.body.result.isError, true);

    const bad = await callTool("get_validator_detail", { hotkey: "not-ss58" });
    assert.equal(bad.body.result.isError, true);
    assert.match(bad.body.result.content[0].text, /ss58/i);
  });

  // compare_validators (#6035): a read-only side-by-side of several validators
  // for a stake/delegate decision, one get_validator_detail-shaped load per
  // hotkey, projected to take/APY/nominator-count/identity + aggregates.
  const HOTKEY2 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc6";

  test("compare_validators returns a schema-stable comparison over the empty base", async () => {
    const res = await callTool("compare_validators", {
      hotkeys: [HOTKEY, HOTKEY2],
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, null);
    assert.equal(out.validator_count, 2);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      [HOTKEY, HOTKEY2],
    );
    // Cold base: the decision fields resolve to their null aggregates.
    assert.equal(out.validators[0].take, null);
    assert.equal(out.validators[0].coldkey_identity, null);
    assert.equal(out.validators[0].apy_estimate, null);
    assert.equal(out.validators[0].subnet_context, null);
  });

  test("compare_validators dedupes repeated hotkeys", async () => {
    const res = await callTool("compare_validators", {
      hotkeys: [HOTKEY, HOTKEY, HOTKEY2],
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.validator_count, 2);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      [HOTKEY, HOTKEY2],
    );
  });

  test("compare_validators output carries no transaction/signing fields", async () => {
    const res = await callTool("compare_validators", { hotkeys: [HOTKEY] });
    const keys = [];
    const walk = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(res.body.result.structuredContent);
    const forbidden =
      /sign|signature|transaction|extrinsic|mnemonic|seed|private|wallet|custody/i;
    const offending = keys.filter((key) => forbidden.test(key));
    assert.deepEqual(offending, [], `unexpected fields: ${offending}`);
  });

  test("compare_validators: flag=postgres projects each detail and extracts the netuid subnet_context", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const hotkey = decodeURIComponent(
            new URL(req.url).pathname.split("/").pop(),
          );
          return Response.json({
            schema_version: 1,
            hotkey,
            coldkey: "5Cold",
            coldkey_identity: { has_identity: true, name: "Alice" },
            take: 0.18,
            apy_estimate: 0.2,
            apy_estimate_eligible_subnet_count: 1,
            nominator_count: 42,
            total_stake_tao: 1000,
            total_emission_tao: 5,
            avg_validator_trust: 0.9,
            max_validator_trust: 0.99,
            subnet_count: 1,
            subnets: [{ netuid: 7, uid: 3, stake_tao: 800 }],
          });
        },
      },
    };
    const res = await callTool(
      "compare_validators",
      { hotkeys: [HOTKEY], netuid: 7 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.validators[0].take, 0.18);
    assert.equal(out.validators[0].nominator_count, 42);
    assert.deepEqual(out.validators[0].coldkey_identity, {
      has_identity: true,
      name: "Alice",
    });
    assert.deepEqual(out.validators[0].subnet_context, {
      netuid: 7,
      uid: 3,
      stake_tao: 800,
    });
    // The raw detail's subnets[] is not passed through -- only the projection.
    assert.equal(out.validators[0].subnets, undefined);
  });

  test("compare_validators: flag=postgres falls back to the empty base on failure", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "compare_validators",
      { hotkeys: [HOTKEY] },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.validator_count, 1);
    assert.equal(out.validators[0].take, null);
  });

  test("compare_validators rejects missing/empty/malformed hotkey lists", async () => {
    const missing = await callTool("compare_validators", {});
    assert.equal(missing.body.result.isError, true);
    assert.match(missing.body.result.content[0].text, /hotkeys/);

    const empty = await callTool("compare_validators", { hotkeys: [] });
    assert.equal(empty.body.result.isError, true);

    const nonString = await callTool("compare_validators", { hotkeys: [123] });
    assert.equal(nonString.body.result.isError, true);

    const badSs58 = await callTool("compare_validators", {
      hotkeys: [HOTKEY, "not-ss58"],
    });
    assert.equal(badSs58.body.result.isError, true);

    // More than COMPARE_VALIDATORS_MAX (16) distinct valid hotkeys.
    const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const base = HOTKEY.slice(0, -1);
    const tooMany = Array.from({ length: 17 }, (_, i) => base + b58[i]);
    const over = await callTool("compare_validators", { hotkeys: tooMany });
    assert.equal(over.body.result.isError, true);
    assert.match(over.body.result.content[0].text, /hotkeys/);
  });

  test("compare_validators rejects an invalid netuid", async () => {
    const negative = await callTool("compare_validators", {
      hotkeys: [HOTKEY],
      netuid: -1,
    });
    assert.equal(negative.body.result.isError, true);

    const nonInt = await callTool("compare_validators", {
      hotkeys: [HOTKEY],
      netuid: "seven",
    });
    assert.equal(nonInt.body.result.isError, true);
    assert.match(nonInt.body.result.content[0].text, /netuid/);
  });

  test("get_validator_nominators returns a schema-stable empty ranked list with defaults", async () => {
    const res = await callTool("get_validator_nominators", { hotkey: HOTKEY });
    const out = res.body.result.structuredContent;
    assert.equal(out.hotkey, HOTKEY);
    assert.equal(out.window, "30d");
    assert.equal(out.sort, "net_staked");
    assert.equal(out.limit, 20);
    assert.equal(out.offset, 0);
    assert.equal(out.nominator_count, 0);
    assert.deepEqual(out.nominators, []);
  });

  test("get_validator_nominators accepts each window/sort and an explicit coldkey", async () => {
    for (const window of ["7d", "30d", "90d"]) {
      const res = await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        window,
      });
      assert.equal(res.body.result.structuredContent.window, window);
    }
    for (const sort of ["net_staked", "gross_staked", "last_activity"]) {
      const res = await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        sort,
      });
      assert.equal(res.body.result.structuredContent.sort, sort);
    }
    const withColdkey = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      coldkey: HOTKEY,
    });
    assert.equal(withColdkey.body.result.isError, false);
  });

  test("get_validator_nominators rejects an invalid window/sort/coldkey", async () => {
    const badWindow = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      window: "5d",
    });
    assert.equal(badWindow.body.result.isError, true);

    const badSort = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      sort: "bogus",
    });
    assert.equal(badSort.body.result.isError, true);

    const badColdkey = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      coldkey: "not-ss58",
    });
    assert.equal(badColdkey.body.result.isError, true);
    assert.match(badColdkey.body.result.content[0].text, /coldkey/);
  });

  test("get_validator_nominators: flag=postgres unwraps the DATA_API {data, generatedAt} envelope onto the top level", async () => {
    // workers/data-api.mjs's own nominators route wraps its response as
    // { data: buildValidatorNominators(...), generatedAt } -- unlike the
    // flat-shaped neurons-tier routes. Assert hotkey/nominator_count/
    // nominators land at the TOP of structuredContent (matching this tool's
    // own outputSchema), not nested under .data, so a future regression to a
    // bare `tryPostgresTier(...) ?? builder(...)` (no unwrap) fails loudly
    // here instead of only violating the schema silently in production.
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              hotkey: HOTKEY,
              window: "30d",
              sort: "net_staked",
              limit: 20,
              offset: 0,
              nominator_count: 1,
              nominators: [
                {
                  coldkey: "5Cold",
                  net_staked_tao: 10,
                  gross_staked_tao: 10,
                  unstaked_tao: 0,
                  event_count: 1,
                  last_observed_at: "2026-07-01T00:00:00.000Z",
                },
              ],
            },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_validator_nominators",
      { hotkey: HOTKEY },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.data, undefined);
    assert.equal(out.hotkey, HOTKEY);
    assert.equal(out.nominator_count, 1);
    assert.equal(out.nominators[0].coldkey, "5Cold");
  });

  test("get_validator_history returns a schema-stable empty point series", async () => {
    const res = await callTool("get_validator_history", { hotkey: HOTKEY });
    const out = res.body.result.structuredContent;
    assert.equal(out.hotkey, HOTKEY);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("get_validator_history accepts every REST-supported window", async () => {
    for (const window of ["7d", "30d", "90d", "1y", "all"]) {
      const res = await callTool("get_validator_history", {
        hotkey: HOTKEY,
        window,
      });
      assert.equal(res.body.result.structuredContent.window, window);
    }
  });

  test("get_validator_history rejects an unknown window", async () => {
    const res = await callTool("get_validator_history", {
      hotkey: HOTKEY,
      window: "5d",
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /window/);
  });
});

describe("MCP subnet hyperparams/volume/recycled tools (#5225 parity)", () => {
  test("get_subnet_hyperparams returns hyperparameters:null when never captured", async () => {
    const res = await callTool("get_subnet_hyperparams", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.hyperparameters, null);
    assert.equal(out.captured_at, null);
    assert.equal(out.block_number, null);
  });

  test("get_subnet_hyperparams rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_hyperparams", {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_hyperparams_history returns a schema-stable empty timeline", async () => {
    const res = await callTool("get_subnet_hyperparams_history", {
      netuid: 7,
      limit: 10,
      offset: 5,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.entry_count, 0);
    assert.deepEqual(out.entries, []);
    assert.equal(out.limit, 10);
    assert.equal(out.offset, 5);
  });

  test("get_subnet_hyperparams_history rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_hyperparams_history", {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_volume reports zeroed 24h volume with a null vol_mcap_ratio when market cap is absent", async () => {
    const deps = makeDeps({
      "/metagraph/economics.json": {
        captured_at: "2026-01-01T00:00:00Z",
        summary: {},
        subnets: [{ netuid: 7 }],
      },
    });
    const res = await callTool("get_subnet_volume", { netuid: 7 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "24h");
    assert.equal(out.buy_volume_alpha, 0);
    assert.equal(out.sell_volume_alpha, 0);
    assert.equal(out.total_volume_tao, 0);
    assert.equal(out.buy_count, 0);
    assert.equal(out.sentiment, "neutral");
    assert.equal(out.vol_mcap_ratio, null);
  });

  test("get_subnet_volume surfaces not_found when the economics artifact is absent", async () => {
    const res = await callTool("get_subnet_volume", { netuid: 7 }, {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_volume rejects a missing netuid", async () => {
    const deps = makeDeps({
      "/metagraph/economics.json": { subnets: [] },
    });
    const res = await callTool("get_subnet_volume", {}, { deps });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_ohlc returns a schema-stable empty candle array with no Postgres tier bound", async () => {
    const res = await callTool("get_subnet_ohlc", { netuid: 7 });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.interval, "1h");
    assert.deepEqual(out.candles, []);
    assert.equal(out.root_excluded, false);
  });

  test("get_subnet_ohlc rejects a missing netuid", async () => {
    const res = await callTool("get_subnet_ohlc", {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_ohlc rejects an unsupported interval", async () => {
    const res = await callTool("get_subnet_ohlc", {
      netuid: 7,
      interval: "5m",
    });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_ohlc accepts interval=1d", async () => {
    const res = await callTool("get_subnet_ohlc", {
      netuid: 7,
      interval: "1d",
    });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.interval, "1d");
  });

  test("get_subnet_ohlc rejects a days value beyond the max lookback", async () => {
    const res = await callTool("get_subnet_ohlc", { netuid: 7, days: 9999 });
    assert.equal(res.body.result.isError, true);
  });

  test("get_subnet_ohlc reports root_excluded:true for netuid 0", async () => {
    const res = await callTool("get_subnet_ohlc", { netuid: 0 });
    const out = res.body.result.structuredContent;
    assert.equal(out.root_excluded, true);
    assert.deepEqual(out.candles, []);
  });

  test("get_subnet_recycled returns recycled_tao:0 for genuinely unset storage", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
    });
    try {
      const res = await callTool("get_subnet_recycled", { netuid: 7 }, {});
      const out = res.body.result.structuredContent;
      assert.equal(out.netuid, 7);
      assert.equal(out.recycled_tao, 0);
      assert.ok(out.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_subnet_recycled returns recycled_tao:null on RPC failure", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("rpc down");
    };
    try {
      const res = await callTool("get_subnet_recycled", { netuid: 7 }, {});
      assert.equal(res.body.result.structuredContent.recycled_tao, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_subnet_recycled rejects a netuid outside the u16 range", async () => {
    const res = await callTool("get_subnet_recycled", { netuid: 70000 }, {});
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /u16/);
  });

  test("get_subnet_recycled applies the RPC rate limiter before the finney fetch", async () => {
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
      const res = await callTool("get_subnet_recycled", { netuid: 7 }, { env });
      assert.equal(res.body.result.isError, true);
      assert.match(res.body.result.content[0].text, /rate_limited/);
      assert.equal(limiterKey, "recycled:mcp:anonymous");
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("MCP account identity/position-history tools (#5225 parity)", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  function accountIdentityD1({ identity, identityHistory } = {}, capture = []) {
    return {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              capture.push({ sql, params });
              return {
                all() {
                  if (/FROM account_identity_history/.test(sql))
                    return Promise.resolve({ results: identityHistory || [] });
                  if (/FROM account_identity WHERE/.test(sql))
                    return Promise.resolve({ results: identity || [] });
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
  }

  test("get_account_identity returns has_identity:false on cold D1", async () => {
    const res = await callTool("get_account_identity", { ss58: SS58 });
    const out = res.body.result.structuredContent;
    assert.equal(out.account, SS58);
    assert.equal(out.has_identity, false);
    assert.equal(out.name, null);
    assert.equal(out.captured_at, null);
  });

  test("get_account_identity returns the real identity from D1", async () => {
    const env = accountIdentityD1({
      identity: [
        {
          account: SS58,
          name: "Alice",
          url: "https://alice.example",
          github: "https://github.com/alice",
          image: null,
          discord: "alice#0001",
          description: "validator",
          additional: null,
          captured_at: 1_700_000_000_000,
        },
      ],
    });
    const res = await callTool("get_account_identity", { ss58: SS58 }, { env });
    const out = res.body.result.structuredContent;
    assert.equal(out.has_identity, true);
    assert.equal(out.name, "Alice");
    assert.equal(out.github, "https://github.com/alice");
    assert.ok(out.captured_at);
  });

  test("get_account_identity rejects an invalid ss58", async () => {
    const res = await callTool("get_account_identity", { ss58: "not-ss58" });
    assert.equal(res.body.result.isError, true);
  });

  describe("get_account_identity D1 -> Postgres serving cutover", () => {
    test("flag=postgres uses Postgres data, D1 never queried", async () => {
      const capture = [];
      const env = {
        ...accountIdentityD1({ identity: [] }, capture),
        METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              account: SS58,
              has_identity: true,
              name: "PgAlice",
            }),
        },
      };
      const res = await callTool(
        "get_account_identity",
        { ss58: SS58 },
        { env },
      );
      assert.equal(res.body.result.structuredContent.name, "PgAlice");
      assert.deepEqual(capture, []);
    });

    test("flag=postgres falls back to D1 on failure", async () => {
      const env = {
        ...accountIdentityD1({
          identity: [{ account: SS58, name: "D1Alice", captured_at: 1 }],
        }),
        METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(
        "get_account_identity",
        { ss58: SS58 },
        { env },
      );
      assert.equal(res.body.result.structuredContent.name, "D1Alice");
    });
  });

  test("get_account_identity_history returns an empty timeline on cold D1", async () => {
    const res = await callTool("get_account_identity_history", {
      ss58: SS58,
      limit: 10,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.account, SS58);
    assert.equal(out.entry_count, 0);
    assert.deepEqual(out.entries, []);
    assert.equal(out.limit, 10);
  });

  test("get_account_identity_history returns the real timeline from D1", async () => {
    const env = accountIdentityD1({
      identityHistory: [
        {
          id: 2,
          observed_at: 1_700_000_000_000,
          name: "Alice",
          url: null,
          github: null,
          image: null,
          discord: null,
          description: null,
          additional: null,
          identity_hash: "hash-1",
        },
      ],
    });
    const res = await callTool(
      "get_account_identity_history",
      { ss58: SS58 },
      { env },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.entry_count, 1);
    assert.equal(out.entries[0].identity_hash, "hash-1");
    assert.equal(out.entries[0].name, "Alice");
  });

  describe("get_account_identity_history D1 -> Postgres serving cutover", () => {
    test("flag=postgres uses Postgres data, D1 never queried", async () => {
      const capture = [];
      const env = {
        ...accountIdentityD1({ identityHistory: [] }, capture),
        METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              account: SS58,
              entry_count: 1,
              entries: [{ identity_hash: "pg-hash" }],
            }),
        },
      };
      const res = await callTool(
        "get_account_identity_history",
        { ss58: SS58 },
        { env },
      );
      assert.equal(
        res.body.result.structuredContent.entries[0].identity_hash,
        "pg-hash",
      );
      assert.deepEqual(capture, []);
    });
  });

  test("get_account_position_history returns a schema-stable empty point series", async () => {
    const res = await callTool("get_account_position_history", {
      ss58: SS58,
      netuid: 7,
    });
    const out = res.body.result.structuredContent;
    assert.equal(out.ss58, SS58);
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("get_account_position_history accepts every REST-supported window", async () => {
    for (const window of ["7d", "30d", "90d", "1y", "all"]) {
      const res = await callTool("get_account_position_history", {
        ss58: SS58,
        netuid: 7,
        window,
      });
      assert.equal(res.body.result.structuredContent.window, window);
    }
  });

  test("get_account_position_history rejects a missing netuid or unknown window", async () => {
    const missingNetuid = await callTool("get_account_position_history", {
      ss58: SS58,
    });
    assert.equal(missingNetuid.body.result.isError, true);

    const badWindow = await callTool("get_account_position_history", {
      ss58: SS58,
      netuid: 7,
      window: "5d",
    });
    assert.equal(badWindow.body.result.isError, true);
  });
});

describe("MCP sudo/governance/runtime/list_accounts tools (#5225 parity)", () => {
  test("get_sudo degrades to an empty feed on cold D1", async () => {
    const res = await callTool("get_sudo", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.extrinsic_count, 0);
    assert.deepEqual(out.extrinsics, []);
  });

  test("get_sudo: flag=postgres forwards to /api/v1/sudo, D1 never queried", async () => {
    let capturedPath;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedPath = new URL(req.url).pathname;
          return Response.json({
            schema_version: 1,
            extrinsic_count: 1,
            extrinsics: [{ call_module: "Sudo" }],
          });
        },
      },
    };
    const res = await callTool(
      "get_sudo",
      { call_function: "sudo_set_weights_set_rate_limit" },
      { env },
    );
    assert.equal(capturedPath, "/api/v1/sudo");
    assert.equal(
      res.body.result.structuredContent.extrinsics[0].call_module,
      "Sudo",
    );
  });

  test("get_sudo rejects a non-boolean success filter", async () => {
    const res = await callTool("get_sudo", { success: "maybe" });
    assert.equal(res.body.result.isError, true);
  });

  test("get_governance_config_changes degrades to an empty feed on cold D1", async () => {
    const res = await callTool("get_governance_config_changes", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.extrinsic_count, 0);
    assert.deepEqual(out.extrinsics, []);
  });

  test("get_governance_config_changes: flag=postgres forwards to /api/v1/governance/config-changes", async () => {
    let capturedPath;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedPath = new URL(req.url).pathname;
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            extrinsics: [],
          });
        },
      },
    };
    await callTool("get_governance_config_changes", {}, { env });
    assert.equal(capturedPath, "/api/v1/governance/config-changes");
  });

  test("get_sudo_key returns hotkey:null for genuinely unset storage", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
    });
    try {
      const res = await callTool("get_sudo_key", {}, {});
      const out = res.body.result.structuredContent;
      assert.equal(out.hotkey, null);
      assert.ok(out.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_sudo_key returns hotkey:null on RPC failure", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("rpc down");
    };
    try {
      const res = await callTool("get_sudo_key", {}, {});
      assert.equal(res.body.result.structuredContent.hotkey, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("get_sudo_key rejects an unexpected argument", async () => {
    const res = await callTool("get_sudo_key", { netuid: 7 }, {});
    assert.equal(res.body.result.isError, true);
  });

  test("get_runtime returns a schema-stable empty transition timeline (D1 write path retired)", async () => {
    const res = await callTool("get_runtime", {}, {});
    const out = res.body.result.structuredContent;
    assert.equal(out.transition_count, 0);
    assert.deepEqual(out.transitions, []);
    assert.equal(out.current_spec_version, null);
    assert.equal(out.coverage_from_block, null);
  });

  test("get_runtime: flag=postgres uses Postgres data", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          assert.equal(new URL(req.url).pathname, "/api/v1/runtime");
          return Response.json({
            schema_version: 1,
            transition_count: 1,
            current_spec_version: 300,
            coverage_from_block: 100,
            coverage_from_at: null,
            transitions: [
              { spec_version: 300, block_number: 100, observed_at: null },
            ],
          });
        },
      },
    };
    const res = await callTool("get_runtime", {}, { env });
    assert.equal(res.body.result.structuredContent.current_spec_version, 300);
  });

  test("list_accounts returns a schema-stable empty leaderboard (neurons D1 write path retired)", async () => {
    const res = await callTool("list_accounts", {});
    const out = res.body.result.structuredContent;
    assert.equal(out.sort, "total_stake");
    assert.equal(out.limit, 20);
    assert.equal(out.account_count, 0);
    assert.deepEqual(out.accounts, []);
  });

  test("list_accounts accepts each REST-supported sort key with an empty leaderboard", async () => {
    for (const sort of [
      "total_stake",
      "total_emission",
      "subnet_count",
      "uid_count",
      "validator_count",
      "stake_dominance",
      "last_active",
    ]) {
      const res = await callTool("list_accounts", { sort, limit: 1 });
      const out = res.body.result.structuredContent;
      assert.equal(out.sort, sort);
      assert.equal(out.limit, 1);
    }
  });

  test("list_accounts rejects an invalid sort", async () => {
    const res = await callTool("list_accounts", { sort: "bogus" });
    assert.equal(res.body.result.isError, true);
  });
});

describe("MCP endpoint tools — live overlay staleness fix (#5225)", () => {
  const liveKv = {
    last_run_at: FRESH_RUN,
    surfaces: [
      {
        surface_id: "sn-7-example-api",
        netuid: 7,
        status: "failed",
        classification: "down",
        latency_ms: null,
        last_ok: "2026-06-12T00:00:00.000Z",
        last_checked: "2026-06-13T00:00:00.000Z",
      },
    ],
  };

  test("list_endpoints overlays live health onto endpoints carrying a surface_id", async () => {
    const deps = makeDeps(
      {
        "/metagraph/endpoints.json": {
          generated_at: "2026-01-01T00:00:00Z",
          endpoints: [
            {
              surface_id: "sn-7-example-api",
              netuid: 7,
              kind: "subnet-api",
              status: "ok",
              pool_eligible: true,
            },
          ],
        },
      },
      { "health:current": liveKv },
    );
    const res = await callTool("list_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].status, "failed");
  });

  test("list_endpoints skips the overlay when no endpoint carries a surface_id (unchanged)", async () => {
    const deps = makeDeps(
      {
        "/metagraph/endpoints.json": {
          generated_at: "2026-01-01T00:00:00Z",
          endpoints: [{ netuid: 7, kind: "rest", status: "ok" }],
        },
      },
      { "health:current": liveKv },
    );
    const res = await callTool("list_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].status, "ok");
  });

  test("get_subnet_endpoints overlays live health onto its endpoints", async () => {
    const deps = makeDeps(
      {
        "/metagraph/endpoints/7.json": {
          generated_at: "2026-01-01T00:00:00Z",
          netuid: 7,
          endpoints: [
            {
              surface_id: "sn-7-example-api",
              kind: "subnet-api",
              status: "ok",
            },
          ],
        },
      },
      { "health:current": liveKv },
    );
    const res = await callTool("get_subnet_endpoints", { netuid: 7 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].status, "failed");
  });

  test("list_rpc_endpoints overlays live RPC pool health onto matching endpoint ids", async () => {
    const deps = makeDeps(
      {
        "/metagraph/rpc-endpoints.json": {
          generated_at: "2026-01-01T00:00:00Z",
          endpoints: [
            {
              id: "fullnode",
              url: "wss://rpc.example",
              network: "finney",
              status: "ok",
            },
          ],
        },
      },
      {
        [KV_HEALTH_RPC_POOL]: {
          last_run_at: FRESH_RUN,
          endpoints: [
            {
              id: "fullnode",
              status: "degraded",
              classification: "slow",
              latency_ms: 900,
            },
          ],
        },
      },
    );
    const res = await callTool("list_rpc_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].latency_ms, 900);
    assert.equal(out.endpoints[0].health_source, "probe-derived");
  });

  test("list_rpc_endpoints falls back to the static artifact when no pool KV is present", async () => {
    const deps = makeDeps({
      "/metagraph/rpc-endpoints.json": {
        generated_at: "2026-01-01T00:00:00Z",
        endpoints: [
          {
            id: "fullnode",
            url: "wss://rpc.example",
            network: "finney",
            status: "ok",
          },
        ],
      },
    });
    const res = await callTool("list_rpc_endpoints", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].status, "ok");
  });
});

// All twelve of these tools previously called their builder with []
// unconditionally -- #4909's D1 retirement left no D1 path to route to
// (neurons/neuron_daily are dropped), so they always served zeroed/empty
// data in production while their REST siblings (entities.mjs's
// handleSubnetConcentration et al.) served real Postgres data via
// tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE"). This block
// confirms the same wiring now reaches DATA_API at REST's exact path +
// query params, and degrades safely to the schema-stable empty shape (never
// isError) on any Postgres failure -- same contract as the pre-existing
// get_subnet_identity_history/list_extrinsics Postgres-cutover blocks above.
describe("MCP chain-*/subnet-* analytics tools — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "get_subnet_concentration",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/concentration",
    },
    {
      tool: "get_subnet_performance",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/performance",
    },
    {
      tool: "get_chain_concentration",
      args: {},
      path: "/api/v1/chain/concentration",
    },
    {
      tool: "get_chain_performance",
      args: {},
      path: "/api/v1/chain/performance",
    },
    {
      tool: "get_chain_yield",
      args: {},
      path: "/api/v1/chain/yield",
    },
    {
      tool: "get_subnet_yield",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/yield",
    },
    {
      tool: "get_subnet_concentration_history",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/concentration/history?window=30d",
    },
    {
      tool: "get_subnet_performance_history",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/performance/history?window=30d",
    },
    {
      tool: "get_subnet_yield_history",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/yield/history?window=30d",
    },
    {
      tool: "get_subnet_turnover",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/turnover?window=30d",
    },
    {
      tool: "get_subnet_turnover",
      args: { netuid: 7, window: "30d", changes: true },
      path: "/api/v1/subnets/7/turnover?window=30d&changes=true",
    },
    {
      tool: "get_chain_turnover",
      args: { window: "30d" },
      path: "/api/v1/chain/turnover?window=30d&limit=20",
    },
    {
      tool: "get_subnet_movers",
      args: {},
      path: "/api/v1/subnets/movers?window=30d&sort=stake&limit=20",
    },
    {
      tool: "get_subnet_metagraph",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/metagraph",
    },
    {
      tool: "get_subnet_metagraph",
      args: { netuid: 7, validator_permit: true },
      path: "/api/v1/subnets/7/metagraph?validator_permit=true",
    },
    {
      tool: "list_subnet_validators",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/validators",
    },
    {
      tool: "list_global_validators",
      args: {},
      path: "/api/v1/validators?sort=subnet_count&limit=20",
    },
    {
      tool: "get_validator_detail",
      args: { hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    },
    {
      tool: "get_neuron",
      args: { netuid: 7, uid: 3 },
      path: "/api/v1/subnets/7/neurons/3",
    },
    {
      tool: "list_accounts",
      args: {},
      path: "/api/v1/accounts?sort=total_stake&limit=20",
    },
    {
      tool: "get_validator_history",
      args: {
        hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        window: "30d",
      },
      path: "/api/v1/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/history?window=30d",
    },
    {
      tool: "get_neuron_history",
      args: { netuid: 7, uid: 3, window: "30d" },
      path: "/api/v1/subnets/7/neurons/3/history?window=30d",
    },
    {
      tool: "get_subnet_history",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/history?window=30d",
    },
    {
      tool: "get_account_subnets",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/subnets",
    },
    {
      tool: "get_account_portfolio",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/portfolio",
    },
    {
      tool: "get_account_position_history",
      args: {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        netuid: 7,
        window: "30d",
      },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/subnets/7/history?window=30d",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("changes=true")
      ? `${tool} (changes=true)`
      : path.includes("validator_permit=true")
        ? `${tool} (validator_permit=true)`
        : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_NEURONS_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_NEURONS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});

// get_rpc_usage is gated on METAGRAPH_RPC_USAGE_SOURCE, not
// METAGRAPH_NEURONS_SOURCE, so it doesn't fit the shared CASES loop above
// (which hardcodes the neurons-tier flag) -- same two-test-per-tool
// contract, just with the correct flag name and its own CASES array.
describe("MCP get_rpc_usage — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "get_rpc_usage",
      args: {},
      path: "/api/v1/rpc/usage?window=7d",
    },
    {
      tool: "get_rpc_usage",
      args: { window: "30d" },
      path: "/api/v1/rpc/usage?window=30d",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("window=30d") ? `${tool} (window=30d)` : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_RPC_USAGE_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_RPC_USAGE_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});

// get_subnet_trajectory / get_economics_trends are gated on
// METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, not METAGRAPH_NEURONS_SOURCE, so they
// don't fit the shared CASES loop above (which hardcodes the neurons-tier
// flag) -- same two-test-per-tool contract, just with the correct flag name
// and its own CASES array.
describe("MCP subnet-snapshots-tier analytics tools — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "get_subnet_trajectory",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/trajectory",
    },
    {
      tool: "get_economics_trends",
      args: {},
      path: "/api/v1/economics/trends?window=30d",
    },
    {
      tool: "get_economics_trends",
      args: { window: "7d" },
      path: "/api/v1/economics/trends?window=7d",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("window=7d") ? `${tool} (window=7d)` : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});

// get_network_activity / get_chain_calls / get_chain_signers / get_chain_fees
// are gated on METAGRAPH_EXTRINSICS_SOURCE, not METAGRAPH_NEURONS_SOURCE, so
// they don't fit the shared CASES loop above (which hardcodes the
// neurons-tier flag) -- same two-test-per-tool contract, just with the
// correct flag name and its own CASES array.
describe("MCP extrinsics-tier chain analytics tools — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "get_network_activity",
      args: {},
      path: "/api/v1/chain/activity?window=7d",
    },
    {
      tool: "get_network_activity",
      args: { window: "30d" },
      path: "/api/v1/chain/activity?window=30d",
    },
    {
      tool: "get_chain_calls",
      args: {},
      path: "/api/v1/chain/calls?window=7d&group_by=module&limit=50",
    },
    {
      tool: "get_chain_calls",
      args: {
        window: "30d",
        group_by: "module_function",
        limit: 10,
        call_module: "Balances",
      },
      path: "/api/v1/chain/calls?window=30d&group_by=module_function&limit=10&call_module=Balances",
    },
    {
      tool: "get_chain_signers",
      args: {},
      path: "/api/v1/chain/signers?window=7d&sort=tx_count&limit=50",
    },
    {
      tool: "get_chain_signers",
      args: {
        window: "30d",
        sort: "total_fee_tao",
        limit: 5,
        call_module: "Balances",
      },
      path: "/api/v1/chain/signers?window=30d&sort=total_fee_tao&limit=5&call_module=Balances",
    },
    {
      tool: "get_chain_fees",
      args: {},
      path: "/api/v1/chain/fees?window=7d&limit=25",
    },
    {
      tool: "get_chain_fees",
      args: { window: "30d", limit: 10, call_module: "Balances" },
      path: "/api/v1/chain/fees?window=30d&limit=10&call_module=Balances",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("call_module=")
      ? `${tool} (call_module)`
      : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_EXTRINSICS_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_EXTRINSICS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});

// list_blocks / get_blocks_summary / get_block are gated on
// METAGRAPH_BLOCKS_SOURCE, not METAGRAPH_NEURONS_SOURCE or
// METAGRAPH_EXTRINSICS_SOURCE, so they don't fit either shared CASES loop
// above -- same two-test-per-tool contract, just with the correct flag name
// and its own CASES array.
describe("MCP blocks-tier chain-explorer tools — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "list_blocks",
      args: {},
      path: "/api/v1/blocks?limit=50&offset=0",
    },
    {
      tool: "list_blocks",
      args: {
        author: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        spec_version: 300,
        block_start: 100,
        block_end: 200,
        from: 1000,
        to: 2000,
        min_extrinsics: 1,
        min_events: 2,
        limit: 10,
        offset: 5,
        cursor: "abc123",
      },
      path:
        "/api/v1/blocks?author=5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" +
        "&spec_version=300&block_start=100&block_end=200&from=1000&to=2000" +
        "&min_extrinsics=1&min_events=2&limit=10&offset=5&cursor=abc123",
    },
    {
      tool: "get_blocks_summary",
      args: {},
      path: "/api/v1/blocks/summary",
    },
    {
      tool: "get_block",
      args: { ref: "4200000" },
      path: "/api/v1/blocks/4200000",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("author=") ? `${tool} (filtered)` : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_BLOCKS_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_BLOCKS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});

// get_subnet_hyperparams / get_subnet_hyperparams_history are gated on
// METAGRAPH_SUBNET_HYPERPARAMS_SOURCE, not METAGRAPH_NEURONS_SOURCE, so they
// don't fit the shared CASES loop above (which hardcodes the neurons-tier
// flag) -- same two-test-per-tool contract, just with the correct flag name.
describe("MCP get_subnet_hyperparams* tools — Postgres tier wiring", () => {
  test("get_subnet_hyperparams: flag=postgres uses Postgres data at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({ schema_version: 1, marker: "from-postgres" });
        },
      },
    };
    const res = await callTool(
      "get_subnet_hyperparams",
      { netuid: 7 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, "/api/v1/subnets/7/hyperparameters");
  });

  test("get_subnet_hyperparams: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_subnet_hyperparams",
      { netuid: 7 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_subnet_hyperparams: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    const res = await callTool(
      "get_subnet_hyperparams",
      { netuid: 7 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_subnet_hyperparams_history: flag=postgres uses Postgres data at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({ schema_version: 1, marker: "from-postgres" });
        },
      },
    };
    const res = await callTool(
      "get_subnet_hyperparams_history",
      { netuid: 7 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(
      captured,
      "/api/v1/subnets/7/hyperparameters/history?limit=100&offset=0",
    );
  });

  test("get_subnet_hyperparams_history: flag=postgres forwards a supplied limit/offset", async () => {
    let captured;
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({ schema_version: 1, marker: "from-postgres" });
        },
      },
    };
    await callTool(
      "get_subnet_hyperparams_history",
      { netuid: 7, limit: 25, offset: 50 },
      { env },
    );
    assert.equal(
      captured,
      "/api/v1/subnets/7/hyperparameters/history?limit=25&offset=50",
    );
  });

  test("get_subnet_hyperparams_history: flag=postgres forwards a supplied cursor", async () => {
    let captured;
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({ schema_version: 1, marker: "from-postgres" });
        },
      },
    };
    await callTool(
      "get_subnet_hyperparams_history",
      { netuid: 7, cursor: "opaque-cursor-value" },
      { env },
    );
    assert.equal(
      captured,
      "/api/v1/subnets/7/hyperparameters/history?limit=100&offset=0&cursor=opaque-cursor-value",
    );
  });

  test("get_subnet_hyperparams_history: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_subnet_hyperparams_history",
      { netuid: 7 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_subnet_hyperparams_history: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    const res = await callTool(
      "get_subnet_hyperparams_history",
      { netuid: 7 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

// get_subnet_weights / get_subnet_weight_setters / get_subnet_serving /
// get_subnet_prometheus / get_subnet_stake_moves / get_validator_nominators
// are gated on METAGRAPH_ACCOUNT_EVENTS_SOURCE, not METAGRAPH_NEURONS_SOURCE,
// so they don't fit the shared CASES loop above (which hardcodes the
// neurons-tier flag) -- same two-test-per-tool contract, just with the
// correct flag name and its own CASES array.
describe("MCP account_events-tier subnet/validator activity tools — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "get_subnet_weights",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/weights?window=7d",
    },
    {
      tool: "get_subnet_weights",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/weights?window=30d",
    },
    {
      tool: "get_subnet_weight_setters",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/weights/setters?window=7d",
    },
    {
      tool: "get_subnet_serving",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/serving?window=7d",
    },
    {
      tool: "get_subnet_prometheus",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/prometheus?window=7d",
    },
    {
      tool: "get_subnet_stake_moves",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/stake-moves?window=7d",
    },
    // get_validator_nominators is deliberately NOT in this generic CASES
    // array: its DATA_API route wraps the response as { data, generatedAt }
    // (unlike every other tool here, which returns the flat shape directly),
    // so it needs its own .data-aware mock and already has a dedicated test
    // earlier in this file ("unwraps the DATA_API {data, generatedAt}
    // envelope onto the top level").
    {
      tool: "get_subnet_registrations",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/registrations?window=7d",
    },
    {
      tool: "get_subnet_stake_transfers",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/stake-transfers?window=7d",
    },
    {
      tool: "get_subnet_axon_removals",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/axon-removals?window=7d",
    },
    {
      tool: "get_subnet_deregistrations",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/deregistrations?window=7d",
    },
    {
      tool: "get_subnet_events",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/events?limit=100&offset=0",
    },
    {
      tool: "get_subnet_event_summary",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/event-summary?window=30d&limit=10",
    },
    {
      tool: "get_account",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    },
    {
      tool: "get_account_events",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/events?limit=100&offset=0",
    },
    {
      tool: "get_account_history",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/history",
    },
    {
      tool: "get_account_history",
      args: {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        netuid: 7,
        from: "2026-01-01",
        to: "2026-01-31",
        limit: 50,
        offset: 10,
        cursor: "abc",
      },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/history?netuid=7&from=2026-01-01&to=2026-01-31&limit=50&offset=10&cursor=abc",
    },
    {
      tool: "get_account_transfers",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/transfers?limit=100&offset=0",
    },
    {
      tool: "get_account_transfers",
      args: {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        direction: "sent",
        block_start: 100,
        block_end: 200,
        limit: 5,
        offset: 10,
        cursor: "xyz",
      },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/transfers?direction=sent&block_start=100&block_end=200&limit=5&offset=10&cursor=xyz",
    },
    {
      tool: "get_account_counterparties",
      args: { ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5" },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/counterparties",
    },
    {
      tool: "get_account_counterparties",
      args: {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        limit: 10,
      },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/counterparties?limit=10",
    },
    {
      tool: "get_account_counterparties",
      args: {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        counterparty: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/counterparties?counterparty=5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    },
    {
      tool: "get_account_counterparties",
      args: {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        counterparty: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
        limit: 5,
      },
      path: "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/counterparties?counterparty=5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty&limit=5",
    },
    {
      tool: "get_chain_transfers",
      args: {},
      path: "/api/v1/chain/transfers?window=7d&limit=25",
    },
    {
      tool: "get_chain_transfers",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/transfers?window=30d&limit=10",
    },
    {
      tool: "get_chain_transfer_pairs",
      args: {},
      path: "/api/v1/chain/transfer-pairs?window=7d&sort=volume&limit=25",
    },
    {
      tool: "get_chain_transfer_pairs",
      args: { window: "30d", sort: "count", limit: 10 },
      path: "/api/v1/chain/transfer-pairs?window=30d&sort=count&limit=10",
    },
    {
      tool: "get_chain_stake_flow",
      args: {},
      path: "/api/v1/chain/stake-flow?window=7d&limit=20",
    },
    {
      tool: "get_chain_weights",
      args: {},
      path: "/api/v1/chain/weights?window=7d&limit=20",
    },
    {
      tool: "get_chain_weight_setters",
      args: {},
      path: "/api/v1/chain/weights/setters?window=7d&limit=20",
    },
    {
      tool: "get_chain_serving",
      args: {},
      path: "/api/v1/chain/serving?window=7d&limit=20",
    },
    {
      tool: "get_chain_prometheus",
      args: {},
      path: "/api/v1/chain/prometheus?window=7d&limit=20",
    },
    {
      tool: "get_chain_prometheus",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/prometheus?window=30d&limit=10",
    },
    {
      tool: "get_chain_axon_removals",
      args: {},
      path: "/api/v1/chain/axon-removals?window=7d&limit=20",
    },
    {
      tool: "get_chain_axon_removals",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/axon-removals?window=30d&limit=10",
    },
    {
      tool: "get_chain_registrations",
      args: {},
      path: "/api/v1/chain/registrations?window=7d&limit=20",
    },
    {
      tool: "get_chain_registrations",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/registrations?window=30d&limit=10",
    },
    {
      tool: "get_chain_deregistrations",
      args: {},
      path: "/api/v1/chain/deregistrations?window=7d&limit=20",
    },
    {
      tool: "get_chain_deregistrations",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/deregistrations?window=30d&limit=10",
    },
    {
      tool: "get_chain_stake_moves",
      args: {},
      path: "/api/v1/chain/stake-moves?window=7d&limit=20",
    },
    {
      tool: "get_chain_stake_moves",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/stake-moves?window=30d&limit=10",
    },
    {
      tool: "get_chain_stake_transfers",
      args: {},
      path: "/api/v1/chain/stake-transfers?window=7d&limit=20",
    },
    {
      tool: "get_chain_stake_transfers",
      args: { window: "30d", limit: 10 },
      path: "/api/v1/chain/stake-transfers?window=30d&limit=10",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("coldkey=") ? `${tool} (coldkey)` : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});

// get_subnet_stake_flow and get_subnet_volume are also gated on
// METAGRAPH_ACCOUNT_EVENTS_SOURCE, but unlike the flat-data-shaped tools in
// the CASES loop above (whose DATA_API response IS the builder payload),
// entities.mjs's handleSubnetStakeFlow/handleSubnetAlphaVolume destructure
// `{ data, generatedAt }` from tryPostgresTier's result (mirroring
// workers/data-api.mjs's `/subnets/:netuid/stake-flow` and `/volume` routes,
// which return `json({ data: buildX(...), generatedAt })`, not a flat
// buildX(...) body) -- so these two tools unwrap `.data` before falling back,
// and the DATA_API mock here must nest the marker under `data` to exercise
// that unwrap, not sit at the top level like the flat-shaped CASES tools.
describe("MCP get_subnet_stake_flow / get_subnet_volume — Postgres tier wiring", () => {
  test("get_subnet_stake_flow: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool("get_subnet_stake_flow", { netuid: 7 }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(
      captured,
      "/api/v1/subnets/7/stake-flow?window=30d&direction=all",
    );
  });

  test("get_subnet_stake_flow: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool("get_subnet_stake_flow", { netuid: 7 }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_subnet_stake_flow: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool("get_subnet_stake_flow", { netuid: 7 }, { env });
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_subnet_volume: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const deps = makeDeps({
      "/metagraph/economics.json": { subnets: [{ netuid: 7 }] },
    });
    const res = await callTool(
      "get_subnet_volume",
      { netuid: 7 },
      { env, deps },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, "/api/v1/subnets/7/volume");
  });

  test("get_subnet_volume: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const deps = makeDeps({
      "/metagraph/economics.json": { subnets: [{ netuid: 7 }] },
    });
    const res = await callTool(
      "get_subnet_volume",
      { netuid: 7 },
      { env, deps },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_subnet_volume: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const deps = makeDeps({
      "/metagraph/economics.json": { subnets: [{ netuid: 7 }] },
    });
    const res = await callTool(
      "get_subnet_volume",
      { netuid: 7 },
      { env, deps },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

// get_subnet_ohlc is also gated on METAGRAPH_ACCOUNT_EVENTS_SOURCE and, like
// get_subnet_stake_flow/get_subnet_volume above, entities.mjs's
// handleSubnetOhlc destructures `{ data, generatedAt }` from
// tryPostgresTier's result -- so the DATA_API mock here nests the marker
// under `data` to exercise that unwrap.
describe("MCP get_subnet_ohlc — Postgres tier wiring", () => {
  test("flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_subnet_ohlc",
      { netuid: 7, interval: "1d", days: 30 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, "/api/v1/subnets/7/ohlc?interval=1d&days=30");
  });

  test("flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool("get_subnet_ohlc", { netuid: 7 }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
    assert.deepEqual(res.body.result.structuredContent.candles, []);
  });

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool("get_subnet_ohlc", { netuid: 7 }, { env });
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

// get_account_stake_flow / get_account_stake_moves / get_account_registrations /
// get_account_weight_setters are also gated on METAGRAPH_ACCOUNT_EVENTS_SOURCE,
// and like get_subnet_stake_flow/get_subnet_volume above (not like the
// flat-shaped CASES tools), entities.mjs's handleAccountStakeFlow et al.
// destructure `{ data, generatedAt }` from tryPostgresTier's result, so these
// four tools unwrap `.data` before falling back -- the DATA_API mock here
// nests the marker under `data` to exercise that unwrap.
describe("MCP get_account_stake_flow / get_account_stake_moves / get_account_registrations / get_account_weight_setters — Postgres tier wiring", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  test("get_account_stake_flow: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_stake_flow",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(
      captured,
      `/api/v1/accounts/${SS58}/stake-flow?window=30d&direction=all`,
    );
  });

  test("get_account_stake_flow: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_stake_flow",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_stake_flow: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_stake_flow",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_stake_moves: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_stake_moves",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, `/api/v1/accounts/${SS58}/stake-moves?window=30d`);
  });

  test("get_account_stake_moves: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_stake_moves",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_stake_moves: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_stake_moves",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_registrations: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_registrations",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, `/api/v1/accounts/${SS58}/registrations?window=30d`);
  });

  test("get_account_registrations: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_registrations",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_registrations: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_registrations",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_weight_setters: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_weight_setters",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, `/api/v1/accounts/${SS58}/weight-setters?window=7d`);
  });

  test("get_account_weight_setters: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_weight_setters",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_weight_setters: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_weight_setters",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_serving: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool("get_account_serving", { ss58: SS58 }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, `/api/v1/accounts/${SS58}/serving?window=30d`);
  });

  test("get_account_serving: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool("get_account_serving", { ss58: SS58 }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_serving: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool("get_account_serving", { ss58: SS58 }, { env });
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_axon_removals: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_axon_removals",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, `/api/v1/accounts/${SS58}/axon-removals?window=30d`);
  });

  test("get_account_axon_removals: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_axon_removals",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_axon_removals: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_axon_removals",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_prometheus: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_prometheus",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, `/api/v1/accounts/${SS58}/prometheus?window=30d`);
  });

  test("get_account_prometheus: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_prometheus",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_prometheus: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_prometheus",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_deregistrations: flag=postgres uses Postgres data (unwrapped from {data, generatedAt}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          });
        },
      },
    };
    const res = await callTool(
      "get_account_deregistrations",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(
      captured,
      `/api/v1/accounts/${SS58}/deregistrations?window=30d`,
    );
  });

  test("get_account_deregistrations: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_deregistrations",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_deregistrations: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await callTool(
      "get_account_deregistrations",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

// get_block_events is also gated on METAGRAPH_ACCOUNT_EVENTS_SOURCE, but
// unlike the flat-data-shaped tools in the account_events-tier CASES loop
// above, entities.mjs's handleBlockEvents destructures `{ data }` from
// tryPostgresTier's result -- workers/data-api.mjs's /blocks/:ref/events
// route returns `json({ data: buildBlockEvents(...) })`, not a flat
// buildBlockEvents(...) body -- so this tool unwraps `.data` before falling
// back, and the DATA_API mock here must nest the marker under `data`.
describe("MCP get_block_events — Postgres tier wiring", () => {
  test("get_block_events: flag=postgres uses Postgres data (unwrapped from {data}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
          });
        },
      },
    };
    const res = await callTool("get_block_events", { ref: "4200000" }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(captured, "/api/v1/blocks/4200000/events?limit=100&offset=0");
  });

  test("get_block_events: flag=postgres forwards a supplied limit/offset and a 0x hash ref", async () => {
    let captured;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
          });
        },
      },
    };
    const hash = `0x${"ab".repeat(32)}`;
    await callTool(
      "get_block_events",
      { ref: hash, limit: 25, offset: 50 },
      { env },
    );
    assert.equal(captured, `/api/v1/blocks/${hash}/events?limit=25&offset=50`);
  });

  test("get_block_events: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool("get_block_events", { ref: "4200000" }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_block_events: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
          }),
      },
    };
    const res = await callTool("get_block_events", { ref: "4200000" }, { env });
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

// get_account_extrinsics and list_block_extrinsics are both gated on
// METAGRAPH_EXTRINSICS_SOURCE, not METAGRAPH_NEURONS_SOURCE (the shared CASES
// loop above) or METAGRAPH_ACCOUNT_EVENTS_SOURCE (the account_events-tier CASES
// loop), so neither fits either shared array. get_account_extrinsics mirrors
// REST's handleAccountExtrinsics, which uses tryPostgresTier's result directly
// (a flat buildAccountExtrinsics(...) body, same shape as get_account_events);
// list_block_extrinsics mirrors handleBlockExtrinsics, which destructures
// `{ data }` from tryPostgresTier's result (workers/data-api.mjs's
// /blocks/:ref/extrinsics route returns `json({ data: buildBlockExtrinsics(...) })`),
// same shape as the get_block_events tool above.
describe("MCP get_account_extrinsics — Postgres tier wiring", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  test("get_account_extrinsics: flag=postgres uses Postgres data at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({ schema_version: 1, marker: "from-postgres" });
        },
      },
    };
    const res = await callTool(
      "get_account_extrinsics",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(
      captured,
      `/api/v1/accounts/${SS58}/extrinsics?limit=100&offset=0`,
    );
  });

  test("get_account_extrinsics: flag=postgres forwards block_start/block_end/limit/offset/cursor", async () => {
    let captured;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({ schema_version: 1, marker: "from-postgres" });
        },
      },
    };
    await callTool(
      "get_account_extrinsics",
      {
        ss58: SS58,
        block_start: 100,
        block_end: 200,
        limit: 5,
        offset: 10,
        cursor: "abc",
      },
      { env },
    );
    assert.equal(
      captured,
      `/api/v1/accounts/${SS58}/extrinsics?block_start=100&block_end=200&limit=5&offset=10&cursor=abc`,
    );
  });

  test("get_account_extrinsics: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "get_account_extrinsics",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("get_account_extrinsics: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    const res = await callTool(
      "get_account_extrinsics",
      { ss58: SS58 },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

describe("MCP list_block_extrinsics — Postgres tier wiring", () => {
  test("list_block_extrinsics: flag=postgres uses Postgres data (unwrapped from {data}) at the REST-equivalent path", async () => {
    let captured;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
          });
        },
      },
    };
    const res = await callTool(
      "list_block_extrinsics",
      { ref: "4200000" },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, "from-postgres");
    assert.equal(
      captured,
      "/api/v1/blocks/4200000/extrinsics?limit=50&offset=0",
    );
  });

  test("list_block_extrinsics: flag=postgres forwards a supplied limit/offset and a 0x hash ref", async () => {
    let captured;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          const reqUrl = new URL(req.url);
          captured = reqUrl.pathname + reqUrl.search;
          return Response.json({
            data: { schema_version: 1, marker: "from-postgres" },
          });
        },
      },
    };
    const hash = `0x${"ab".repeat(32)}`;
    await callTool(
      "list_block_extrinsics",
      { ref: hash, limit: 25, offset: 60 },
      { env },
    );
    assert.equal(
      captured,
      `/api/v1/blocks/${hash}/extrinsics?limit=25&offset=60`,
    );
  });

  test("list_block_extrinsics: flag=postgres falls back to the schema-stable empty shape on failure", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await callTool(
      "list_block_extrinsics",
      { ref: "4200000" },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });

  test("list_block_extrinsics: flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: { schema_version: 1, marker: "should-not-be-used" },
          }),
      },
    };
    const res = await callTool(
      "list_block_extrinsics",
      { ref: "4200000" },
      { env },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.marker, undefined);
  });
});

// get_health_trends / get_subnet_health_trends / get_subnet_health_percentiles
// / get_subnet_health_incidents / get_global_incidents are gated on
// METAGRAPH_HEALTH_SOURCE, not METAGRAPH_NEURONS_SOURCE or
// METAGRAPH_EXTRINSICS_SOURCE, so they don't fit either shared CASES loop
// above -- same two-test-per-tool contract, just with the correct flag name
// and its own CASES array.
describe("MCP health-tier analytics tools — Postgres tier wiring", () => {
  const CASES = [
    {
      tool: "get_health_trends",
      args: {},
      path: "/api/v1/health/trends",
    },
    {
      tool: "get_subnet_health_trends",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/health/trends",
    },
    {
      tool: "get_subnet_health_percentiles",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/health/percentiles?window=7d",
    },
    {
      tool: "get_subnet_health_percentiles",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/health/percentiles?window=30d",
    },
    {
      tool: "get_subnet_health_incidents",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/health/incidents?window=7d",
    },
    {
      tool: "get_subnet_health_incidents",
      args: { netuid: 7, window: "30d" },
      path: "/api/v1/subnets/7/health/incidents?window=30d",
    },
    {
      tool: "get_global_incidents",
      args: {},
      path: "/api/v1/incidents?window=7d",
    },
    {
      tool: "get_global_incidents",
      args: { window: "30d" },
      path: "/api/v1/incidents?window=30d",
    },
    {
      tool: "get_subnet_uptime",
      args: { netuid: 7, window: "1y", min_samples: 5 },
      path: "/api/v1/subnets/7/uptime?window=1y&min_samples=5",
    },
    {
      tool: "get_subnet_uptime",
      args: { netuid: 7 },
      path: "/api/v1/subnets/7/uptime?window=90d",
    },
  ];

  for (const { tool, args, path } of CASES) {
    const label = path.includes("window=30d") ? `${tool} (window=30d)` : tool;

    test(`${label}: flag=postgres uses Postgres data at the REST-equivalent path`, async () => {
      let captured;
      const env = {
        METAGRAPH_HEALTH_SOURCE: "postgres",
        DATA_API: {
          fetch: async (req) => {
            const reqUrl = new URL(req.url);
            captured = reqUrl.pathname + reqUrl.search;
            return Response.json({
              schema_version: 1,
              marker: "from-postgres",
            });
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(
        res.body.result.structuredContent.marker,
        "from-postgres",
        label,
      );
      assert.equal(captured, path, label);
    });

    test(`${label}: flag=postgres falls back to the schema-stable empty shape on failure`, async () => {
      const env = {
        METAGRAPH_HEALTH_SOURCE: "postgres",
        DATA_API: {
          fetch: async () => {
            throw new Error("boom");
          },
        },
      };
      const res = await callTool(tool, args, { env });
      assert.equal(res.body.result.isError, false, label);
      assert.equal(res.body.result.structuredContent.marker, undefined, label);
    });
  }

  test("flag absent uses the schema-stable empty shape even when DATA_API is bound (unflipped)", async () => {
    const env = {
      DATA_API: {
        fetch: async () =>
          Response.json({ schema_version: 1, marker: "should-not-be-used" }),
      },
    };
    for (const { tool, args } of CASES) {
      const res = await callTool(tool, args, { env });
      assert.equal(
        res.body.result.structuredContent.marker,
        undefined,
        `${tool} should not reach DATA_API without the flag`,
      );
    }
  });
});
