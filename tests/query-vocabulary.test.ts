// The published query parameters come from the Zod vocabulary, not from a
// second raw-JSON copy of it (#10073).
//
// `src/contracts.ts` used to declare `integerSchema` / `searchTextSchema` /
// `filterTextSchema` / `fieldListSchema` as raw literals beside the Zod
// builders in `schemas-src/query-params.ts`. Two declarations of one parameter
// drift, and these had: measured across the emitted openapi.json against the
// emitted MCP `inputSchema`s, 290 of 658 shared argument pairs disagreed.
//
// These tests pin the three facts that unification established, each of which
// was verified against production before being published:
//
//   netuid  is a u16 and now says so         (?netuid=70000 -> 400, was 200/0 rows)
//   fields  publishes the syntax it accepts  (?fields=netuid,%20name -> 200)
//   order   is a string enum on both surfaces
//
// `scripts/validate-query-vocabulary.ts` enforces the same rule across every
// published parameter; this file is the unit-level statement of WHY, and it
// fails without a build (the gate reads the emitted artifact, these read the
// in-process contract).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { API_QUERY_COLLECTIONS, API_ROUTES } from "../src/contracts.ts";
import {
  fieldsSchema,
  FIELDS_PATTERN,
  netuidSchema,
  orderSchema,
  querySchema,
  SEARCH_TEXT_MAX_LENGTH,
} from "../schemas-src/query-params.ts";
import { stripSentinelIntegerBounds } from "../src/mcp-input-schema.ts";
import type { Row } from "./row-type.ts";

/** The builder's constraints as a published parameter carries them. */
function published(schema: z.ZodType): Row {
  const emitted = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Row;
  const {
    $schema: _schema,
    description: _description,
    examples: _examples,
    ...rest
  } = emitted;
  return stripSentinelIntegerBounds(rest) as Row;
}

/** Every published query parameter of that name, across all routes. */
function parametersNamed(name: string): Row[] {
  return (API_ROUTES as Row[]).flatMap((route) =>
    ((route.query_parameters ?? []) as Row[])
      .filter((parameter) => parameter.name === name)
      .map((parameter) => parameter.schema as Row),
  );
}

describe("the published parameters are built from one vocabulary (#10073)", () => {
  test("netuid publishes the u16 ceiling wherever a collection filters on it", () => {
    const filters = Object.values(API_QUERY_COLLECTIONS as Row)
      .map((config) => (config as Row).filters as Row | undefined)
      .filter((f): f is Row => Boolean(f?.netuid))
      .map((f) => f.netuid);
    // 20 collections filter on netuid; a partial rollout would leave some
    // unbounded and this reads as passing if it asserts nothing.
    assert.ok(
      filters.length >= 15,
      `expected many netuid filters, got ${filters.length}`,
    );
    for (const filter of filters) {
      assert.deepEqual(filter, published(netuidSchema()));
    }
  });

  test("fields publishes the permissive syntax parseFieldsParam actually accepts", () => {
    const schemas = parametersNamed("fields");
    assert.ok(schemas.length > 0, "no route publishes `fields`");
    for (const schema of schemas) {
      assert.deepEqual(schema, published(fieldsSchema()));
    }
    // The old REST pattern rejected both of these; the route serves both, so a
    // client generated from the strict one refused input the server takes.
    const pattern = new RegExp(FIELDS_PATTERN);
    assert.ok(pattern.test("netuid, name"));
    assert.ok(pattern.test("netuid,,name"));
    assert.ok(!pattern.test("bogus!!"));
  });

  test("order is a typed string enum, not a bare enum", () => {
    const schemas = parametersNamed("order");
    assert.ok(schemas.length > 0, "no route publishes `order`");
    for (const schema of schemas) {
      // A route's own `default` is a per-route FACT, not a second declaration
      // of the vocabulary (#10060) -- the same split `limit` has, where the
      // ceiling is shared and the default is the route's. The constraints are
      // what must be identical, so they are what is compared, and the default
      // is checked against the enum it has to come from.
      const { default: fallback, ...constraints } = schema;
      assert.deepEqual(constraints, published(orderSchema()));
      assert.equal(schema.type, "string");
      if (fallback !== undefined) {
        assert.ok(
          (schema.enum as string[]).includes(fallback as string),
          `order default ${String(fallback)} is not one of its own values`,
        );
      }
    }
  });

  test("q carries the ceiling workers/list-query.ts enforces", () => {
    assert.deepEqual(published(querySchema()), {
      type: "string",
      maxLength: SEARCH_TEXT_MAX_LENGTH,
    });
  });

  test("the vocabulary never publishes Zod's safe-integer sentinel as a bound", () => {
    // A `maximum` of 2^53-1 is Zod's representation of "no bound"; publishing
    // it makes "deliberately unbounded" and "somebody forgot .max()" identical.
    for (const schema of [
      published(netuidSchema()),
      published(orderSchema()),
      published(fieldsSchema()),
    ]) {
      assert.notEqual(schema.maximum, Number.MAX_SAFE_INTEGER);
    }
  });
});
