// Published get_feed inputSchema must encode the conditional netuid rule
// that resolveNetuid enforces at runtime (#8829).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { MCP_TOOLS, requireFeedNetuidDependency } from "../src/mcp-server.ts";
import { FEED_KINDS, GET_FEED_MCP_TOOL } from "../src/feed-mcp.ts";
import { GetFeedInputSchema } from "../schemas-src/mcp-tools/feed.ts";
import type { Row } from "./row-type.ts";

describe("requireFeedNetuidDependency (#8829)", () => {
  test("emits subnet branch requiring netuid and non-subnet branch forbidding it", () => {
    const base = { type: "object", properties: { kind: {}, netuid: {} } };
    const patched = requireFeedNetuidDependency(base);
    const anyOf = patched.anyOf as Row[];
    assert.equal(anyOf.length, 2);
    assert.deepEqual(anyOf[0], {
      properties: { kind: { const: "subnet" } },
      required: ["kind", "netuid"],
    });
    const nonSubnet = FEED_KINDS.filter((kind) => kind !== "subnet");
    assert.deepEqual(anyOf[1], {
      properties: { kind: { enum: [...nonSubnet] } },
      not: { required: ["netuid"] },
    });
  });

  test("does not change GetFeedInputSchema Zod parsing", () => {
    assert.deepEqual(GetFeedInputSchema.parse({ kind: "subnet" }), {
      kind: "subnet",
    });
    assert.deepEqual(
      GetFeedInputSchema.parse({ kind: "registry", netuid: 64 }),
      { kind: "registry", netuid: 64 },
    );
  });
});

describe("get_feed published inputSchema netuid dependency (#8829)", () => {
  test("MCP_TOOLS get_feed inputSchema validates the conditional rule with ajv", () => {
    const tool = MCP_TOOLS.find((t: Row) => t.name === "get_feed");
    assert.ok(tool);
    const schema = tool.inputSchema as Record<string, unknown>;
    assert.ok(Array.isArray(schema.anyOf));
    assert.equal((schema.anyOf as Row[]).length, 2);

    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    assert.equal(validate({ kind: "subnet" }), false);
    assert.equal(validate({ kind: "registry", netuid: 64 }), false);
    assert.equal(validate({ kind: "subnet", netuid: 64 }), true);
    assert.equal(validate({ kind: "registry" }), true);
    assert.equal(validate({ kind: "upgrades" }), true);
    assert.equal(validate({ kind: "incidents", netuid: 1 }), false);
  });

  test("wrapper applied over GET_FEED_MCP_TOOL.inputSchema", () => {
    const tool = MCP_TOOLS.find((t: Row) => t.name === "get_feed");
    assert.ok(tool);
    const expected = requireFeedNetuidDependency(
      GET_FEED_MCP_TOOL.inputSchema as Record<string, unknown>,
    );
    assert.deepEqual(tool.inputSchema, expected);
  });
});
