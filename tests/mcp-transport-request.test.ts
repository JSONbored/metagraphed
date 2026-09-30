import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, test, vi } from "vitest";
import { serveWithSdk, type SdkDispatch } from "../src/mcp-sdk-adapter.ts";
import {
  handleMcpRequest,
  listToolDefinitions,
  MAX_MCP_BODY_BYTES,
} from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const ENV = {} as unknown as Env;
const URL = "https://api.metagraph.sh/mcp";
const HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const request = (body?: string) =>
  new Request(URL, { method: "POST", headers: HEADERS, body });

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers],
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

async function throughSdk(raw: string, parsed: boolean, dispatch: SdkDispatch) {
  // Reproduce main's normalization and compare both SDK input paths. This
  // deliberately parses the original JSON before serializing it again.
  const serialized = JSON.stringify(JSON.parse(raw));
  return serveWithSdk(request(parsed ? undefined : serialized), {
    serverInfo: { name: "transport-fixture", version: "1" },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    dispatch,
    ...(parsed ? { parsedBody: JSON.parse(serialized) } : {}),
  });
}

describe("MCP normalized body handoff", () => {
  test("the public path supplies normalized JSON without another body stream", async () => {
    const transport = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "handleRequest",
    );
    const read = vi.spyOn(Request.prototype, "json");
    try {
      const response = await handleMcpRequest(
        request(
          '{"jsonrpc":"2.0","id":-0,"method":"ping","params":{"zero":-0,"positive":1e400,"negative":-1e400,"nested":[-0,1e400,{"__proto__":{"x":-0}}],"text":"τ 🧠\\ud800"}}',
        ),
        ENV,
      );
      assert.equal(response.status, 200);
      assert.equal(
        await response.text(),
        '{"result":{},"jsonrpc":"2.0","id":0}',
      );
      assert.equal(transport.mock.calls.length, 1);
      const [sdkRequest, options] = transport.mock.calls[0];
      assert.equal(sdkRequest.body, null);
      assert.equal(read.mock.calls.length, 0, "the SDK never reads req.json()");
      const body = options!.parsedBody as Row;
      assert.ok(Object.is(body.id, 0));
      const params = body.params as Row;
      assert.ok(Object.is(params.zero, 0));
      assert.equal(params.positive, null);
      assert.equal(params.negative, null);
      assert.deepEqual(params.nested, [
        0,
        null,
        JSON.parse('{"__proto__":{"x":0}}'),
      ]);
      assert.equal(params.text, "τ 🧠\ud800");
    } finally {
      read.mockRestore();
      transport.mockRestore();
    }
  });

  test.each([
    '{"jsonrpc":"2.0","id":-0,"method":"ping","params":{"n":-0}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fixture","arguments":{"n":1e400,"negative":-1e400,"nested":[-0,1e400],"text":"日本語 🧠\\ud800\\u0000"}}}',
    '{"jsonrpc":"2.0","id":1e400,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1,"method":"ping","params":null}',
    '[{"jsonrpc":"2.0","id":-0,"method":"ping","params":{"n":-0}},{"jsonrpc":"2.0","method":"notifications/initialized","params":{"n":1e400}},{"jsonrpc":"2.0","id":"τ","method":"fixture","params":{"n":-1e400}}]',
    '[{"jsonrpc":"2.0","method":"notifications/initialized","params":{"n":-0}},{"jsonrpc":"2.0","method":"notifications/progress","params":{"n":1e400}}]',
  ])("matches the streamed SDK's messages and wire bytes: %s", async (raw) => {
    const seen: Row[][] = [[], []];
    const responses = [];
    for (const [index, parsed] of [false, true].entries()) {
      responses.push(
        await snapshot(
          await throughSdk(raw, parsed, async (message) => {
            seen[index].push(message);
            return message.id === undefined
              ? null
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { params: message.params ?? {} },
                };
          }),
        ),
      );
    }
    assert.deepEqual(seen[1], seen[0]);
    assert.deepEqual(responses[1], responses[0]);
  });

  test.each(["full", "core", "discovery"] as const)(
    "%s catalog keeps identical schemas and response bytes through either input path",
    async (profile) => {
      const result = { tools: listToolDefinitions(profile) };
      const raw = '{"jsonrpc":"2.0","id":17,"method":"tools/list"}';
      const dispatch: SdkDispatch = async () => ({
        jsonrpc: "2.0",
        id: 17,
        result,
      });
      assert.deepEqual(
        await snapshot(await throughSdk(raw, true, dispatch)),
        await snapshot(await throughSdk(raw, false, dispatch)),
      );
    },
  );

  test("SDK header rejection still precedes parsed-body dispatch", async () => {
    const dispatch = vi.fn<SdkDispatch>();
    const response = await serveWithSdk(new Request(URL, { method: "POST" }), {
      serverInfo: { name: "headers", version: "1" },
      capabilities: {},
      dispatch,
      parsedBody: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    assert.equal(response.status, 406);
    assert.equal(dispatch.mock.calls.length, 0);
  });

  test("malformed mixed batches retain their direct-dispatch number semantics", async () => {
    const transport = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "handleRequest",
    );
    try {
      const response = await handleMcpRequest(
        request(
          '[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"1.0","id":2,"method":"ping"}]',
        ),
        ENV,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), [
        { jsonrpc: "2.0", id: 1, result: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32600, message: "Invalid JSON-RPC request." },
        },
      ]);
      assert.equal(transport.mock.calls.length, 0);
    } finally {
      transport.mockRestore();
    }
  });

  test("the original byte cap rejects before any parsed-body handoff", async () => {
    const transport = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "handleRequest",
    );
    try {
      const response = await handleMcpRequest(
        request(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "ping",
            params: { text: "x".repeat(MAX_MCP_BODY_BYTES) },
          }),
        ),
        ENV,
      );
      assert.equal(response.status, 413);
      assert.equal(transport.mock.calls.length, 0);
    } finally {
      transport.mockRestore();
    }
  });
});

