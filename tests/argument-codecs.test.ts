// The three codecs over one canonical schema (#10787).
//
// A route publishes ONE parameter set. Each surface carries it in the shape its
// transport can hold, and each of those shapes is a LAYER over the same Zod
// object rather than a conversion written beside it:
//
//   wire     REST -- everything arrives as text off a query string
//   args     MCP  -- real JSON, plus the vocabulary affordances
//   graphql  GraphQL -- real JSON, plus the two conversions its type system
//            forces: a `Boolean` where a query string can only spell the words,
//            and a list where a query string can only spell a delimited string
//
// `graphql` is the one that was missing. It lived in `src/route-query.ts` as a
// hand-written switch over a `RouteShape` union, reached through a second table
// nothing else read -- which is how the surface came to decode differently from
// the gate that checks it (#10772).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  graphqlReshapes,
  routeQuerySchemasForPathname,
} from "../src/contracts.ts";
import { withBooleanWords } from "../src/mcp-list-query.ts";

describe("the graphql codec layer", () => {
  test("a real Boolean is accepted where the route publishes the words", () => {
    // `/subnets/{netuid}/endpoints` spells `pool_eligible` `["true","false"]`
    // because a query string has no boolean. GraphQL has one and publishes it.
    const schemas = routeQuerySchemasForPathname(
      "/api/v1/subnets/{netuid}/endpoints",
    );
    assert.ok(schemas, "the route must publish a query schema");
    const parsed = schemas.graphql.safeParse({ pool_eligible: true });
    assert.equal(parsed.success, true);
    assert.equal(
      (parsed.data as Record<string, unknown>).pool_eligible,
      "true",
    );
  });

  test("`false` converts too, not only `true`", () => {
    // Both arms, because a codec that only ever handled the truthy one would
    // pass every test written the obvious way and drop the filter that says
    // "exclude these".
    const schemas = routeQuerySchemasForPathname(
      "/api/v1/subnets/{netuid}/endpoints",
    );
    const parsed = schemas!.graphql.safeParse({ pool_eligible: false });
    assert.equal(parsed.success, true);
    assert.equal(
      (parsed.data as Record<string, unknown>).pool_eligible,
      "false",
    );
  });

  test("and the route's own spelling still parses, unchanged", () => {
    const schemas = routeQuerySchemasForPathname(
      "/api/v1/subnets/{netuid}/endpoints",
    );
    const parsed = schemas!.graphql.safeParse({ pool_eligible: "false" });
    assert.equal(parsed.success, true);
    assert.equal(
      (parsed.data as Record<string, unknown>).pool_eligible,
      "false",
    );
  });

  test("`args` does NOT convert -- the codec is per surface", () => {
    // The layers are not interchangeable, and a test that only ever checked the
    // permissive one would not notice them collapsing into each other. MCP's
    // spelling is the route's; its leniency is declared where it applies
    // (`withBooleanWords`), not by widening every surface at once.
    const schemas = routeQuerySchemasForPathname(
      "/api/v1/subnets/{netuid}/endpoints",
    );
    assert.equal(
      schemas!.args.safeParse({ pool_eligible: true }).success,
      false,
    );
  });

  test("a list is joined into the route's delimited string", () => {
    // `/api/v1/compare` bounds its arity with a regex because a query string
    // has no list type; GraphQL has one, so the SDL takes `[Int!]!`.
    const schemas = routeQuerySchemasForPathname("/api/v1/compare");
    assert.ok(schemas, "the route must publish a query schema");
    const parsed = schemas.graphql.safeParse({ netuids: [1, 7, 64] });
    assert.equal(parsed.success, true);
    assert.equal((parsed.data as Record<string, unknown>).netuids, "1,7,64");
  });

  test("a boolean the route ALREADY declares as one is left alone", () => {
    // The destination decides, never the value. Converting every boolean seen
    // is wrong wherever the route's own parameter is a real boolean:
    // `validator_economics(emission_gate_open: true)` became `"true"` and the
    // parse answered `emission_gate_open must be true or false` (#10772).
    const schemas = routeQuerySchemasForPathname(
      "/api/v1/validators/economics",
    );
    assert.ok(
      schemas?.plain.shape.emission_gate_open,
      "the route must still declare a REAL boolean parameter, or this test " +
        "passes by checking nothing",
    );
    const parsed = schemas.graphql.safeParse({ emission_gate_open: true });
    assert.equal(parsed.success, true);
    assert.equal(
      (parsed.data as Record<string, unknown>).emission_gate_open,
      true,
    );
  });
});

describe("graphqlReshapes", () => {
  // The predicate the argument boundary asks before deciding ownership: a
  // spelling the codec CONVERTS is one the route can still validate a line
  // later, so the route keeps its bounds and its published default. Reading
  // the two kinds and comparing them without asking this cost
  // `compare_validators(hotkeys: [])` its validation (#10772).
  const shapeOf = (path: string, name: string) => {
    const field = routeQuerySchemasForPathname(path)?.plain.shape[name];
    assert.ok(field, `${path} must still publish ${name}`);
    return graphqlReshapes(field as never);
  };

  test("a delimited string and a boolean-word enum reshape", () => {
    assert.equal(shapeOf("/api/v1/compare", "netuids"), true);
    assert.equal(
      shapeOf("/api/v1/subnets/{netuid}/endpoints", "pool_eligible"),
      true,
    );
  });

  test("a number and a REAL boolean pass through", () => {
    assert.equal(shapeOf("/api/v1/validators/economics", "limit"), false);
    assert.equal(
      shapeOf("/api/v1/validators/economics", "emission_gate_open"),
      false,
    );
  });
});

describe("withBooleanWords", () => {
  test("rewrites a JS boolean into the route's word spelling", () => {
    assert.deepEqual(
      withBooleanWords({ pool_eligible: true, kind: "subnet-api" }, [
        "pool_eligible",
      ]),
      { pool_eligible: "true", kind: "subnet-api" },
    );
    assert.deepEqual(
      withBooleanWords({ manual_review_required: false }, [
        "manual_review_required",
      ]),
      { manual_review_required: "false" },
    );
  });

  test("leaves the string form, and every other argument, untouched", () => {
    const args = { pool_eligible: "true", provider: "alpha" };
    assert.equal(withBooleanWords(args, ["pool_eligible"]), args);
  });

  test("only the NAMED keys are rewritten", () => {
    // A blanket "convert every boolean" is the bug this decoder exists to
    // avoid: a route with a real boolean filter would have its value rewritten
    // into a string it does not accept.
    assert.deepEqual(withBooleanWords({ other: true }, ["pool_eligible"]), {
      other: true,
    });
  });

  test("a null/undefined argument bag passes through", () => {
    assert.equal(withBooleanWords(null, ["pool_eligible"]), null);
    assert.equal(withBooleanWords(undefined, ["pool_eligible"]), undefined);
  });
});
