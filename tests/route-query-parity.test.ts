// Every route resolves to a Zod query schema, and it says what the route
// publishes (#10062).
//
// `scripts/validate-route-query-parity.ts` is the CI gate and reports the full
// sweep. This is the same claim inside the suite, plus the branch coverage
// `querySchemaForRoute` needs as new `src/**` code — the resolver has four
// outcomes and three of them are only reachable with a route entry shaped a
// particular way.
//
// Both sides are compared on EMITTED JSON with keys canonically sorted:
// openapi.json is written sorted and Zod emits in declaration order, so a raw
// compare reports every parameter as divergent and reads as catastrophic
// failure rather than as a bug in the comparison.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import {
  API_QUERY_COLLECTIONS,
  API_ROUTES,
  querySchemaForRoute,
} from "../src/contracts.ts";
import {
  NO_QUERY_PARAMETERS,
  ROUTE_QUERY_SCHEMAS,
} from "../schemas-src/route-queries.ts";
import { stripSentinelIntegerBounds } from "../src/mcp-input-schema.ts";
import { type Row } from "./row-type.ts";

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

function constraints(schema: Row): string {
  const {
    $schema: _schema,
    description: _description,
    examples: _examples,
    ...rest
  } = schema;
  return canonical(stripSentinelIntegerBounds(rest));
}

function emittedProperties(schema: z.ZodObject): Map<string, string> {
  const document = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Row;
  return new Map(
    Object.entries((document.properties ?? {}) as Record<string, Row>).map(
      ([name, property]) => [name, constraints(property)],
    ),
  );
}

const routes = API_ROUTES as unknown as {
  path: string;
  method: string;
  query_collection?: string | null;
  query_filter_names?: string[];
  csv_response?: boolean;
  query_parameters?: { name: string; schema: Row }[];
}[];

describe("querySchemaForRoute resolves every route (#10062)", () => {
  test("no route is unclassified", () => {
    // A route resolving to null is a route whose query contract nobody wrote
    // down. That is a different claim from "takes no parameters", which is
    // what NO_QUERY_PARAMETERS says, and only one of the two should survive a
    // route quietly losing its parameters.
    const unclassified = routes
      .filter((route) => querySchemaForRoute(route) === null)
      .map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(
      unclassified,
      [],
      "add these to ROUTE_QUERY_SCHEMAS, or to NO_QUERY_PARAMETERS if they " +
        `genuinely accept none: ${unclassified.join(", ")}`,
    );
  });

  test("a route not in either list resolves to null", () => {
    // The fourth branch, and the one that cannot be reached from API_ROUTES
    // while the assertion above holds — so it is exercised directly rather
    // than left uncovered.
    assert.equal(
      querySchemaForRoute({ path: "/api/v1/not-a-route" }),
      null,
      "an unknown path must resolve to null, not to an empty schema — " +
        "otherwise a route that lost its parameters looks like one that " +
        "never had any",
    );
  });

  test("a NO_QUERY_PARAMETERS route resolves to a strict empty object", () => {
    const path = NO_QUERY_PARAMETERS[0];
    const schema = querySchemaForRoute({ path });
    assert.ok(schema, `${path} resolved to nothing`);
    assert.deepEqual([...emittedProperties(schema).keys()], []);
    // .strict(), so an unexpected argument is a parse error rather than a
    // silently dropped filter — the shape 5/5's safeParse will rely on.
    assert.equal(schema.safeParse({ netuid: 1 }).success, false);
  });

  test("a collection route resolves through listQuerySchema", () => {
    const route = routes.find((candidate) => candidate.query_collection);
    assert.ok(route, "no collection-backed route in API_ROUTES");
    const schema = querySchemaForRoute(route);
    assert.ok(schema);
    assert.ok(
      emittedProperties(schema).size >= 5,
      "a collection route generates 9-18 parameters; this resolved to almost none",
    );
  });

  test("a declared route resolves through ROUTE_QUERY_SCHEMAS", () => {
    const path = "/api/v1/health/trends";
    assert.ok(path in ROUTE_QUERY_SCHEMAS, `${path} left ROUTE_QUERY_SCHEMAS`);
    const schema = querySchemaForRoute({ path });
    assert.deepEqual(
      [...emittedProperties(schema as z.ZodObject).keys()].sort(),
      ["limit", "offset", "window"],
    );
  });

  test("a collection route with no kept filters keeps none of them", () => {
    // `query_filter_names` is the KEPT set and `route()` always supplies it,
    // so this fallback is unreachable from API_ROUTES. It is exercised rather
    // than annotated away because the behaviour matters if it ever IS reached:
    // absent means "keeps nothing", which drops the route's filters and makes
    // the parity gate fail loudly, instead of silently keeping all of them and
    // publishing filters the route does not accept.
    const collection = Object.keys(API_QUERY_COLLECTIONS as Row)[0];
    const schema = querySchemaForRoute({
      path: "/api/v1/synthetic",
      query_collection: collection,
    });
    assert.ok(schema);
    const names = [...emittedProperties(schema).keys()];
    const filters = Object.keys(
      (API_QUERY_COLLECTIONS as Row)[collection].filter_schemas as Row,
    );
    assert.deepEqual(
      names.filter((name) => filters.includes(name)),
      [],
      "no filter should survive when the kept set is absent",
    );
    // The non-filter parameters listQuerySchema always adds are still there,
    // so this is a narrowing rather than an empty schema.
    assert.ok(names.includes("fields") && names.includes("limit"));
  });

  test("an unknown collection throws rather than resolving to nothing", () => {
    assert.throws(
      () =>
        querySchemaForRoute({
          path: "/api/v1/whatever",
          query_collection: "not-a-collection",
        }),
      /Unknown API query collection/,
    );
  });
});

