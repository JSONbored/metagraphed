import assert from "node:assert/strict";
import { test } from "vitest";
import {
  GraphQLObjectType,
  GraphQLSchema,
  graphql,
  isObjectType,
} from "graphql";
import { Ajv2020 } from "ajv/dist/2020.js";
import { emitTypes } from "../schemas-src/graphql/emit.ts";

// JSON Schema 2020-12 permits compact type arrays. Zod4.6.7's native
// regeneration exposed this spelling; the canonical dependency remains4.4.3.
// Drive the existing emitter with declarations, without upgrading the registry.
const primitives = {
  Sample: {
    type: "object",
    required: ["count", "amount", "enabled", "label", "required_label"],
    properties: {
      count: { type: ["integer", "null"], description: "Original count." },
      amount: { type: ["null", "number"] },
      enabled: { type: ["boolean", "null"] },
      label: { type: ["null", "string"] },
      required_label: { type: ["string"] },
      optional_count: { type: ["integer"] },
    },
  },
};

function fieldTypes(type: GraphQLObjectType) {
  return Object.fromEntries(
    Object.entries(type.getFields()).map(([name, field]) => [
      name,
      String(field.type),
    ]),
  );
}

test("compact nullable scalars preserve their types and required/nullability promises", () => {
  const before = JSON.stringify(primitives);
  const { types } = emitTypes(primitives);
  assert.deepEqual(fieldTypes(types.get("Sample")!), {
    count: "Int",
    amount: "Float",
    enabled: "Boolean",
    label: "String",
    required_label: "String!",
    optional_count: "Int",
  });
  assert.equal(
    types.get("Sample")!.getFields().count.description,
    "Original count.",
  );
  assert.equal(
    JSON.stringify(primitives),
    before,
    "emission cannot rewrite the supplied declaration",
  );
});

test("equivalent compact, anyOf and oneOf declarations emit the same scalar promises", () => {
  const { types } = emitTypes({
    Equivalent: {
      type: "object",
      required: ["compact", "any_of", "one_of"],
      properties: {
        compact: { type: ["number", "null"] },
        any_of: { anyOf: [{ type: "number" }, { type: "null" }] },
        one_of: { oneOf: [{ type: "null" }, { type: "number" }] },
      },
    },
  });
  assert.deepEqual(fieldTypes(types.get("Equivalent")!), {
    compact: "Float",
    any_of: "Float",
    one_of: "Float",
  });
});

test("nullable lists and nested object fields retain their declared structure", () => {
  const { types } = emitTypes({
    Container: {
      type: "object",
      required: ["values", "profile"],
      properties: {
        values: { type: ["array", "null"], items: { type: ["integer"] } },
        profile: {
          type: ["object", "null"],
          description: "Original profile.",
          required: ["score"],
          properties: { score: { type: ["number", "null"] } },
        },
      },
    },
  });
  assert.deepEqual(fieldTypes(types.get("Container")!), {
    values: "[Int!]",
    profile: "ContainerProfile",
  });
  const profile = types.get("ContainerProfile")!;
  assert.ok(isObjectType(profile));
  assert.equal(profile.description, "Original profile.");
  assert.deepEqual(fieldTypes(profile), { score: "Float" });
});

test("a null-only type array keeps the existing nullable String/reporting policy", () => {
  const { types, nullOnly } = emitTypes({
    Empty: {
      type: "object",
      required: ["compact", "plain"],
      properties: {
        compact: { type: ["null"], description: "Intentionally absent." },
        plain: { type: "null" },
      },
    },
  });
  assert.deepEqual(fieldTypes(types.get("Empty")!), {
    compact: "String",
    plain: "String",
  });
  assert.deepEqual(nullOnly, ["Empty.compact", "Empty.plain"]);
  assert.equal(
    types.get("Empty")!.getFields().compact.description,
    "Intentionally absent.",
  );
});

test("genuinely heterogeneous scalar and object unions remain JSON", () => {
  const { types } = emitTypes({
    Mixed: {
      type: "object",
      required: ["scalar", "object", "nonnull"],
      properties: {
        scalar: { type: ["integer", "string", "null"] },
        object: {
          type: ["object", "string", "null"],
          properties: { value: { type: "string" } },
        },
        nonnull: { type: ["number", "boolean"] },
      },
    },
  });
  assert.deepEqual(fieldTypes(types.get("Mixed")!), {
    scalar: "JSON",
    object: "JSON",
    nonnull: "JSON!",
  });
});

