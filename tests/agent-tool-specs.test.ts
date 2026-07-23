import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAgentToolsIndex,
  buildAnthropicToolSpecs,
  buildOpenAIToolSpecs,
} from "../src/agent-tool-specs.ts";

const TOOLS = [
  {
    name: "kb.search",
    description: "Search the KB",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  },
];

describe("agent tool spec builders", () => {
  test("buildOpenAIToolSpecs wraps each tool in the function-calling shape", () => {
    assert.deepEqual(buildOpenAIToolSpecs(TOOLS), [
      {
        type: "function",
        function: {
          name: "kb.search",
          description: "Search the KB",
          parameters: TOOLS[0].inputSchema,
        },
      },
    ]);
  });

  test("buildAnthropicToolSpecs maps inputSchema to input_schema", () => {
    assert.deepEqual(buildAnthropicToolSpecs(TOOLS), [
      {
        name: "kb.search",
        description: "Search the KB",
        input_schema: TOOLS[0].inputSchema,
      },
    ]);
  });

  test("both builders are empty for an empty tool list", () => {
    assert.deepEqual(buildOpenAIToolSpecs([]), []);
    assert.deepEqual(buildAnthropicToolSpecs([]), []);
  });

  test("buildAgentToolsIndex describes the spec files, tool names, and executor", () => {
    const idx = buildAgentToolsIndex(TOOLS);
    assert.equal(idx.schema_version, 1);
    // specs point at the published .well-known JSON, not inline spec arrays.
    assert.match(idx.specs.openai, /\/agent-tools\/openai\.json$/);
    assert.match(idx.specs.anthropic, /\/agent-tools\/anthropic\.json$/);
    // the index lists tool names, and the single uniform executor is the MCP endpoint.
    assert.deepEqual(idx.tools, ["kb.search"]);
    assert.deepEqual(Object.keys(idx.executor).sort(), [
      "endpoint",
      "jsonrpc_method",
      "transport",
    ]);
  });
});
