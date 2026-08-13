// The generator assembles the published schema from the declared sources
// (#10214). These drive it with MUTATED declarations, because a generator only
// ever run against a passing tree proves it runs, not that it is reading what
// it claims to read.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSchema, isEnumType, isObjectType, printSchema } from "graphql";
import { buildGeneratedSchema } from "../schemas-src/graphql/build-schema.ts";
import { emitTypes } from "../schemas-src/graphql/emit.ts";
import {
  GRAPHQL_ENUMS,
  assertEnumVocabularies,
  enumFieldSites,
} from "../schemas-src/graphql/enums.ts";
import { SDL } from "../generated/graphql/schema.ts";
import {
  PROJECTED_TYPES,
  RETYPED_FIELDS,
} from "../schemas-src/graphql/published-names.ts";
import type { GraphQLObjectType } from "graphql";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as OpenApiParameters;

// ONE build for every test that reads the UNMODIFIED document (#10973's flake
// fix). Each `builtOnce` call is the full zod->GraphQL
// conversion -- seconds under coverage instrumentation -- and ten tests each
// paid it again for the same input, which is what pushed the heavy ones past
// the 30s ceiling on loaded runs. Tests that build a MODIFIED document still
// build their own; this instance is read-only by construction (every consumer
// asserts, none mutates).
const builtOnce = buildGeneratedSchema(openapi);

const sdl = SDL;

