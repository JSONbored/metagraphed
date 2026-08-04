// The MCP quota table is DECLARED, so it needs the same bidirectional proof
// AUTH_REQUIRED_TOOL_NAMES gets: a list nothing checks is a list that drifts,
// and this one decides what callers are billed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

import {
  MCP_TOOL_COST_PATHS,
  mcpBatchCostUnits,
  mcpToolCostUnits,
} from "../src/mcp-tool-cost.ts";
import {
  DEFAULT_ROUTE_COST_WEIGHT,
  routeCost,
} from "../src/route-cost-weights.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";

const TOOL_NAMES = new Set(
  (MCP_TOOLS as Array<{ name: string }>).map((t) => t.name),
);

/** Each tool paired with the REST path its own description says it mirrors. */
function mirroredPaths(): Map<string, string> {
  const src = readFileSync(
    new URL("../src/mcp-server.ts", import.meta.url),
    "utf8",
  );
  const found = new Map<string, string>();
  for (const m of src.matchAll(
    /\n {4}name: "([a-z0-9_]+)",([\s\S]*?)(?=\n {4}name: "|$)/g,
  )) {
    const mirror = m[2]!
      .slice(0, 4000)
      .match(/Mirrors GET (\/api\/v1\/[a-z0-9{}/_-]*)/);
    if (mirror) found.set(m[1]!, mirror[1]!);
  }
  return found;
}

describe("MCP tool cost table", () => {
  test("every declared tool exists", () => {
    for (const name of Object.keys(MCP_TOOL_COST_PATHS)) {
      assert.ok(
        TOOL_NAMES.has(name),
        `${name} is priced but is not a registered MCP tool`,
      );
    }
  });

  test("every declared path is genuinely non-default", () => {
    for (const [name, path] of Object.entries(MCP_TOOL_COST_PATHS)) {
      assert.notEqual(
        routeCost(path).weight,
        DEFAULT_ROUTE_COST_WEIGHT,
        `${name} -> ${path} prices at the default; listing it says otherwise`,
      );
    }
  });

  // The regression guard: a new deep-history/AI tool that mirrors an expensive
  // REST route must be priced, or MCP silently resells it at 1 unit.
  test("a tool mirroring an expensive REST route is priced", () => {
    for (const [name, path] of mirroredPaths()) {
      if (routeCost(path).weight === DEFAULT_ROUTE_COST_WEIGHT) continue;
      assert.ok(
        name in MCP_TOOL_COST_PATHS,
        `${name} mirrors ${path} (${routeCost(path).family}) but is missing ` +
          `from MCP_TOOL_COST_PATHS, so it would bill at ` +
          `${DEFAULT_ROUTE_COST_WEIGHT} instead of ${routeCost(path).weight}`,
      );
    }
  });

  test("MCP prices the same work REST does", () => {
    // The headline case: an LLM generation cost 1 unit over MCP and 25 over REST.
    assert.equal(mcpToolCostUnits("ask"), routeCost("/api/v1/ask").weight);
    assert.equal(mcpToolCostUnits("list_chain_events"), 5);
    // An unlisted or absent tool keeps the default.
    assert.equal(mcpToolCostUnits("get_subnet"), DEFAULT_ROUTE_COST_WEIGHT);
    assert.equal(mcpToolCostUnits(undefined), DEFAULT_ROUTE_COST_WEIGHT);
  });

  test("a batch costs the sum of its parts, not one flat unit", () => {
    const call = (name: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name },
    });
    // Ten deep-history reads used to cost a single unit for the whole request.
    assert.equal(
      mcpBatchCostUnits(
        Array.from({ length: 10 }, () => call("list_chain_events")),
      ),
      50,
    );
    assert.equal(mcpBatchCostUnits(call("ask")), 25);
    // Non-tools/call methods still cost their own default each.
    assert.equal(
      mcpBatchCostUnits({ jsonrpc: "2.0", method: "tools/list" }),
      1,
    );
    // Never free, whatever arrives.
    assert.equal(mcpBatchCostUnits([]), DEFAULT_ROUTE_COST_WEIGHT);
    assert.equal(mcpBatchCostUnits(null), DEFAULT_ROUTE_COST_WEIGHT);
  });
});
