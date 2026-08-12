// The MCP outbound tripwire, shown rejecting and shown passing (#10789).
//
// A tripwire that only ever reports zero is indistinguishable from one that is
// looking at nothing, and this epic has met several. So every claim here is
// driven both ways: it must throw on a drifted result, and it must not throw on
// a conforming one.
//
// The DERIVATION is the part most worth pinning. "Which schema describes this
// tool" is answered by the emitted schema itself, via the reference
// `outputJsonSchema` attaches -- there is no list, which is the whole lesson of
// #7860, whose five-route hand list was stale the day it landed. If that
// reference is ever dropped, every tool silently stops being validated and the
// tripwire reports success forever. The test below fails if it goes missing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import {
  outputJsonSchema,
  outputSchemaSource,
} from "../src/mcp-input-schema.ts";
import {
  McpResponseSchemaDriftError,
  validateMcpResponseTripwire,
} from "../src/mcp-response-tripwire.ts";

const Card = z.object({ netuid: z.int(), name: z.string() }).strict();

describe("the emitted schema carries its source", () => {
  test("outputSchemaSource resolves the Zod that produced it", () => {
    const published = outputJsonSchema(Card);
    const source = outputSchemaSource(published);
    assert.ok(source, "the derivation is the whole mechanism");
    assert.equal(source.safeParse({ netuid: 1, name: "a" }).success, true);
  });

  test("it is the DEGRADED-EXTENDED schema, not the argument", () => {
    // Dispatch can stamp `degraded` on any result, so the tripwire has to parse
    // against what the tool PUBLISHES rather than against what was handed in.
    const source = outputSchemaSource(outputJsonSchema(Card));
    assert.equal(
      source!.safeParse({
        netuid: 1,
        name: "a",
        degraded: { reason: "tier_unavailable" },
      }).success,
      true,
    );
  });

  test("it does not serialize into the published wire schema", () => {
    // `tools/list` publishes these objects verbatim; a stray property would
    // become part of the contract.
    const published = outputJsonSchema(Card);
    assert.equal(
      JSON.stringify(published).includes("outputSchemaSource"),
      false,
    );
    assert.deepEqual(
      Object.keys(published),
      Object.keys(JSON.parse(JSON.stringify(published))),
    );
  });

  test("a schema that did not come through the seam resolves to null", () => {
    assert.equal(outputSchemaSource({ type: "object" }), null);
    assert.equal(outputSchemaSource(null), null);
    assert.equal(outputSchemaSource("not a schema"), null);
  });
});

describe("validateMcpResponseTripwire", () => {
  test("THROWS on a result the tool's schema does not describe", () => {
    const published = outputJsonSchema(Card);
    assert.throws(
      () =>
        validateMcpResponseTripwire("get_subnet", published, {
          netuid: 1,
          name: "a",
          leaked: "internal",
        }),
      McpResponseSchemaDriftError,
    );
  });

  test("the error names the tool and carries the detail", () => {
    const published = outputJsonSchema(Card);
    try {
      validateMcpResponseTripwire("get_subnet", published, { netuid: "one" });
      assert.fail("expected a drift");
    } catch (err) {
      assert.ok(err instanceof McpResponseSchemaDriftError);
      assert.equal(err.tool, "get_subnet");
      assert.ok(err.detail, "the parse error rides along for triage");
    }
  });

  test("does NOT throw on a conforming result", () => {
    // The negative that makes the throw mean something: without it, a tripwire
    // that rejected everything would pass every test above.
    const published = outputJsonSchema(Card);
    assert.doesNotThrow(() =>
      validateMcpResponseTripwire("get_subnet", published, {
        netuid: 1,
        name: "a",
      }),
    );
  });

  test("a tripwire fault does NOT take the tool down with it", () => {
    // The REST tripwire's principle, kept here: a drift propagates because that
    // is the point, but the tripwire's OWN failure must not turn a working tool
    // into an error. A Proxy that throws on property access is the only way to
    // reach that arm -- which is itself the argument for keeping it.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("schema lookup exploded");
        },
      },
    );
    assert.doesNotThrow(() =>
      validateMcpResponseTripwire("get_subnet", hostile, { netuid: 1 }),
    );
  });

  test("a tool with no resolvable schema is skipped, not failed", () => {
    // It promised nothing, so there is nothing to hold it to. `validate:mcp`
    // owns the separate invariant that every tool publishes one.
    assert.doesNotThrow(() =>
      validateMcpResponseTripwire("mystery", { type: "object" }, { any: 1 }),
    );
    assert.doesNotThrow(() =>
      validateMcpResponseTripwire("mystery", undefined, { any: 1 }),
    );
  });
});