describe("the generated schema", () => {
  test("builds, and builds the whole published surface", () => {
    const { schema } = builtOnce;
    const objects = Object.entries(schema.getTypeMap()).filter(
      ([name, type]) => !name.startsWith("__") && isObjectType(type),
    );
    assert.ok(
      objects.length > 350,
      `expected the full type system, got ${objects.length}`,
    );
    assert.ok(schema.getQueryType(), "no Query root");
    assert.ok(schema.getSubscriptionType(), "no Subscription root");
  });

  test("prints without graphql-js rejecting it", () => {
    // The real proof that what was assembled is a SCHEMA and not a bag of
    // types: printSchema validates the whole graph on its way out.
    const printed = printSchema(builtOnce.schema);
    assert.ok(printed.includes("type Query {"));
    assert.ok(printed.includes("type Subscription {"));
    assert.ok(printed.includes("scalar JSON"));
  });

  test("a projection is published under ITS name, not its component's", () => {
    // `AccountsListArtifactAccounts` is not renamed, it is PROJECTED as
    // `AccountEntry`. Reading only PUBLISHED_TYPE_NAMES mints a second type for
    // a shape the schema already names -- which it did, until the reverse
    // lookup went through PROJECTED_TYPES too.
    const { schema } = builtOnce;
    assert.ok(schema.getType("AccountEntry"), "the projection name is missing");
    assert.equal(
      schema.getType("AccountsListArtifactAccounts"),
      undefined,
      "the component id must not also be published",
    );
  });

  test("the Query root carries the DERIVED arguments, not none", () => {
    const { schema } = builtOnce;
    const field = schema.getQueryType()!.getFields().subnet_registrations;
    assert.ok(field, "subnet_registrations is missing from the root");
    const args = field.args.map((a) => a.name);
    // A path parameter is a required argument -- a GraphQL field has no path.
    assert.ok(args.includes("netuid"), `expected netuid, got ${args}`);
    assert.equal(
      String(field.args.find((a) => a.name === "netuid")!.type),
      "Int!",
    );
  });

  test("EndpointIncident.source is published -- the omission the diff found", () => {
    // /api/v1/endpoint-incidents serves `source: "probe-derived"` on every row
    // and the SDL had no such field, so a caller could not select it. The
    // generator built it, the published schema did not have it, and the diff
    // said so. Asserted on the PUBLISHED schema, which is the one callers get.
    const published = buildSchema(sdl);
    const type = published.getType("EndpointIncident");
    assert.ok(isObjectType(type));
    // `String!` since the cutover: the route serves it on every row, the
    // producer cannot write null (compiler-checked), so the published promise
    // carries the Zod's non-null spelling (#10214).
    assert.equal(String(type.getFields().source?.type), "String!");
    assert.match(
      type.getFields().source?.description ?? "",
      /probe-derived/,
      "the field must say what it means",
    );
  });

  test("a projection naming a component nothing emits FAILS loudly", () => {
    // Not a silently-skipped type: the generator would otherwise publish a
    // schema quietly missing whatever that projection was for.
    assert.throws(
      () =>
        buildGeneratedSchema(openapi, {
          ...PROJECTED_TYPES,
          Subnet: { component: "NoSuchComponent", added: {}, dropped: [] },
        }),
      /Subnet names the absent component NoSuchComponent/,
    );
  });

  test("a type nothing declares FAILS loudly", () => {
    assert.throws(
      () =>
        buildGeneratedSchema(openapi, {
          ...PROJECTED_TYPES,
          Subnet: {
            ...PROJECTED_TYPES.Subnet,
            added: { invented: "NoSuchType" },
          },
        }),
      /nothing declares the type NoSuchType/,
    );
  });

  test("two projections over ONE component: the first declared wins", () => {
    // The reverse lookup has to pick one name, and picking non-deterministically
    // would make the generated schema depend on declaration order in a way
    // nothing states. First-wins, and a second projection over the same
    // component does not steal the reference.
    const { schema } = buildGeneratedSchema(openapi, {
      ...PROJECTED_TYPES,
      SubnetAlias: { ...PROJECTED_TYPES.Subnet },
    });
    assert.ok(schema.getType("Subnet"), "the first-declared name must survive");
  });

  test("a retype may change the named type, not the promise", () => {
    // The rule that keeps `RETYPED_FIELDS` from being a second hand-written
    // SDL. `SubnetVolume` -> `ChainAlphaVolumeSubnet` is a rename and passes;
    // dropping the `!` is a relaxed promise wearing a rename's spelling, and
    // it is the one direction a client can be broken by.
    assert.throws(
      () =>
        buildGeneratedSchema(openapi, PROJECTED_TYPES, {
          "ChainAlphaVolume.subnets": "[ChainAlphaVolumeSubnet!]",
        }),
      /changes more than the named type/,
    );
  });

  test("a JSON field may be retyped to any shape", () => {
    // The exception, and the direction the epic moves in: `JSON` carries no
    // shape, so replacing it cannot contradict anything. Both live entries
    // rely on this -- REST serves an un-flattened union and a window-keyed
    // record, neither of which GraphQL can spell.
    const { schema } = builtOnce;
    assert.equal(
      String(
        (schema.getType("SubnetTrajectory") as GraphQLObjectType).getFields()
          .deltas.type,
      ),
      "[SubnetTrajectoryDelta!]!",
    );
  });

  test("an enum site over a field that is not a String FAILS loudly", () => {
    // The emitter maps every registered Zod enum to `String`, so an enum site
    // naming anything else names a field that is not an enum -- a typo, not a
    // narrowing.
    assert.throws(
      () =>
        buildGeneratedSchema(
          openapi,
          PROJECTED_TYPES,
          RETYPED_FIELDS,
          new Map([["ChainEvent.block_number", "ChainFirehoseTable"]]),
        ),
      /declared as the enum ChainFirehoseTable, but its component emits/,
    );
  });

  test("one field cannot publish two enums", () => {
    assert.throws(
      () =>
        enumFieldSites({
          A: { description: "", values: [], from: [], fields: ["X.y"] },
          B: { description: "", values: [], from: [], fields: ["X.y"] },
        }),
      /X\.y is declared as both A and B/,
    );
  });

  test("an enum site inside a LIST keeps the list", () => {
    // The only live site is `ChainEvent.table: String!`, so the list arm of
    // the rewrap would otherwise never run -- and an enum published over
    // `[String!]!` is the obvious next one to declare.
    const { schema } = buildGeneratedSchema(
      openapi,
      PROJECTED_TYPES,
      RETYPED_FIELDS,
      new Map([["Gaps.missing_kinds", "ChainFirehoseTable"]]),
    );
    assert.equal(
      String(
        (schema.getType("Gaps") as GraphQLObjectType).getFields().missing_kinds
          .type,
      ),
      "[ChainFirehoseTable!]!",
      "the enum replaces the leaf, not the list around it",
    );
  });

  test("a projection may publish a component's promise NULLABLE", () => {
    // `formatLeaderboards` ranks each board off the fields that board sorts
    // by, so a row carries those and leaves the rest unset -- production
    // answers `open_slots[].miner_count: null` on every row. The component
    // keeps its promise (the full card fills all five on all 129 rows of
    // /api/v1/economics); only the view relaxes it.
    const entry = builtOnce.schema.getType(
      "OpportunityEntry",
    ) as GraphQLObjectType;
    assert.equal(String(entry.getFields().miner_count.type), "Int");
    // And the component it projects still promises it, so this is a relaxation
    // declared by the view rather than a hole in the contract.
    const { types } = emitTypes();
    assert.equal(
      String(types.get("SubnetEconomics")!.getFields().miner_count.type),
      "Int!",
    );
  });

  test("a type declared BOTH a projection and a mirror overlay FAILS loudly", () => {
    // Two answers to "what is this type's shape", and the builder cannot pick.
    assert.throws(
      () =>
        buildGeneratedSchema(
          openapi,
          PROJECTED_TYPES,
          RETYPED_FIELDS,
          enumFieldSites(),
          { SubnetHealth: { added: { invented: "String" } } },
        ),
      /both a projection of HealthSubnetSummary and a mirror overlay/,
    );
  });

  test("a mirror overlay drops the field it names", () => {
    // `Validator` is the union of two producers that spell one fact two ways;
    // the resolver publishes one spelling, so the other must not be served as
    // a permanent null beside the value it duplicates.
    const validator = builtOnce.schema.getType(
      "Validator",
    ) as GraphQLObjectType;
    assert.equal(validator.getFields().latest_captured_at, undefined);
    assert.ok(
      validator.getFields().captured_at,
      "the spelling the resolver DOES publish has to survive",
    );
  });

  test("the type set is what the ROOTS REACH", () => {
    // Publishing every registered component instead would advertise ~200 types
    // no query can select, which is a different contract from the served one.
    const { schema } = builtOnce;
    assert.equal(
      schema.getType("GenericArtifact"),
      undefined,
      "a component no root reaches must not be published",
    );
  });
});

