import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { McpSurfaceAdmissionSchema } from "../schemas-src/subnet-mcp-admission.ts";
import { SurfaceSchema } from "../schemas-src/routes/subnet-detail.ts";
import { AgentCatalogServiceSchema } from "../schemas-src/routes/agent-catalog.ts";
import { storeSurfaceCredential, type ConfiguredSurfaceCredentialEnv } from "../src/mcp-surface-credentials.ts";
import { McpForwardedResult } from "../src/mcp-content.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

type McpCtx = Parameters<(typeof MCP_TOOLS)[number]["handler"]>[1];

const surface = {
  id: "sn-107-fixture-mcp", key: "srf-fixture10000000", netuid: 107,
  provider: "fixture", authority: "community", kind: "subnet-api",
  url: "https://subnet.example/mcp", auth_required: false, auth: null, public_safe: true,
  probe: { method: "JSON-RPC", expect: "json", enabled: false },
  mcp: { transport: "streamable-http", read_tools: ["read"], write_tools: ["write"] },
};
const definition = (name: string) => {
  const tool = MCP_TOOLS.find(tool => tool.name === name);
  assert.ok(tool);
  return tool;
};
function setup(rows: Row[] = [surface], output: Row = {
  content: [{ type: "text", text: "exact provider bytes\n" }, { type: "image", mimeType: "image/png", data: "AQIDBA==" }],
  structuredContent: { exact: "18446744073709551615" }, _meta: { source: "fixture" },
}) {
  const calls: Row[] = [];
  const artifacts: string[] = [];
  const readArtifact = async (_env: unknown, path: string) => {
    artifacts.push(path);
    if (path === "/metagraph/surfaces.json") return { ok: true, data: { surfaces: rows } };
    if (path === "/metagraph/surface-aliases.json") return { ok: true, data: { aliases: [{ deprecated_id: "old-fixture", current_id: surface.id, surface_key: surface.key }] } };
    if (path === "/metagraph/operational-surfaces.json") return { ok: true, data: { surfaces: [] } };
    return { ok: false, status: 404 };
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://cloudflare-dns.com/dns-query"))
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(new URL(String(url)).origin, "https://subnet.example");
    const message = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers), message });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list"
        ? { tools: ["read", "write"].map(name => ({ name, inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: name === "write" } })) }
        : output;
    return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": "fixture-session" } });
  };
  const call = async (name: string, args: Row, env = mockEnv()) => {
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await jsonBody(await handleMcpRequest(new Request("https://metagraph.sh/mcp/core", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }), env, { readArtifact }));
      return result.result as Row;
    } finally { globalThis.fetch = previous; }
  };
  return { calls, artifacts, call, fetchImpl, readArtifact };
}
const args = { surface_id: surface.id, tool_name: "read" };

