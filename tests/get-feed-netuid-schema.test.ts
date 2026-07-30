import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  MCP_TOOLS,
  requireAnyOf,
  requireFeedNetuidDependency,
} from "../src/mcp-server.ts";
import {
  FEED_KINDS,
  GetFeedInputSchema,
} from "../schemas-src/mcp-tools/feed.ts";
import type { Row } from "./row-type.ts";

describe("requireFeedNetuidDependency (#8829)", () => {
  test("emits subnet-required and non-subnet-forbidden anyOf branches", () => {
    const patched = requireFeedNetuidDependency(
      { type: "object", properties: { kind: {}, netuid: {} } },
      FEED_KINDS,
    );
    const anyOf = patched.anyOf as Row[];
    assert.equal(anyOf.length, 2);
    assert.deepEqual(anyOf[0], {
      properties: { kind: { const: "subnet" } },
      required: ["kind", "netuid"],
    });
    assert.deepEqual(anyOf[1], {
      properties: {
        kind: {
          enum: FEED_KINDS.filter((kind) => kind !== "subnet"),
        },
      },
      not: { required: ["netuid"] },
    });
  });

  test("derives the non-subnet enum from feedKinds, not a hardcoded list", () => {
    const patched = requireFeedNetuidDependency({ type: "object" }, [
      "subnet",
      "alpha",
      "beta",
    ] as const);
    const anyOf = patched.anyOf as Row[];
    assert.deepEqual(anyOf[1].properties.kind.enum, ["alpha", "beta"]);
  });

  test("leaves the base schema keys intact (same patch shape as requireAnyOf)", () => {
    const base = { type: "object", properties: { kind: { type: "string" } } };
    const patched = requireFeedNetuidDependency(base, FEED_KINDS);
    assert.equal(patched.type, "object");
    assert.deepEqual(patched.properties, base.properties);
    // Sibling helper still works and is exported.
    const any = requireAnyOf(base, ["kind", "netuid"]);
    assert.deepEqual(any.anyOf, [
      { required: ["kind"] },
      { required: ["netuid"] },
    ]);
  });
});

describe("get_feed published inputSchema netuid dependency (#8829)", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "get_feed");
  assert.ok(tool, "get_feed must be registered in MCP_TOOLS");
  const schema = tool.inputSchema as Row;
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
    schema,
  );

  test("publishes anyOf encoding the kind↔netuid dependency", () => {
    const anyOf = schema.anyOf as Row[];
    assert.ok(Array.isArray(anyOf));
    assert.equal(anyOf.length, 2);
    assert.deepEqual(anyOf[0].properties.kind, { const: "subnet" });
    assert.deepEqual(anyOf[0].required, ["kind", "netuid"]);
    assert.deepEqual(anyOf[1].properties.kind.enum, [
      ...FEED_KINDS.filter((kind) => kind !== "subnet"),
    ]);
    assert.deepEqual(anyOf[1].not, { required: ["netuid"] });
  });

  test("ajv rejects subnet without netuid and non-subnet with netuid", () => {
    assert.equal(validate({ kind: "subnet" }), false);
    assert.equal(validate({ kind: "registry", netuid: 64 }), false);
  });

  test("ajv accepts subnet with netuid and non-subnet without netuid", () => {
    assert.equal(validate({ kind: "subnet", netuid: 64 }), true);
    assert.equal(validate({ kind: "registry" }), true);
    assert.equal(validate({ kind: "upgrades" }), true);
  });

  test("Zod GetFeedInputSchema is unchanged (still parses subnet without netuid)", () => {
    // Runtime enforcement stays in resolveNetuid; the Zod type must not tighten.
    assert.doesNotThrow(() => GetFeedInputSchema.parse({ kind: "subnet" }));
    assert.doesNotThrow(() =>
      GetFeedInputSchema.parse({ kind: "registry", netuid: 64 }),
    );
  });
});