describe("the published enums", () => {
  test("both are emitted, with their declared values", () => {
    const { schema } = builtOnce;
    for (const [name, declaration] of Object.entries(GRAPHQL_ENUMS)) {
      const type = schema.getType(name);
      assert.ok(isEnumType(type), `${name} is not an enum`);
      assert.deepEqual(
        type
          .getValues()
          .map((v) => v.name)
          .sort(),
        [...declaration.values].sort(),
      );
    }
  });

  test("the real declarations agree with their producers", () => {
    assert.deepEqual(assertEnumVocabularies(), []);
  });

  test("it FAILS on a value the producer does not have", () => {
    // The check that stops the enum inventing a network nothing serves.
    assert.deepEqual(
      assertEnumVocabularies({
        Network: {
          description: "",
          values: ["finney", "invented"],
          from: ["finney", "test"],
          excluded: { test: "under test" },
        },
      }),
      ["Network.invented -- the producer has no such value"],
    );
  });

  test("it FAILS on a producer value nobody published or excluded", () => {
    // The other direction, which is the silent one: a fifth firehose table
    // added to the producer and not here is a hole, not a narrowing.
    assert.deepEqual(
      assertEnumVocabularies({
        ChainFirehoseTable: {
          description: "",
          values: ["blocks"],
          from: ["blocks", "extrinsics"],
        },
      }),
      [
        "ChainFirehoseTable.extrinsics -- the producer publishes it, the enum " +
          "neither publishes nor declares it excluded",
      ],
    );
  });

  test("an exclusion the enum ALSO publishes fails -- it is one or the other", () => {
    assert.deepEqual(
      assertEnumVocabularies({
        Network: {
          description: "",
          values: ["finney"],
          from: ["finney"],
          excluded: { finney: "contradicts itself" },
        },
      }),
      ["Network.finney -- declared excluded, and the enum publishes it"],
    );
  });

  test("a stale exclusion fails, so the list only shrinks", () => {
    assert.deepEqual(
      assertEnumVocabularies({
        Network: {
          description: "",
          values: ["finney"],
          from: ["finney"],
          excluded: { retired: "gone from the producer" },
        },
      }),
      [
        "Network.retired -- declared excluded, but the producer no longer has " +
          "it (delete the entry)",
      ],
    );
  });
});

describe("the committed schema module", () => {
  // `report:graphql-schema-diff` and its classed comparison were migration
  // instruments: they measured the distance between the hand-written SDL and
  // the generated one, and #10214 closed that distance and deleted both the
  // SDL and the reports. What remains to pin is the cutover itself -- the
  // committed artifact IS a print of the generated schema (the drift gate
  // holds them byte-identical), so a mutated declaration that changes the
  // schema is caught by the byte comparison, which is stricter than any
  // classed diff was.
  test("is a print of the generated schema, not a survivor of the hand-written one", () => {
    const { schema } = builtOnce;
    assert.equal(`\n${printSchema(schema)}`, sdl);
  });
});