// A bounded fixture benchmark runs in the existing CI test shard. It measures
// only body handoff, including Request construction and identical JSON
// normalization, not serving latency. Timings are evidence, never a CI gate.
test("fixture measurements of normalized MCP body handoff", async () => {
  const fixtures = [
    { name: "ping", body: { jsonrpc: "2.0", id: 1, method: "ping" } },
    {
      name: "initialize",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      },
    },
    {
      name: "ten-tool-batch",
      body: Array.from({ length: 10 }, (_, id) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "get_subnet", arguments: { netuid: id } },
      })),
    },
    {
      name: "large-unicode-tool",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "call_subnet_surface",
          arguments: {
            netuid: 1,
            surface_id: "fixture",
            body: { text: 'τ 🧠\n"\\'.repeat(3000) },
          },
        },
      },
    },
  ];
  const iterations = 100;
  const samples = 7;
  for (const fixture of fixtures) {
    const serialized = JSON.stringify(fixture.body);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    assert.ok(bytes <= MAX_MCP_BODY_BYTES);
    const legacy = async () => request(JSON.stringify(fixture.body)).json();
    const optimized = async () => {
      request();
      return JSON.parse(JSON.stringify(fixture.body));
    };
    assert.deepEqual(await legacy(), await optimized());
    for (let warmup = 0; warmup < 25; warmup++) {
      await legacy();
      await optimized();
    }
    const timings: number[][] = [[], []];
    for (let sample = 0; sample < samples; sample++) {
      // Alternate ordering so one path does not always inherit the other's GC.
      for (const index of sample % 2 ? [1, 0] : [0, 1]) {
        const run = [legacy, optimized][index];
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++)
          await run();
        timings[index].push((performance.now() - start) / iterations);
      }
    }
    const medians = timings.map(
      (values) => [...values].sort((a, b) => a - b)[3],
    );
    console.log(
      "MCP_BODY_HANDOFF_FIXTURE",
      JSON.stringify({
        fixture: fixture.name,
        bytes,
        iterations,
        samples,
        legacyMedianMs: medians[0],
        optimizedMedianMs: medians[1],
        savedPercent: 100 * (1 - medians[1] / medians[0]),
        removedUtf8EncodeBytes: bytes,
        removedUtf8DecodeBytes: bytes,
        removedRequestJsonReads: 1,
        node: process.version,
      }),
    );
  }
});