describe("each route's schema emits exactly what it publishes (#10062)", () => {
  for (const route of routes) {
    if (!(route.query_parameters ?? []).length) continue;
    test(`${route.method} ${route.path}`, () => {
      const schema = querySchemaForRoute(route);
      assert.ok(schema, "unclassified");
      const emitted = emittedProperties(schema);
      const published = new Map(
        (route.query_parameters ?? []).map((parameter) => [
          parameter.name,
          constraints(parameter.schema),
        ]),
      );
      assert.deepEqual(
        [...emitted.keys()].sort(),
        [...published.keys()].sort(),
        "parameter NAMES differ",
      );
      for (const [name, want] of published) {
        assert.equal(emitted.get(name), want, `?${name}: constraints differ`);
      }
    });
  }

  test("the comparison is not vacuous", () => {
    // Guards the guard: every assertion above passes on an empty route set,
    // and the failure mode of a schema sweep is silence.
    const withParameters = routes.filter(
      (route) => (route.query_parameters ?? []).length,
    );
    assert.ok(
      withParameters.length >= 134,
      `only ${withParameters.length} routes publish parameters`,
    );
    const declared = Object.keys(ROUTE_QUERY_SCHEMAS).length;
    assert.ok(declared >= 100, `only ${declared} routes are declared`);
    // 67, down from 69 (#10925): the two revenue routes moved OUT of this list
    // because they now take a real `?window=`. This is a vacuity floor, not a
    // ratchet -- it exists so the sweep above cannot pass on an empty set, and
    // a route legitimately gaining a parameter is the one reason it should
    // fall. `withParameters` rises by the same two.
    assert.ok(
      NO_QUERY_PARAMETERS.length >= 67,
      `only ${NO_QUERY_PARAMETERS.length} routes declare that they take none`,
    );
    assert.ok(
      Object.keys(API_QUERY_COLLECTIONS as Row).length >= 20,
      "the collection config shrank",
    );
  });

  test("a declared route and a no-parameter route are never both", () => {
    // The two lists answer the same question, so an overlap means one of them
    // is being ignored and nobody would know which.
    const both = NO_QUERY_PARAMETERS.filter(
      (path) => path in ROUTE_QUERY_SCHEMAS,
    );
    assert.deepEqual(both, [], `listed twice: ${both.join(", ")}`);
  });

  test("nothing is declared for a route that does not exist", () => {
    // A stale entry is the failure mode of every allowlist in this repo, and
    // it is what makes a list shrink-only.
    const paths = new Set(routes.map((route) => route.path));
    const stale = [
      ...Object.keys(ROUTE_QUERY_SCHEMAS),
      ...NO_QUERY_PARAMETERS,
    ].filter((path) => !paths.has(path));
    assert.deepEqual(stale, [], `no such route: ${stale.join(", ")}`);
  });
});
