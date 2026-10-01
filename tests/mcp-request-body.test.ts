import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test, vi } from "vitest";
import { mcpRequestBodyBytes } from "../src/mcp-request-body.ts";
import { handleMcpRequest, MAX_MCP_BODY_BYTES } from "../src/mcp-server.ts";

const encoder = new TextEncoder();
const env = {} as unknown as Env;
const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function copyingBaseline(chunks: readonly Uint8Array[], total: number) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function streamedRequest(chunks: Uint8Array[], path = "/mcp") {
  let index = 0;
  return new Request(`https://api.metagraph.sh${path}`, {
    method: "POST",
    headers,
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

async function snapshot(chunks: Uint8Array[], path?: string) {
  const response = await handleMcpRequest(streamedRequest(chunks, path), env);
  return {
    status: response.status,
    headers: [...response.headers],
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

describe("MCP request body byte assembly", () => {
  test("one chunk retains its exact view without allocating or copying another buffer", () => {
    const backing = encoder.encode('ignored{"jsonrpc":"2.0"}ignored');
    const chunk = backing.subarray(7, backing.length - 7);
    const set = vi.spyOn(Uint8Array.prototype, "set");
    try {
      const bytes = mcpRequestBodyBytes([chunk], chunk.byteLength);
      assert.equal(bytes, chunk);
      assert.equal(bytes.buffer, backing.buffer);
      assert.equal(bytes.byteOffset, 7);
      assert.equal(set.mock.calls.length, 0);
      assert.equal(new TextDecoder().decode(bytes), '{"jsonrpc":"2.0"}');
    } finally {
      set.mockRestore();
    }
  });

  test("empty and multiple chunks preserve the copying path's bytes", () => {
    assert.deepEqual(mcpRequestBodyBytes([], 0), new Uint8Array());
    const chunk = encoder.encode("τ 🧠 日本語");
    const chunks = [
      chunk.subarray(0, 1),
      chunk.subarray(1, 5),
      chunk.subarray(5),
    ];
    const actual = mcpRequestBodyBytes(chunks, chunk.byteLength);
    assert.deepEqual(actual, copyingBaseline(chunks, chunk.byteLength));
    assert.notEqual(actual.buffer, chunk.buffer);
    assert.equal(new TextDecoder().decode(actual), "τ 🧠 日本語");
    assert.equal(mcpRequestBodyBytes([new Uint8Array()], 0).byteLength, 0);
  });

  test.each([
    '{"jsonrpc":"2.0","id":-0,"method":"ping","params":{"n":-0,"overflow":1e400,"text":"τ 🧠 日本語\\ud800"}}',
    '[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]',
    '[{"jsonrpc":"2.0","method":"notifications/initialized"}]',
    '[{"jsonrpc":"2.0","id":3,"method":"ping"},null]',
    '{"jsonrpc":"2.0","id":4,"method":"unknown"}',
    '{"jsonrpc":"2.0","id":5,"method":"ping","params":',
    "",
  ])(
    "single and fragmented bodies retain exact status, headers and response bytes: %s",
    async (raw) => {
      const bytes = encoder.encode(raw);
      const single = await snapshot([bytes]);
      const fragmented = await snapshot(
        Array.from(bytes, (_, i) => bytes.subarray(i, i + 1)),
      );
      assert.deepEqual(single, fragmented);
    },
  );

  test.each(["/mcp", "/mcp/core", "/mcp?catalog=full"])(
    "schema responses remain byte-identical across chunking at %s",
    async (path) => {
      const bytes = encoder.encode(
        '{"jsonrpc":"2.0","id":6,"method":"tools/list"}',
      );
      assert.deepEqual(
        await snapshot([bytes], path),
        await snapshot([bytes.subarray(0, 3), bytes.subarray(3)], path),
      );
    },
  );

  test("UTF-8 BOM and replacement decoding stay identical across boundaries", async () => {
    const prefix = encoder.encode('{"jsonrpc":"2.0","id":7,"method":"unknown-');
    const suffix = encoder.encode('"}');
    const bytes = new Uint8Array(3 + prefix.length + 2 + suffix.length);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(prefix, 3);
    bytes.set([0xc3, 0x28], 3 + prefix.length);
    bytes.set(suffix, 5 + prefix.length);
    assert.deepEqual(
      await snapshot([bytes]),
      await snapshot(Array.from(bytes, (_, i) => bytes.subarray(i, i + 1))),
    );
  });

  test("the exact body limit stays accepted and one extra byte stays rejected", async () => {
    const prefix = '{"jsonrpc":"2.0","id":8,"method":"ping","params":{"text":"';
    const suffix = '"}}';
    const bytes = encoder.encode(
      prefix +
        "x".repeat(MAX_MCP_BODY_BYTES - prefix.length - suffix.length) +
        suffix,
    );
    assert.equal(bytes.length, MAX_MCP_BODY_BYTES);
    assert.equal((await snapshot([bytes])).status, 200);
    const oversized = new Uint8Array(MAX_MCP_BODY_BYTES + 1);
    assert.equal((await snapshot([oversized])).status, 413);
    assert.deepEqual(
      await snapshot([oversized]),
      await snapshot([
        oversized.subarray(0, MAX_MCP_BODY_BYTES),
        oversized.subarray(MAX_MCP_BODY_BYTES),
      ]),
    );
  });
});

test("remote fixture records byte-copy work and paired assembly timings", () => {
  const fixtures = {
    initialize: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "body-fixture", version: "1" },
      },
    }),
    tool_call: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_subnet",
        arguments: { netuid: 19, network: "finney" },
      },
    }),
    batch: JSON.stringify(
      Array.from({ length: 16 }, (_, id) => ({
        jsonrpc: "2.0",
        id,
        method: "ping",
      })),
    ),
    near_limit: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
      params: { text: "x".repeat(60_000) },
    }),
  };
  const results = [];
  for (const [name, raw] of Object.entries(fixtures)) {
    const chunk = encoder.encode(raw);
    assert.deepEqual(
      mcpRequestBodyBytes([chunk], chunk.length),
      copyingBaseline([chunk], chunk.length),
    );
    const set = vi.spyOn(Uint8Array.prototype, "set");
    let baselineCopies: number;
    try {
      copyingBaseline([chunk], chunk.length);
      baselineCopies = set.mock.calls.length;
      set.mockClear();
      mcpRequestBodyBytes([chunk], chunk.length);
      assert.equal(set.mock.calls.length, 0);
      assert.equal(baselineCopies, 1);
    } finally {
      set.mockRestore();
    }
    const iterations = name === "near_limit" ? 200 : 2_000;
    const measure = (assemble: typeof mcpRequestBodyBytes) => {
      let checksum = 0;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        const bytes = assemble([chunk], chunk.length);
        checksum += bytes[0] + bytes[bytes.length - 1];
      }
      const elapsed = performance.now() - start;
      assert.equal(checksum, iterations * (chunk[0] + chunk[chunk.length - 1]));
      return elapsed / iterations;
    };
    measure(copyingBaseline);
    measure(mcpRequestBodyBytes);
    const baseline = [],
      optimized = [];
    for (let pair = 0; pair < 9; pair++) {
      if (pair % 2 === 0) {
        baseline.push(measure(copyingBaseline));
        optimized.push(measure(mcpRequestBodyBytes));
      } else {
        optimized.push(measure(mcpRequestBodyBytes));
        baseline.push(measure(copyingBaseline));
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[4];
    results.push({
      name,
      body_bytes: chunk.length,
      baseline_copies: baselineCopies,
      optimized_copies: 0,
      baseline_copied_bytes: chunk.length,
      optimized_copied_bytes: 0,
      baseline_ms: median(baseline),
      optimized_ms: median(optimized),
      iterations,
      pairs: 9,
    });
  }
  console.info(
    "MCP_BODY_ASSEMBLY_FIXTURE",
    JSON.stringify({ node: process.version, results }),
  );
});
