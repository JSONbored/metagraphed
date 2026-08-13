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

// ── It validates the wire, not the handler's object (#10972) ────────────────
//
// `get_subnet_health` failed 46% of its calls (13 of 28 in 24h) with
// `response_schema_drift` on a response that was never wrong. A handler that
// spreads an object built from an ABSENT source leaves keys present with
// `undefined` -- `overlaySubnetHealth(null, ...)` produces `contract_version`,
// `generated_at`, `slug` and `name` that way. Zod `.strict()` keys on
// `Object.keys()` and counted all four; `JSON.stringify` drops them, so the
// client never saw one.
//
// The tripwire exists so a caller never receives a shape the contract does not
// describe. Rejecting a correct answer is the opposite of that, and it reached
// every agent calling the tool as a hard error.
describe("the tripwire validates what is sent, not what was built", () => {
  const published = outputJsonSchema(Card);

  test("an undefined-valued key does not fail a response that serializes clean", () => {
    // Exactly the shape a `{...spread}` of an absent artifact produces.
    const built = { netuid: 0, name: "root", contract_version: undefined };
    assert.equal(
      JSON.stringify(built),
      '{"netuid":0,"name":"root"}',
      "the premise: serialization drops the key, so the client never sees it",
    );
    assert.doesNotThrow(() =>
      validateMcpResponseTripwire("get_card", published, built),
    );
  });

  test("a key with a REAL value still fails", () => {
    // Guards the guard. If the fix had stripped keys rather than serializing,
    // or had loosened the schema, this is the case that would stop failing --
    // and undeclared keys reaching a caller is the whole reason this exists.
    assert.throws(
      () =>
        validateMcpResponseTripwire("get_card", published, {
          netuid: 0,
          name: "root",
          surprise: "shipped",
        }),
      McpResponseSchemaDriftError,
    );
  });

  test("a nested undefined-valued key is covered too", () => {
    // Why the round-trip rather than a shallow key filter: a one-level pass
    // would fix the case above and miss this one.
    const Nested = z
      .object({ netuid: z.int(), inner: z.object({ a: z.int() }).strict() })
      .strict();
    assert.doesNotThrow(() =>
      validateMcpResponseTripwire("get_nested", outputJsonSchema(Nested), {
        netuid: 0,
        inner: { a: 1, b: undefined },
      }),
    );
  });

  test("a genuinely missing required field still fails", () => {
    // Serializing must not paper over an absent value: `undefined` for a
    // REQUIRED key is a real drift, and it survives the round-trip as absence.
    assert.throws(
      () =>
        validateMcpResponseTripwire("get_card", published, {
          netuid: 0,
          name: undefined,
        }),
      McpResponseSchemaDriftError,
    );
  });

  test("a payload that cannot be serialized is left to the parse", () => {
    // A circular structure is a real fault; swallowing it would make the
    // tripwire report success on something it never checked.
    const circular: Record<string, unknown> = { netuid: 0, name: "root" };
    circular.self = circular;
    assert.throws(
      () => validateMcpResponseTripwire("get_card", published, circular),
      McpResponseSchemaDriftError,
    );
  });
});

// ── The alarm carries its diagnosis, and stays carrying it ─────────────────
//
// #10914 put the unrecognized keys into the message, because the message is
// the only thing the exception pipeline serializes -- `detail` never leaves
// the error object. #10917, a store refactor branched before that landed,
// removed it again with ZERO conflicts.
//
// Nothing asserted it, so nothing noticed. Production emitted a 64-character
// alarm naming no key for six hours, and diagnosing #10972 needed a local
// reproduction to recover what the error already knew.
//
// These exist so the next stale-base merge fails instead of passing.
describe("the drift alarm carries its diagnosis", () => {
  const published = outputJsonSchema(Card);

  function driftMessage(payload: unknown): string {
    try {
      validateMcpResponseTripwire("get_card", published, payload);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected a drift");
  }

  test("the message names the unrecognized key", () => {
    const message = driftMessage({
      netuid: 0,
      name: "root",
      surprise: "shipped",
    });
    assert.match(
      message,
      /surprise/,
      "the unrecognized key IS the diagnosis — an alarm without it sends " +
        "whoever reads it to a local reproduction",
    );
  });

  test("the message names the path of a wrong type", () => {
    assert.match(driftMessage({ netuid: "zero", name: "root" }), /netuid/);
  });

  test("it is bounded, so one alarm cannot carry a whole payload", () => {
    const message = driftMessage({
      netuid: 0,
      name: "root",
      ...Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`extra_${i}`, i]),
      ),
    });
    assert.ok(
      message.length < 600,
      `the alarm must stay bounded; got ${message.length} characters`,
    );
  });

  test("the tool name still leads, so grouping is unchanged", () => {
    // The fingerprint keys on tool + message; a diagnosis appended AFTER the
    // stable prefix keeps every drift of one tool in one issue.
    assert.ok(
      driftMessage({ netuid: 0, name: "root", surprise: 1 }).startsWith(
        "get_card result drifted from its published outputSchema",
      ),
    );
  });
});
