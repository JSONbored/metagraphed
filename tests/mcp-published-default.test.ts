// Does a tool serve the default it publishes? (#10306)
//
// Two did not, and the cross-surface sweep (#10217) found both on its first
// working run:
//
//   get_subnet_identity_history   publishes limit 100   served entry_count 0
//   get_chain_subnet_lifecycle    publishes limit  50   served 100
//
// The first is a CONFIDENT ZERO in the #9803 sense. `entry_count: 0` with no
// degraded marker reads as "this subnet has never changed its identity", and
// SN64 changed it on 2026-07-11. Passing `limit` explicitly returned the row,
// so the handler was right and nothing was applying the default.
//
// WHY A GATE AND NOT TWO FIXES. #10096 made the published `default` the single
// source on the REST side -- `limitSchema(max, fallback)` writes it and
// `routeValue` reads it back, so a handler cannot restate it. MCP dispatch does
// no schema validation (settled, #8942) and so consulted nothing; each of the
// 230 handlers applied its own default or none. 137 tools publish at least one.
// Fixing two of them leaves 135 relying on a handler remembering.
//
// So the assertion below is on the DISPATCH CHOKEPOINT -- the one function
// every tools/call passes through -- and it runs for every tool and every
// default the served schema advertises. There is no per-tool list to keep up to
// date, which is the point: a tool added tomorrow is covered the day it ships.
//
// Measured against `listToolDefinitions()`, the SERVED list, not `MCP_TOOLS`.
// The two differ (`stripSentinelIntegerBounds` runs in between) and the served
// one is what the caller was actually promised (#10280).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  handleMcpRequest,
  listToolDefinitions,
  validateToolArguments,
} from "../src/mcp-server.ts";
import {
  assertArtifactsBuilt,
  createLocalArtifactEnv,
} from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

/** The published defaults one served tool advertises, argument -> value. */
function publishedDefaults(tool: Row): [string, unknown][] {
  const properties = (tool.inputSchema?.properties ?? {}) as Record<
    string,
    Row
  >;
  return Object.entries(properties)
    .filter(([, schema]) => schema?.default !== undefined)
    .map(([name, schema]) => [name, schema.default]);
}

describe("a tool serves the default it publishes", () => {
  const tools = listToolDefinitions() as Row[];

  test("every published default reaches the handler when omitted", () => {
    const missed: string[] = [];
    let checked = 0;
    for (const tool of tools) {
      const defaults = publishedDefaults(tool);
      if (defaults.length === 0) continue;
      // The caller sent nothing. Whatever the schema says they get for that is
      // what the handler must receive.
      const resolved = validateToolArguments(tool, {}) as Row;
      for (const [name, value] of defaults) {
        checked += 1;
        if (JSON.stringify(resolved[name]) !== JSON.stringify(value)) {
          missed.push(
            `${tool.name}.${name}: publishes ${JSON.stringify(value)}, handler receives ${JSON.stringify(resolved[name])}`,
          );
        }
      }
    }
    assert.equal(
      missed.length,
      0,
      `${missed.length} published default(s) never reach the handler:\n${missed.join("\n")}`,
    );
    // Not a round number anyone chose -- it is however many the schemas
    // publish, and it exists so this test cannot quietly stop covering
    // anything. If it drops, a tool lost a default rather than this passing
    // more easily.
    assert.ok(
      checked >= 180,
      `only ${checked} published defaults were checked; the suite covered 189`,
    );
  });

  test("absent `arguments` resolves the same as an empty object", () => {
    // A tools/call may omit `arguments` entirely. That is the same request as
    // `arguments: {}` -- the caller supplied nothing either way -- and the
    // early return for it used to skip defaults altogether.
    for (const tool of tools) {
      if (publishedDefaults(tool).length === 0) continue;
      assert.deepEqual(
        validateToolArguments(tool, undefined as unknown as Row),
        validateToolArguments(tool, {}),
        `${tool.name} answers differently for absent vs empty arguments`,
      );
    }
  });
});

describe("the two tools #10306 was filed for, through the real dispatcher", () => {
  const call = async (name: string, args: Row): Promise<Row> => {
    await assertArtifactsBuilt();
    // The same cast tests/pagination-bound-parity.test.ts uses: the local
    // artifact env carries the readers these tools need and none of the 69
    // bindings the Worker Env type declares.
    const env = createLocalArtifactEnv() as unknown as Parameters<
      typeof handleMcpRequest
    >[1];
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    const body = (await response.json()) as Row;
    return (body?.result?.structuredContent ?? {}) as Row;
  };

  // The APPLIED limit each answer echoes, rather than the rows it carries.
  // The rows depend on what the local artifacts hold and both of these read a
  // tier that is empty here, so asserting on them would be asserting on
  // nothing -- two empty pages compare equal whatever the page size was. The
  // echoed `limit` is the field that actually diverged in production (100 vs
  // 50, null vs 100) and it is exactly as wrong locally when the default is
  // not applied.
  test("get_chain_subnet_lifecycle applies the 50 it publishes, not 100", async () => {
    const omitted = await call("get_chain_subnet_lifecycle", {});
    assert.equal(omitted.limit, 50);
    assert.deepEqual(
      omitted,
      await call("get_chain_subnet_lifecycle", { limit: 50 }),
      "omitting `limit` must be the same request as passing the published default",
    );
  });

  test("get_subnet_identity_history applies its published 100 rather than none", async () => {
    const omitted = await call("get_subnet_identity_history", { netuid: 1 });
    assert.equal(omitted.limit, 100);
    assert.deepEqual(
      omitted,
      await call("get_subnet_identity_history", { netuid: 1, limit: 100 }),
      "omitting `limit` must be the same request as passing the published default",
    );
  });
});
