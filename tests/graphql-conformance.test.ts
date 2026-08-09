// The parts of the production GraphQL sweep that do not need production.
//
// The transport is the half that needs the live surface; the query it builds
// and the comparison it makes are not, and a comparison nobody can test
// offline is a comparison nobody checks — the same split
// tests/mcp-conformance.test.ts draws for its MCP sibling (#10215).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSchema, parse } from "graphql";
import { SDL } from "../src/graphql-sdl.ts";
import {
  mirroredRoute,
  numericDivergences,
  planAll,
  planFor,
} from "../scripts/check-graphql-conformance.ts";

const schema = buildSchema(SDL);
const queryFields = schema.getQueryType()!.getFields();

describe("the GraphQL conformance sweep plans a real query per field", () => {
  test("every Query field is planned, or named as unfixtured", () => {
    const { plans, unfixtured } = planAll(schema);
    const total = Object.keys(queryFields).length;
    assert.equal(
      plans.length + unfixtured.length,
      total,
      "a field must be planned or reported, never silently skipped",
    );
    // The sweep's whole claim is coverage, so a fixture regression that halved
    // it must fail here rather than be reported as a clean run.
    assert.ok(
      plans.length > total * 0.95,
      `only ${plans.length} of ${total} fields are callable: ${unfixtured.join(", ")}`,
    );
  });

  test("every planned query parses", () => {
    // A generated query that does not parse would come back as an `errors[]`
    // finding and read exactly like a broken resolver.
    const { plans } = planAll(schema);
    for (const plan of plans) {
      assert.doesNotThrow(
        () => parse(plan.query),
        `${plan.field}: ${plan.query}`,
      );
    }
  });

  test("a field's required arguments are supplied, and its optional ones are not", () => {
    // The default answer is the one a caller gets first, and the one nothing
    // had ever checked.
    const plan = planFor(queryFields.subnet_registrations);
    assert.ok(plan);
    assert.match(plan.query, /^\{ subnet_registrations\(netuid: 64\) \{/);
    assert.ok(!plan.query.includes("window:"), plan.query);
  });

  test("a field whose required argument has no fixture is reported, not guessed", () => {
    const { unfixtured } = planAll(schema);
    // Guessing an amount for a stake quote would report the guess's failure as
    // the field's.
    assert.ok(unfixtured.length >= 1);
    for (const name of unfixtured) assert.ok(queryFields[name], name);
  });
});

describe("the mirrored route comes from the field's own description", () => {
  test("`Mirrors GET …` is read off the SDL", () => {
    assert.equal(
      mirroredRoute(
        "One subnet's health. Mirrors GET /api/v1/subnets/{netuid}/health.",
      ),
      "/api/v1/subnets/{netuid}/health",
    );
  });

  test("a field that names no route is compared against nothing", () => {
    assert.equal(mirroredRoute("A paginated index."), null);
    assert.equal(mirroredRoute(null), null);
  });

  test("most fields name one, or the comparison half is decorative", () => {
    const { plans } = planAll(schema);
    const mirrored = plans.filter((plan) => plan.mirrors).length;
    assert.ok(
      mirrored > 150,
      `only ${mirrored} fields declare the route they mirror`,
    );
  });
});

describe("the cross-surface comparison is deliberately narrow", () => {
  test("a number both surfaces report, and disagree on, is a finding", () => {
    // The #10246 class: same question, same second, two different totals.
    assert.deepEqual(
      numericDivergences({ transfer_count: 0 }, { transfer_count: 2859197 }),
      ["transfer_count: graphql 0, rest 2859197"],
    );
  });

  test("agreement is not a finding", () => {
    assert.deepEqual(numericDivergences({ total: 50 }, { total: 50 }), []);
  });

  test("a key only one surface reports is not compared", () => {
    // ~25 SDL types are resolver-built pagination views rather than mirrors of
    // an artifact. Diffing those wholesale is a category error that
    // manufactures findings — measured once at 161 reported, 3 real.
    assert.deepEqual(numericDivergences({ total: 50 }, { count: 40 }), []);
  });

  test("a key that is not a number on both sides is not compared", () => {
    assert.deepEqual(numericDivergences({ window: "7d" }, { window: 7 }), []);
    assert.deepEqual(numericDivergences({ limit: 50 }, { limit: "50" }), []);
  });

  test("a scalar answer has nothing to compare", () => {
    assert.deepEqual(numericDivergences(42, { total: 1 }), []);
    assert.deepEqual(numericDivergences(null, { total: 1 }), []);
  });
});
