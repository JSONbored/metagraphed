import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  hasSentinelIntegerBound,
  stripSentinelIntegerBounds,
} from "../src/mcp-input-schema.ts";
import { listToolDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

// `z.int()` carries JavaScript's safe-integer range as a real constraint, so
// every integer parameter published `maximum: 9007199254740991` whether or not anyone
// chose a bound — 198 of 287 of them. The cost was not the number itself but that it
// made a DELIBERATE `.max()` indistinguishable from the default, so "bounded" and
// "unbounded" rendered identically and an external consumer reasonably read an
// unbounded list parameter off the schema.

const MAX = Number.MAX_SAFE_INTEGER;
const MIN = Number.MIN_SAFE_INTEGER;

describe("stripSentinelIntegerBounds", () => {
  test("drops the sentinel bounds Zod adds to every integer", () => {
    assert.deepEqual(
      stripSentinelIntegerBounds({
        type: "integer",
        minimum: MIN,
        maximum: MAX,
      }),
      { type: "integer" },
    );
  });

  test("keeps a bound someone actually chose", () => {
    // The whole point: after this, a `maximum` means a decision.
    assert.deepEqual(
      stripSentinelIntegerBounds({ type: "integer", minimum: 0, maximum: 512 }),
      { type: "integer", minimum: 0, maximum: 512 },
    );
  });

  test("keeps an explicit minimum while dropping the implicit maximum", () => {
    assert.deepEqual(
      stripSentinelIntegerBounds({ type: "integer", minimum: 1, maximum: MAX }),
      { type: "integer", minimum: 1 },
    );
  });

  test("leaves non-integer types alone", () => {
    // On a `number` these bounds would be a deliberate, if odd, choice.
    const number = { type: "number", maximum: MAX };
    assert.deepEqual(stripSentinelIntegerBounds(number), number);
    const string = { type: "string", enum: ["a", "b"] };
    assert.deepEqual(stripSentinelIntegerBounds(string), string);
  });

  test("reaches integers nested anywhere a subschema can hide", () => {
    const out = stripSentinelIntegerBounds({
      type: "object",
      properties: {
        limit: { type: "integer", maximum: MAX },
        nested: {
          type: "array",
          items: { type: "integer", maximum: MAX },
        },
        either: {
          anyOf: [{ type: "integer", maximum: MAX }, { type: "string" }],
        },
      },
    }) as Row;
    const props = out.properties as Row;
    assert.equal((props.limit as Row).maximum, undefined);
    assert.equal(
      (((props.nested as Row).items as Row) || {}).maximum,
      undefined,
    );
    assert.equal(
      ((props.either as Row).anyOf as Array<Row>)[0].maximum,
      undefined,
    );
  });

  test("does not mutate its argument", () => {
    // The registry and the validator share these objects; normalising in place would
    // make the second read differ from the first.
    const input = { type: "integer", maximum: MAX };
    stripSentinelIntegerBounds(input);
    assert.equal(input.maximum, MAX);
  });

  test("is idempotent", () => {
    const once = stripSentinelIntegerBounds({ type: "integer", maximum: MAX });
    assert.deepEqual(stripSentinelIntegerBounds(once), once);
  });

  test("normalises a bare array of schemas", () => {
    // The registry hands whole objects in, but anyOf/prefixItems recurse as arrays and
    // the entry point accepts one directly.
    assert.deepEqual(
      stripSentinelIntegerBounds([
        { type: "integer", maximum: MAX },
        { type: "string" },
      ]),
      [{ type: "integer" }, { type: "string" }],
    );
  });

  test("drops the exclusive sentinels too", () => {
    // `z.int().gt()/.lt()` emit these instead of minimum/maximum, and they carry the
    // same safe-integer default.
    assert.deepEqual(
      stripSentinelIntegerBounds({
        type: "integer",
        exclusiveMaximum: MAX,
        exclusiveMinimum: MIN,
      }),
      { type: "integer" },
    );
    // A real exclusive bound survives.
    assert.deepEqual(
      stripSentinelIntegerBounds({ type: "integer", exclusiveMaximum: 10 }),
      { type: "integer", exclusiveMaximum: 10 },
    );
  });

  test("passes through primitives and null without throwing", () => {
    assert.equal(stripSentinelIntegerBounds(null), null);
    assert.equal(stripSentinelIntegerBounds(undefined), undefined);
    assert.equal(stripSentinelIntegerBounds(7), 7);
  });
});

describe("hasSentinelIntegerBound", () => {
  test("detects a sentinel and ignores a real bound", () => {
    assert.equal(
      hasSentinelIntegerBound({ type: "integer", maximum: MAX }),
      true,
    );
    assert.equal(
      hasSentinelIntegerBound({ type: "integer", maximum: 512 }),
      false,
    );
  });
});

describe("the published tool registry", () => {
  const tools = listToolDefinitions() as Array<Row>;

  test("publishes no safe-integer sentinel on any of the 215 tools", () => {
    const offenders = tools
      .filter((tool) => hasSentinelIntegerBound(tool.inputSchema))
      .map((tool) => tool.name);
    assert.deepEqual(offenders, []);
  });

  test("bounds the parameters that genuinely are bounded", () => {
    const props = (name: string) =>
      ((tools.find((tool) => tool.name === name)?.inputSchema as Row)
        ?.properties ?? {}) as Row;
    // netuid is a u16 on chain, and the REST routes reject outside that range.
    assert.equal(
      (props("get_subnet_validator_economics").netuid as Row).maximum,
      65535,
    );
    // A page size must agree with the ceiling its own route enforces.
    assert.equal(
      (props("list_validator_economics").limit as Row).maximum,
      512,
      "src/route-limits.ts is the single declaration of this",
    );
  });

  test("declares an enum wherever the description names a closed set", () => {
    const param = (name: string, key: string) =>
      ((
        (tools.find((tool) => tool.name === name)?.inputSchema as Row)
          ?.properties as Row
      )?.[key] ?? {}) as Row;
    assert.deepEqual(
      param("get_subnet_validator_economics_history", "window").enum,
      ["7d", "30d", "90d"],
    );
    assert.ok(
      Array.isArray(param("list_validator_economics", "sort").enum),
      "REST 400s on an unsupported sort; the schema has to say which are supported",
    );
    assert.ok(
      (param("call_rpc", "method").enum as string[])?.includes("system_health"),
      "a hard allowlist spelled out in prose belongs in the schema",
    );
  });

  test("states the fields syntax rather than leaving it to be guessed", () => {
    const fields = ((
      (tools.find((tool) => tool.name === "get_economics")?.inputSchema as Row)
        ?.properties as Row
    )?.fields ?? {}) as Row;
    assert.ok(fields.pattern, "comma-separated identifiers, declared");
    assert.match(String(fields.description), /[Cc]omma-separated/);
    // The declared pattern must accept what the projection layer accepts.
    const re = new RegExp(String(fields.pattern));
    assert.ok(re.test("netuid,name,slug"));
    assert.ok(!re.test('["netuid","name"]'), "not a JSON array");
    assert.ok(!re.test("netuid.name"), "no paths");
    assert.ok(!re.test(""), "an empty projection is an error, not everything");
    // The pattern must accept everything parseFieldsParam accepts: it trims each
    // segment and drops empty ones, so a tidier pattern would have clients rejecting
    // input the server takes — the defect this whole change is about.
    assert.ok(re.test("netuid, name"), "the parser trims");
    assert.ok(re.test("netuid,,name"), "the parser drops empty segments");
  });
});