test("singleton type arrays preserve literal and enum scalar identity", () => {
  const { types } = emitTypes({
    Literals: {
      type: "object",
      required: ["version", "ratio", "flag", "kind"],
      properties: {
        version: { type: ["number"], const: 1 },
        ratio: { type: ["number"], const: 1.25 },
        flag: { type: ["boolean"], const: true },
        kind: { type: ["string", "null"], enum: ["a", "b", null] },
      },
    },
  });
  assert.deepEqual(fieldTypes(types.get("Literals")!), {
    version: "Int!",
    ratio: "Float!",
    flag: "Boolean!",
    kind: "String",
  });
});

test("GraphQL executes valid nullable values and enforces the scalar rather than JSON", async () => {
  const { types } = emitTypes(primitives);
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: { sample: { type: types.get("Sample")! } },
    }),
  });
  const source = "{ sample { count amount enabled label required_label } }";
  const good = await graphql({
    schema,
    source,
    rootValue: {
      sample: {
        count: 7,
        amount: 1.25,
        enabled: false,
        label: null,
        required_label: "present",
      },
    },
  });
  assert.equal(good.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(good.data)), {
    sample: {
      count: 7,
      amount: 1.25,
      enabled: false,
      label: null,
      required_label: "present",
    },
  });
  const invalid = await graphql({
    schema,
    source,
    rootValue: {
      sample: {
        count: "not-an-integer",
        amount: null,
        enabled: null,
        label: "visible",
        required_label: "present",
      },
    },
  });
  assert.equal(invalid.errors?.length, 1);
  assert.match(invalid.errors![0].message, /Int cannot represent/);
  assert.deepEqual(JSON.parse(JSON.stringify(invalid.data)), {
    sample: {
      count: null,
      amount: null,
      enabled: null,
      label: "visible",
      required_label: "present",
    },
  });
});


test("compact and composed nullable list items execute null without weakening non-null items", async () => {
  const items = [
    { type: ["integer", "null"] },
    { anyOf: [{ type: "integer" }, { type: "null" }] },
    { oneOf: [{ type: "integer" }, { type: "null" }] },
  ];
  for (const item of items) {
    const arrays = [
      { type: ["array", "null"], items: item },
      { anyOf: [{ type: "array", items: item }, { type: "null" }] },
      { oneOf: [{ type: "array", items: item }, { type: "null" }] },
    ];
    for (const array of arrays) {
      const validate = new Ajv2020({ strict: false }).compile(array);
      assert.equal(validate([1, null]), true);
      assert.equal(validate(null), true);
      const { types } = emitTypes({ Container: {
        type: "object", required: ["values"], properties: { values: array },
      } });
      assert.equal(fieldTypes(types.get("Container")!).values, "[Int]");
      const schema = new GraphQLSchema({ query: new GraphQLObjectType({
        name: "Query", fields: { sample: { type: types.get("Container")! } },
      }) });
      for (const values of [[1, null], null]) {
        const result = await graphql({ schema, source: "{ sample { values } }",
          rootValue: { sample: { values } } });
        assert.equal(result.errors, undefined);
        assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { sample: { values } });
      }
    }
  }
  const { types } = emitTypes({ Container: {
    type: "object", required: ["values"],
    properties: { values: { type: ["array", "null"], items: { type: "integer" } } },
  } });
  assert.equal(new Ajv2020().compile({ type: "array", items: { type: "integer" } })([1, null]), false);
  assert.equal(fieldTypes(types.get("Container")!).values, "[Int!]");
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({
    name: "Query", fields: { sample: { type: types.get("Container")! } },
  }) });
  const rejected = await graphql({ schema, source: "{ sample { values } }",
    rootValue: { sample: { values: [1, null] } } });
  assert.equal(rejected.errors?.length, 1);
  assert.deepEqual(rejected.errors![0].path, ["sample", "values", 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(rejected.data)), { sample: { values: null } });
});
