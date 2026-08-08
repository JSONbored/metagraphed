// `listQuerySchema(c)` and `listQuery(c)` describe the same parameters (#10080).
//
// The 34 collection list routes are the ones no hand-written `*QuerySchema` can
// cover: `listQuery()` GENERATES their 9-18 parameters from
// `API_QUERY_COLLECTIONS`, so a hand-written copy would be a second declaration
// of a computed thing — the exact failure #10073 removed one layer of.
//
// `listQuerySchema()` composes the same set from the same config so that 3/5
// can emit the published parameters from Zod and 4/5 can derive the MCP tool
// inputs from it. Until 3/5 flips the emission, the two producers coexist —
// which is precisely the window in which they could drift, and this is what
// makes that impossible rather than merely unlikely.
//
// Compared on the EMITTED JSON, canonically: openapi.json is written with
// sorted keys and Zod emits in declaration order, so a raw string compare
// reports every parameter as divergent and reads as catastrophic failure
// rather than as a bug in the comparison.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import {
  API_QUERY_COLLECTIONS,
  API_ROUTES,
  LIST_QUERY_ROUTE_EXTRAS,
  listQuerySchema,
} from "../src/contracts.ts";
import { stripSentinelIntegerBounds } from "../src/mcp-input-schema.ts";
import type { Row } from "./row-type.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Row;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Each property of the schema, as a published parameter carries it. */
function emitted(schema: z.ZodObject): Map<string, string> {
  const document = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Row;
  const out = new Map<string, string>();
  for (const [name, property] of Object.entries(
    (document.properties ?? {}) as Record<string, Row>,
  )) {
    const {
      $schema: _schema,
      description: _description,
      examples: _examples,
      ...rest
    } = property;
    out.set(name, canonical(stripSentinelIntegerBounds(rest)));
  }
  return out;
}

/** Every route built on this collection, with the parameters it publishes. */
function routesFor(collection: string): { path: string; parameters: Row[] }[] {
  return (API_ROUTES as Row[])
    .filter((route) => route.query_collection === collection)
    .map((route) => ({
      path: String(route.path),
      parameters: (route.query_parameters ?? []) as Row[],
    }));
}

const collections = Object.keys(API_QUERY_COLLECTIONS as Row);

describe("listQuerySchema mirrors the parameters listQuery publishes (#10080)", () => {
  test("every collection is reachable and at least one route uses it", () => {
    // A comparison that silently matched nothing is the failure mode here: it
    // would pass forever the moment the collection key stopped resolving.
    assert.ok(
      collections.length >= 20,
      `only ${collections.length} collections`,
    );
    const used = collections.filter((c) => routesFor(c).length > 0);
    assert.ok(used.length >= 20, `only ${used.length} collections are routed`);
  });

  for (const collection of collections) {
    const routes = routesFor(collection);
    if (routes.length === 0) continue;
    test(`${collection}: the schema and the route agree on every parameter`, () => {
      // `format` is appended by csvListQuery, and `exclude` narrows a route's
      // filters, so read both off the route rather than assuming.
      for (const route of routes) {
        const published = new Map(
          route.parameters.map((parameter) => [
            String(parameter.name),
            canonical(parameter.schema),
          ]),
        );
        const schema = emitted(
          listQuerySchema(collection, {
            // A route may add parameters on top of its collection's (#6571);
            // both producers read them from the same object.
            extend: LIST_QUERY_ROUTE_EXTRAS[route.path] ?? {},
            csvResponse: published.has("format"),
            exclude: [...published.keys()].length
              ? Object.keys(
                  (API_QUERY_COLLECTIONS as Row)[collection]
                    .filter_schemas as Row,
                ).filter((name) => !published.has(name))
              : [],
          }),
        );
        assert.deepEqual(
          [...schema.keys()].sort(),
          [...published.keys()].sort(),
          `${route.path}: parameter NAMES differ`,
        );
        for (const [name, want] of published) {
          assert.equal(
            schema.get(name),
            want,
            `${route.path} ?${name}: constraints differ`,
          );
        }
      }
    });
  }
});
