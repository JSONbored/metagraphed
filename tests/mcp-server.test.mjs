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