describe("subnet MCP public contract", () => {
  test("disabled recurring probes do not prevent explicit MCP discovery", async () => {
    const { call, artifacts } = setup();
    const result = await call("discover_subnet_mcp", { surface_id: surface.id });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.tools.map((t: Row) => [t.name, t.access]), [["read", "read"], ["write", "write"]]);
    assert.ok(!artifacts.includes("/metagraph/operational-surfaces.json"));
  });
  test("read forwards native bytes once, structured output and metadata", async () => {
    const { call } = setup();
    const result = await call("read_subnet_mcp", args);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "exact provider bytes\n" }, { type: "image", mimeType: "image/png", data: "AQIDBA==" }]);
    assert.deepEqual(result.structuredContent, { surface_id: surface.id, tool_name: "read", upstream_is_error: false, structured_content: { exact: "18446744073709551615" }, upstream_meta: { source: "fixture" } });
    assert.equal(JSON.stringify(result).split("AQIDBA==").length - 1, 1);
    const tool = definition("read_subnet_mcp");
    assert.equal(new Ajv2020({ strict: false }).compile(tool.outputSchema!)(result.structuredContent), true);
  });
  test("upstream execution errors remain tool errors with their exact content", async () => {
    const content = [{ type: "text", text: "provider execution failed" }];
    const { call } = setup([surface], { content, isError: true });
    const result = await call("read_subnet_mcp", args);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, content);
    assert.equal(result.structuredContent.upstream_is_error, true);
    assert.ok(!("structured_content" in result.structuredContent));
  });
  test("native binary and structured values do not create another receipt text copy", async () => {
    const bytes = Buffer.alloc(131_072, 42);
    const content = [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }];
    const structuredContent = { values: Array.from({ length: 128 }, (_, i) => `exact-${i}`) };
    const { call } = setup([surface], { content, structuredContent });
    const result = await call("read_subnet_mcp", args);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, content);
    assert.deepEqual(result.structuredContent.structured_content, structuredContent);
    assert.equal(result.content.filter((block: Row) => block.type === "text").length, 0);
    assert.equal(JSON.stringify(result).split(content[0].data).length - 1, 1);
    console.log("SUBNET_MCP_CONTENT_FIXTURE", JSON.stringify({
      bytes: bytes.length, base64_chars: content[0].data.length,
      native_copies: 1, receipt_text_copies: 0,
      avoided_receipt_text_bytes: Buffer.byteLength(JSON.stringify(result.structuredContent)),
    }));
  });
  test("write permission cannot be promoted by provider annotations", async () => {
    const { call, calls } = setup();
    const denied = await call("read_subnet_mcp", { ...args, tool_name: "write" });
    assert.equal(denied.structuredContent.error.code, "operation_not_allowed");
    assert.equal(calls.length, 0);
    assert.equal((await call("write_subnet_mcp", { ...args, tool_name: "write", arguments: {} })).isError, false);
    assert.equal(definition("read_subnet_mcp").annotations?.readOnlyHint, true);
    assert.equal(definition("write_subnet_mcp").annotations?.readOnlyHint, false);
  });
  test("public schemas exclude arbitrary endpoints and bound names, time and JSON arguments", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(definition("read_subnet_mcp").inputSchema);
    assert.equal(validate(args), true);
    for (const invalid of [{ ...args, url: "https://other.example" }, { ...args, timeout_ms: 30_001 }, { ...args, tool_name: "" }, { ...args, arguments: [] }]) assert.equal(validate(invalid), false);
    const { call, calls } = setup();
    assert.equal((await call("read_subnet_mcp", { ...args, timeout_ms: 30_001 })).isError, true);
    assert.equal(calls.length, 0);
  });
  test("missing admission, invalid admission and unsafe metadata refuse network work", async () => {
    for (const [rows, code] of [
      [[], "not_found"], [[{ ...surface, mcp: undefined }], "not_found"],
      [[{ ...surface, mcp: { ...surface.mcp, transport: "http" } }], "invalid_registry"],
      [[{ ...surface, public_safe: false }], "invalid_registry"], [[{ ...surface, kind: "docs" }], "invalid_registry"],
    ] as const) {
      const { call, calls } = setup([...rows]);
      assert.equal((await call("read_subnet_mcp", args)).structuredContent.error.code, code);
      assert.equal(calls.length, 0);
    }
  });
  test("stable keys resolve to canonical ids", async () => {
    const { call } = setup();
    for (const surface_id of [surface.key, "old-fixture"])
      assert.equal((await call("read_subnet_mcp", { ...args, surface_id })).structuredContent.surface_id, surface.id);
  });
  test("MCP admission never widens the ordinary HTTP caller", async () => {
    const { call, calls } = setup();
    assert.equal((await call("call_subnet_surface", { surface_id: surface.id })).isError, true);
    assert.equal(calls.length, 0);
  });
  test("credential errors reject before initialization", async () => {
    for (const [row, credential, code] of [
      [surface, "secret", "invalid_params"],
      [{ ...surface, auth_required: true, auth: { scheme: "bearer", location: "header", name: "Authorization" } }, undefined, "auth_required"],
      [{ ...surface, auth_required: true, auth: { scheme: "signature", location: "body", names: ["signature"] } }, { signature: "signed" }, "credential_not_supported"],
    ] as const) {
      const { call, calls } = setup([row]);
      assert.equal((await call("read_subnet_mcp", { ...args, ...(credential !== undefined ? { credential } : {}) })).structuredContent.error.code, code);
      assert.equal(calls.length, 0);
    }
  });
  test("caller credentials remain in transport and not returned receipts", async () => {
    const row = { ...surface, auth_required: true, auth: { scheme: "bearer", location: "header", name: "Authorization" } };
    const { call, calls } = setup([row]);
    const result = await call("read_subnet_mcp", { ...args, credential: "Bearer caller-secret" });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.credential_source, "argument");
    assert.ok(calls.every(c => c.headers.get("authorization") === "Bearer caller-secret"));
    assert.ok(!JSON.stringify(result).includes("caller-secret"));
  });
  test("stored credentials use canonical identity and explicit credentials win", async () => {
    const row = { ...surface, auth_required: true, auth: { scheme: "api-key", location: "header", name: "x-key" } };
    const { readArtifact, fetchImpl, calls } = setup([row]);
    const values = new Map<string, string>();
    const env = { METAGRAPH_CONTROL: {
      get: async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null,
      put: async (key: string, value: string) => { values.set(key, value); },
    }, MCP_SURFACE_CREDENTIAL_SECRET: "fixture-encryption-key" } as unknown as ConfiguredSurfaceCredentialEnv;
    await storeSurfaceCredential(env, "account:7", surface.id, "stored-7");
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const ctx = { env, accountId: "7", readArtifact } as unknown as McpCtx;
    try {
      const tool = definition("read_subnet_mcp");
      const first = await tool.handler({ ...args, surface_id: surface.key }, ctx);
      assert.ok(first instanceof McpForwardedResult);
      assert.equal(first.value.credential_source, "stored");
      assert.ok(calls.every(c => c.headers.get("x-key") === "stored-7"));
      calls.length = 0;
      await tool.handler({ ...args, credential: "explicit-7" }, ctx);
      assert.ok(calls.every(c => c.headers.get("x-key") === "explicit-7"));
      await assert.rejects(tool.handler(args, { ...ctx, accountId: "8" }), (error: Row) => error.code === "auth_required");
      // The existing store tool can resolve this MCP-only surface as well.
      const registered = await definition("store_surface_credential").handler({ surface_id: surface.key, credential: "registered" }, ctx) as Row;
      assert.equal(registered.surface_id, surface.id);
    } finally { globalThis.fetch = previous; }
  });
  test("published surface and service projections share the admission contract", () => {
    assert.equal(McpSurfaceAdmissionSchema.safeParse(surface.mcp).success, true);
    assert.equal(SurfaceSchema.safeParse(surface).success, true);
    assert.equal(AgentCatalogServiceSchema.safeParse({ surface_id: surface.id, kind: surface.kind, base_url: surface.url, mcp: surface.mcp, auth: null }).success, true);
  });
});
