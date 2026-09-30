import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, describe, test, vi } from "vitest";
import {
  SearchToolsInputSchema,
  searchToolDefinitions,
} from "../src/mcp-tool-discovery.ts";
import { mockEnv, type Row } from "./row-type.ts";

const work = vi.hoisted(() => ({ calls: 0, bytes: 0, measureBytes: true }));
vi.mock("../src/mcp-input-schema.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/mcp-input-schema.ts")>();
  return {
    ...actual,
    stripSentinelIntegerBounds<T>(schema: T): T {
      work.calls++;
      if (work.measureBytes) {
        const json = JSON.stringify(schema);
        if (json !== undefined) work.bytes += Buffer.byteLength(json);
      }
      return actual.stripSentinelIntegerBounds(schema);
    },
  };
});
const { handleMcpRequest, MCP_TOOLS, MCP_SERVER_VERSION, listToolDefinitions } =
  await import("../src/mcp-server.ts");
const { resetModuleState } = await import("../src/module-state-registry.ts");
const searchTool = MCP_TOOLS.find((tool) => tool.name === "search_tools")!;
const selectedHandler = searchTool.handler;
// Retain the prior eager selection algorithm, using the same real dispatcher
// and complete schemas. Delegate unchanged validation errors to the handler.
const eagerHandler: typeof selectedHandler = async (args, ctx) => {
  const parsed = SearchToolsInputSchema.safeParse(args);
  if (!parsed.success) return selectedHandler(args, ctx);
  try {
    return searchToolDefinitions(
      listToolDefinitions(),
      parsed.data,
      ctx.env.CF_VERSION_METADATA?.id ?? MCP_SERVER_VERSION,
      ctx.searchPageSize,
    );
  } catch {
    return selectedHandler(args, ctx);
  }
};
const reset = () => {
  resetModuleState();
  work.calls = 0;
  work.bytes = 0;
};
afterEach(() => {
  searchTool.handler = selectedHandler;
  work.measureBytes = true;
  reset();
});
const version = "selective-fixture";
async function search(args: Row, path = "/mcp", protocol = "2025-06-18") {
  const response = await handleMcpRequest(
    new Request(`https://mcp.invalid${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": protocol,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_tools",
          arguments: {
            conversation_id: "019ff522-3838-7662-a07c-c3b66fd871fb",
            ...args,
          },
        },
      }),
    }),
    mockEnv({ CF_VERSION_METADATA: { id: version } }),
  );
  assert.equal(response.status, 200);
  const bytes = await response.text();
  return { bytes, body: JSON.parse(bytes) as Row };
}

describe("select tools before normalizing their complete definitions", () => {
  test("cold exact search normalizes only the selected definition and reuses it", async () => {
    reset();
    const first = await search({ query: "get_account_history" });
    assert.equal(first.body.result.isError, false);
    assert.equal(work.calls, 2, "one input and one output normalization");
    const initialBytes = work.bytes;
    assert.equal(
      (await search({ query: "get_account_history" })).bytes,
      first.bytes,
    );
    assert.equal(
      work.calls,
      2,
      "a repeated search reuses the immutable definition",
    );
    const full = listToolDefinitions();
    assert.equal(
      work.calls,
      full.length * 2,
      "full listing adds exactly the remaining definitions",
    );
    assert.deepEqual(
      first.body.result.structuredContent.tools,
      full.filter((tool) => tool.name === "get_account_history"),
    );
    assert.ok(initialBytes < work.bytes / 20);
  });

  test("modern and legacy response bytes equal the eager reference across profiles and page sizes", async () => {
    for (const path of [
      "/mcp",
      "/mcp/core",
      "/mcp?catalog=full",
      "/mcp?search_page_size=1",
      "/mcp?search_page_size=2",
    ]) {
      for (const protocol of ["2025-06-18", "2025-03-26"]) {
        for (const query of [
          "GET_ACCOUNT_HISTORY",
          "account",
          "subnet",
          "untrusted data",
          "no_such_capability_987",
        ]) {
          reset();
          searchTool.handler = eagerHandler;
          const eager = await search({ query }, path, protocol);
          reset();
          searchTool.handler = selectedHandler;
          const selected = await search({ query }, path, protocol);
          assert.equal(
            selected.bytes,
            eager.bytes,
            `${path}/${protocol}/${query}`,
          );
          const cursor = selected.body.result.structuredContent.next_cursor;
          if (cursor) {
            searchTool.handler = eagerHandler;
            const nextEager = await search({ query, cursor }, path, protocol);
            searchTool.handler = selectedHandler;
            assert.equal(
              (await search({ query, cursor }, path, protocol)).bytes,
              nextEager.bytes,
            );
          }
        }
      }
    }
  });

  test("invalid cursors, inputs and empty matches construct no definitions", async () => {
    for (const args of [
      { query: " " },
      { query: "account", unexpected: true },
      {
        query: "account",
        cursor: { version: "changed", query: "account", offset: 3 },
      },
      { query: "account", cursor: { version, query: "changed", offset: 3 } },
      {
        query: "account",
        cursor: { version, query: "account", offset: 10000 },
      },
      { query: "no_such_capability_987" },
    ]) {
      reset();
      const selected = await search(args);
      assert.equal(work.calls, 0);
      searchTool.handler = eagerHandler;
      assert.equal((await search(args)).bytes, selected.bytes);
      searchTool.handler = selectedHandler;
    }
  });

  test("every keyword match stays reachable and profile listings share immutable definitions", async () => {
    reset();
    const all = listToolDefinitions();
    const expected = all.filter((tool) =>
      `${tool.name} ${tool.title} ${tool.description}`
        .toLowerCase()
        .includes("account"),
    );
    reset();
    const found: Row[] = [];
    let cursor: Row | undefined;
    do {
      const { body } = await search({
        query: "account",
        ...(cursor ? { cursor } : {}),
      });
      const result = body.result.structuredContent;
      found.push(...result.tools);
      cursor = result.next_cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(found, expected);
    assert.equal(work.calls, expected.length * 2);
    const discovery = listToolDefinitions("discovery");
    const core = listToolDefinitions("core");
    const full = listToolDefinitions();
    assert.equal(work.calls, full.length * 2);
    assert.strictEqual(listToolDefinitions(), full);
    for (const profile of [discovery, core]) {
      assert.ok(Object.isFrozen(profile));
      for (const definition of profile) {
        assert.strictEqual(
          definition,
          full.find((tool) => tool.name === definition.name),
        );
        assert.ok(Object.isFrozen(definition));
        assert.ok(Object.isFrozen(definition.inputSchema));
        assert.throws(() => {
          (definition.inputSchema as Row).type = "changed";
        }, TypeError);
      }
    }
    reset();
    const rebuilt = listToolDefinitions();
    assert.equal(work.calls, rebuilt.length * 2);
    assert.deepEqual(rebuilt, full);
    assert.notStrictEqual(rebuilt[0], full[0]);
  });

  test("future definitions without an output schema retain omission and freezing", () => {
    const original = MCP_TOOLS.length;
    MCP_TOOLS.push({
      ...MCP_TOOLS[0],
      name: "fixture_schema_omission",
      outputSchema: undefined,
    });
    try {
      reset();
      const definition = listToolDefinitions().find(
        (tool) => tool.name === "fixture_schema_omission",
      );
      assert.ok(definition);
      assert.equal(Object.hasOwn(definition, "outputSchema"), false);
      assert.ok(Object.isFrozen(definition.inputSchema));
    } finally {
      MCP_TOOLS.splice(original);
      reset();
    }
  });

  test("reports cold catalog work and CPU separately from response size and production latency", async () => {
    const fixtures = [];
    for (const query of ["get_account_history", "account", "subnet"]) {
      reset();
      searchTool.handler = eagerHandler;
      const eager = await search({ query });
      const before = {
        normalizationCalls: work.calls,
        normalizedInputBytes: work.bytes,
      };
      reset();
      searchTool.handler = selectedHandler;
      const selected = await search({ query });
      assert.equal(selected.bytes, eager.bytes);
      const after = {
        normalizationCalls: work.calls,
        normalizedInputBytes: work.bytes,
      };
      assert.equal(
        after.normalizationCalls,
        selected.body.result.structuredContent.tools.length * 2,
      );
      assert.ok(after.normalizationCalls < before.normalizationCalls / 20);
      work.measureBytes = false;
      const eagerMs: number[] = [];
      const selectedMs: number[] = [];
      for (let i = 0; i < 9; i++) {
        for (const [handler, samples] of [
          [eagerHandler, eagerMs],
          [selectedHandler, selectedMs],
        ] as const) {
          reset();
          searchTool.handler = handler;
          const started = performance.now();
          await search({ query });
          samples.push(performance.now() - started);
        }
      }
      work.measureBytes = true;
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      fixtures.push({
        query,
        before,
        after,
        responseBytes: Buffer.byteLength(selected.bytes),
        eagerMedianMs: median(eagerMs),
        selectedMedianMs: median(selectedMs),
        samples: 9,
      });
    }
    console.log(
      "MCP_SELECTIVE_DISCOVERY_FIXTURE",
      JSON.stringify({
        runtime: process.version,
        fixtures,
        reference:
          "prior eager full-catalog strategy through the same real HTTP dispatcher; module-import cost excluded",
        measurement: "instrumented remote CI fixture, not production latency",
      }),
    );
  });
});
