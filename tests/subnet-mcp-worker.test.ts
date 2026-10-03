import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, test } from "vitest";
import type { Row } from "./row-type.ts";

const exact = "18446744073709551615";
const content = [
  { type: "text", text: 'exact "quoted" provider response\n' },
  { type: "image", mimeType: "image/png", data: "AQIDBA==" },
];
const inputSchema = {
  type: "object",
  required: ["payload"],
  additionalProperties: false,
  properties: { payload: { $ref: "#/$defs/payload" } },
  $defs: {
    payload: {
      type: "object",
      required: ["value"],
      additionalProperties: false,
      properties: { value: { type: "string", pattern: "^[0-9]+$" } },
    },
  },
};
const outputSchema = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: { $ref: "#/$defs/value" } },
  $defs: { value: { type: "string", pattern: "^[0-9]+$" } },
};
let runtime: Miniflare;

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import { runSubnetMcp, SubnetMcpError } from './src/subnet-mcp-client.ts';
        export default { async fetch(request) {
          const mode = new URL(request.url).searchParams.get('mode');
          const calls = [];
          const content = ${JSON.stringify(content)};
          const inputSchema = ${JSON.stringify(inputSchema)};
          const outputSchema = ${JSON.stringify(outputSchema)};
          const fetchImpl = async (url, init) => {
            if (String(url) !== 'https://subnet.example/mcp') throw new Error('Unmocked URL');
            const headers = new Headers(init.headers);
            const message = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
            calls.push({ method: init.method, message, headers: Object.fromEntries(headers) });
            if (init.method === 'GET') return new Response(null, { status: 405 });
            if (init.method === 'DELETE') return new Response(null, { status: 204 });
            if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
            let result;
            if (message.method === 'initialize') result = {
              protocolVersion: '2025-11-25', capabilities: { tools: {} },
              serverInfo: { name: 'worker-fixture', version: '1' }
            };
            else if (message.method === 'tools/list') result = {
              tools: ['read', 'write'].map(name => ({
                name, inputSchema, outputSchema,
                annotations: { readOnlyHint: name === 'write' }
              }))
            };
            else if (message.method === 'tools/call') result = {
              content,
              ...(mode === 'missing-output' ? {} : {
                structuredContent: { value: mode === 'invalid-output' ? 7 : message.params.arguments.payload.value }
              }),
              _meta: { fixture: 'workerd' }
            };
            else throw new Error('Unmocked protocol method');
            const data = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
            return new Response(mode === 'sse' ? 'event: message\\ndata: ' + data + '\\n\\n' : data, {
              headers: {
                'content-type': mode === 'sse' ? 'text/event-stream' : 'application/json',
                'mcp-session-id': 'worker-fixture-session'
              }
            });
          };
          // A missing SDK fetch override must fail, never reach a real provider.
          globalThis.fetch = async () => { throw new Error('External network forbidden'); };
          const options = {
            url: 'https://subnet.example/mcp', readTools: ['read'], writeTools: ['write'],
            credential: { location: 'header', name: 'Authorization', value: 'Bearer worker-fixture' },
            timeoutMs: 2000, fetchImpl, isUnsafeUrl: async () => false
          };
          const operation = mode === 'discover' ? { kind: 'discover' } : {
            kind: mode === 'write' ? 'write' : 'read',
            name: mode === 'write' || mode === 'denied-write' ? 'write' : 'read',
            arguments: { payload: { value: mode === 'invalid-input' ? 'bad' : ${JSON.stringify(exact)} } }
          };
          try {
            return Response.json({ result: await runSubnetMcp(options, operation), calls });
          } catch (error) {
            return Response.json({ error: { code: error instanceof SubnetMcpError ? error.code : 'unexpected', message: String(error) }, calls });
          }
        }};`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["node:crypto"],
    write: false,
  });
  runtime = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-06-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  });
}, 60_000);

afterAll(async () => runtime?.dispose());

async function invoke(mode: string): Promise<Row> {
  const response = await runtime.dispatchFetch(
    `https://worker-fixture.example/?mode=${mode}`,
  );
  assert.equal(response.status, 200);
  return (await response.json()) as Row;
}

for (const mode of ["json", "sse", "write"])
  test(`workerd ${mode} negotiation preserves native content and validates live schemas`, async () => {
    const { result, error, calls } = await invoke(mode);
    assert.equal(error, undefined);
    assert.deepEqual(result, {
      kind: "call",
      result: {
        content,
        structuredContent: { value: exact },
        _meta: { fixture: "workerd" },
      },
    });
    const messages = calls.filter((call: Row) => call.message);
    assert.deepEqual(
      messages.map((call: Row) => call.message.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    for (const call of calls) {
      assert.equal(call.headers.authorization, "Bearer worker-fixture");
      if (call.message?.method !== "initialize")
        assert.equal(call.headers["mcp-session-id"], "worker-fixture-session");
    }
    assert.ok(calls.some((call: Row) => call.method === "DELETE"));
  });

test("workerd discovery preserves nested provider schemas and reviewed admission", async () => {
  const { result, error, calls } = await invoke("discover");
  assert.equal(error, undefined);
  assert.equal(result.kind, "discover");
  assert.deepEqual(
    result.tools.map((tool: Row) => [tool.name, tool.access]),
    [
      ["read", "read"],
      ["write", "write"],
    ],
  );
  assert.deepEqual(result.tools[0].inputSchema, inputSchema);
  assert.deepEqual(result.tools[0].outputSchema, outputSchema);
  assert.equal(
    calls.some((call: Row) => call.message?.method === "tools/call"),
    false,
  );
});

for (const [mode, code] of [
  ["invalid-input", "invalid_params"],
  ["invalid-output", "upstream_mcp_error"],
  ["missing-output", "upstream_mcp_error"],
  ["denied-write", "operation_not_allowed"],
])
  test(`workerd rejects ${mode} through the real validator and protocol client`, async () => {
    const { result, error, calls } = await invoke(mode);
    assert.equal(result, undefined);
    assert.equal(error.code, code);
    assert.doesNotMatch(
      error.message,
      /External network forbidden|Unmocked|Code generation/,
    );
    if (mode === "denied-write") assert.equal(calls.length, 0);
    if (mode === "invalid-input")
      assert.equal(
        calls.some((call: Row) => call.message?.method === "tools/call"),
        false,
      );
  });
