// Emit the published GraphQL type system from the Zod component registry.
//
// Until this module the GraphQL SDL was a THIRD hand-maintained mirror of the
// route contract, alongside the MCP tool schemas and the routes themselves --
// 5,146 lines of hand-written SDL that nothing generated. `validate:graphql-
// route-parity` compared the fields the SDL *declared* against the routes, so
// it caught a field whose type had drifted, but it could not see a route field
// the SDL never declared at all: a one-directional gate over a hand-written
// mirror.
//
// What that cost: 36 mirror types omitted 88 fields their component publishes
// (measured after excluding the 25 pagination views the resolvers build, which
// are not mirrors). Among them the completeness markers --
// `NominatorList.concentration_complete`, `RuntimeVersionHistory.
// coverage_complete`, `EmissionPipeline.matched_subnet_count` -- so a GraphQL
// client could read `nominator_gini` with no way to learn the concentration
// behind it was computed over a partial set. That is the confident-zeros
// failure (#9803) reached through a different door: a well-formed, confident
// answer with the caveat stripped off.
//
// Generating the types from the same Zod schemas the routes serve makes that
// class unrepresentable -- a field cannot go missing from a type derived from
// the schema that produces it.
//
// SCOPE. This module owns the type system: the object types every mirror is
// checked against by scripts/validate-graphql-component-parity.ts. The Query
// root and the resolver-built pagination views stay in src/graphql-sdl.ts --
// no rule derives the field name `subnet_health` from the path
// `/api/v1/subnets/{netuid}/health`, and a list view is a resolver's shape
// rather than a component's.
import { z } from "zod";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  type GraphQLFieldConfigMap,
  type GraphQLNullableOutputType,
} from "graphql";
import { openApiComponentRegistry } from "../openapi-registry.ts";

/** The subset of JSON Schema 2020-12 that Zod's emitter actually produces. */
interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  additionalProperties?: SchemaNode | boolean;
  description?: string;
  const?: unknown;
  enum?: unknown[];
}

/**
 * The escape hatch for a shape GraphQL's type system cannot express: a record
 * keyed by data (`field_sources`), a heterogeneous union, a recursive blob.
 *
 * Deliberately the SAME scalar the hand-written SDL used, so switching to
 * generation does not silently reclassify a field a client already reads.
 */
export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description:
    "Arbitrary JSON. Used where the shape is keyed by data (a record) or is a " +
    "heterogeneous union, neither of which GraphQL's type system can express.",
});

/**
 * Component schemas, keyed by the registry id that names them.
 *
 * `reused: "inline"` matches scripts/generate-openapi-zod-components.ts: with
 * "ref", Zod hoists nodes that are shared BY REFERENCE (every
 * ArtifactBaseSchema.extend() reuses the same schema_version node) into an
 * anonymous "__shared" bucket with no usable name. Inlining duplicates that
 * small shape per call site instead, which is what both emitters want.
 */
export function componentSchemas(): Record<string, SchemaNode> {
  const generated = z.toJSONSchema(openApiComponentRegistry, {
    target: "draft-2020-12",
    reused: "inline",
    uri: (id) => `#/components/schemas/${id}`,
  });
  return generated.schemas as Record<string, SchemaNode>;
}

/**
 * Registered components that are a SCALAR in GraphQL, not an object type.
 *
 * `EpochMillis` is an epoch-millisecond instant. GraphQL's `Int` is 32-bit
 * signed and every real epoch-ms value overflows it -- 1786323600000 against a
 * ceiling of 2147483647 -- so a non-null `Int` carrying one raises on every
 * request and nulls its whole surrounding object (#10215). Publishing it as
 * `Float` is the only spelling GraphQL has for the value, which is what the
 * hand-written SDL always did.
 *
 * This replaces a `/_at$/` test on the field name (#10386). The name was
 * standing in for a fact the schema never stated -- `z.int()` stamps the JS
 * safe-integer ceiling on every integer, count and instant alike, so
 * "maximum exceeds Int32" is true of all of them and the type genuinely
 * cannot tell. The heuristic rescued 7 fields and missed 8 that production
 * proves overflow, `SubnetOhlcArtifact.candles[].bucket_start` on 1371 of
 * 1371 observed candles among them. A DURATION (`duration_ms`, `age_ms`) is a
 * span rather than an instant and stays `z.int()` -> `Int`.
 */
const SCALAR_COMPONENTS: Readonly<Record<string, GraphQLScalarType>> = {
  EpochMillis: GraphQLFloat,
};

/** `#/components/schemas/Foo` -> `Foo`; anything else -> null. */
function refName(node: SchemaNode): string | null {
  const ref = node?.$ref;
  if (typeof ref !== "string") return null;
  const match = /#\/components\/schemas\/(.+)$/.exec(ref);
  return match ? match[1] : null;
}

/** Collapse `allOf` into one node so the caller sees a single object shape. */
function flattenAllOf(
  node: SchemaNode,
  resolve: (name: string) => SchemaNode | null,
): SchemaNode {
  if (!Array.isArray(node.allOf)) return node;
  const properties: Record<string, SchemaNode> = {};
  const required: string[] = [];
  for (const part of node.allOf) {
    const target = refName(part) ? resolve(refName(part)!) : part;
    if (!target) continue;
    const flat = flattenAllOf(target, resolve);
    Object.assign(properties, flat.properties ?? {});
    required.push(...(flat.required ?? []));
  }
  // The node's own properties win over the branches it composes.
  Object.assign(properties, node.properties ?? {});
  required.push(...(node.required ?? []));
  const merged: SchemaNode = { ...node, type: "object", properties, required };
  delete merged.allOf;
  return merged;
}

/**
 * Strip the `| null` arm Zod emits for a nullable field.
 *
 * Returns the remaining single branch, or null when the union is genuinely
 * heterogeneous (which becomes {@link JSONScalar}).
 */
function unwrapNullableUnion(node: SchemaNode): SchemaNode | null {
  const branches: SchemaNode[] | undefined = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches)) return null;
  const real = branches.filter((b) => b?.type !== "null");
  return real.length === 1 ? real[0] : null;
}

/** `subnet_health` / `subnetHealth` -> `SubnetHealth`. */
export function pascalCase(input: string): string {
  return input
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export interface EmittedTypes {
  /** Every object type, keyed by GraphQL type name. */
  types: Map<string, GraphQLObjectType>;
  /** Resolve a registry component id to its emitted type. */
  componentType(name: string): GraphQLObjectType | null;
  /**
   * Nested objects that had no registry id and took a path-derived name.
   *
   * Empty today: every nested object in the registry is a named component, so
   * every emitted type carries the name the registry gave it. A non-empty map
   * means a schema grew an inline nested object -- it still emits, under
   * `ParentFieldName`, but that name was invented here rather than chosen.
   */
  derivedNames: Map<string, string>;
  /**
   * Properties dropped because GraphQL cannot name them (`x-metagraphed`, an
   * OpenAPI vendor extension). Reported rather than renamed: inventing
   * `xMetagraphed` would publish a field name that appears in no contract.
   */
  unnameable: string[];
  /**
   * Properties typed `z.null()` -- the value is null and nothing else.
   *
   * GraphQL has no null type. Publishing one as `JSON` or `String` would
   * advertise a field a client can select and never learn anything from, so
   * these are dropped and reported instead. `ContractsArtifact.status_domain`
   * is the one today: the builder hardcodes `status_domain: null`, so the Zod
   * type is faithful and the field is vestigial.
   */
  nullOnly: string[];
}

/**
 * Can this schema's value be `null`?
 *
 * `required` and nullability are ORTHOGONAL in JSON Schema, and conflating them
 * is what made the first version of this emitter publish 797 fields as non-null
 * that the hand-written SDL correctly published as nullable. `required` means
 * THE KEY IS PRESENT. A Zod `.nullable()` field is required -- the key is always
 * there -- and its value may still be null, which the emitted schema states as
 * `anyOf: [{type: number}, {type: null}]`.
 *
 * Reading only `required` therefore promised a non-null `concentration` on a
 * route that answers `"concentration": null` in production today. GraphQL
 * enforces non-null at execution: the resolver returning null would not be a
 * documentation error, it would null the whole parent object and attach an
 * error to the response.
 *
 * `openapi.json` had this right all along -- it publishes both the `anyOf` and
 * the `required` entry, which together say exactly the true thing.
 */
function admitsNull(schema: SchemaNode | undefined): boolean {
  if (!schema) return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    if (admitsNull(branch)) return true;
  }
  return false;
}

/** A name the GraphQL spec allows: a letter or underscore, then word chars. */
function isNameable(key: string): boolean {
  return /^[_A-Za-z][_A-Za-z0-9]*$/.test(key);
}

/**
 * Build the GraphQL object types for every registry component.
 *
 * Types are constructed with graphql-js rather than printed as SDL text: the
 * printer owns SDL syntax (escaping, block strings, field ordering), so this
 * module never concatenates schema source.
 */
export function emitTypes(): EmittedTypes {
  const schemas = componentSchemas();
  const types = new Map<string, GraphQLObjectType>();
  const derivedNames = new Map<string, string>();
  const unnameable: string[] = [];
  const nullOnly: string[] = [];
  const inFlight = new Set<string>();

  const resolve = (name: string): SchemaNode | null => schemas[name] ?? null;

  /**
   * Name an object that has no registry id of its own, and record that the
   * name was derived here rather than chosen by whoever wrote the schema.
   */
  function nameFor(path: string, fallback: string): string {
    derivedNames.set(path, fallback);
    return fallback;
  }

  function objectType(
    node: SchemaNode,
    typeName: string,
    path: string,
  ): GraphQLObjectType {
    const existing = types.get(typeName);
    if (existing) return existing;
    // Registered before walking fields so a self-referential component
    // (SubnetDetail.parent: SubnetDetail) resolves instead of recursing.
    const created = new GraphQLObjectType({
      name: typeName,
      description: node.description,
      fields: () => {
        const flat = flattenAllOf(node, resolve);
        const required = new Set<string>(flat.required ?? []);
        const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
        for (const [key, raw] of Object.entries<SchemaNode>(
          flat.properties ?? {},
        )) {
          if (!isNameable(key)) {
            unnameable.push(`${path}.${key}`);
            continue;
          }
          if (raw?.type === "null") {
            nullOnly.push(`${path}.${key}`);
            continue;
          }
          const inner = outputType(
            raw,
            `${path}.${key}`,
            `${typeName}${pascalCase(key)}`,
          );
          fields[key] = {
            // BOTH conditions. `required` alone says the key is present, which
            // is not the same claim as "the value is never null" -- see
            // `admitsNull`.
            type:
              required.has(key) && !admitsNull(raw)
                ? new GraphQLNonNull(inner)
                : inner,
            description: raw?.description,
          };
        }
        return fields;
      },
    });
    types.set(typeName, created);
    return created;
  }

  // Always a NULLABLE type: non-null is applied by the caller from the
  // component's `required` list, so this never returns a GraphQLNonNull.
  function outputType(
    node: SchemaNode,
    path: string,
    fallbackName: string,
  ): GraphQLNullableOutputType {
    if (!node || typeof node !== "object") return JSONScalar;

    const ref = refName(node);
    if (ref) {
      // Before resolving: a few registered components ARE a GraphQL scalar,
      // and which one is a fact about the component rather than its shape.
      const scalar = SCALAR_COMPONENTS[ref];
      if (scalar) return scalar;
      const target = resolve(ref);
      if (!target) return JSONScalar;
      // A registered component is not necessarily an OBJECT. The registry
      // names enum and scalar leaves too -- SurfaceKind, Authority,
      // HealthStatus, SubnetStatus and a dozen more -- and #10367 registered
      // more of them. This branch used to hand every $ref straight to
      // componentType(), which builds an object type and answers null for
      // anything with no field set, so each of those landed on JSONScalar.
      //
      // 348 emitted fields were typed JSON against 116 in the hand-written
      // SDL: generating from that would have retyped ~230 correctly-typed
      // fields as JSON, and no gate could see it -- the parity gate compares
      // nullability and Int-narrowing, not scalar identity.
      //
      // A $ref to a non-object emits what the target IS, by recursion.
      if (!target.properties && !target.allOf) {
        return outputType(target, path, fallbackName);
      }
      if (inFlight.has(ref)) return types.get(ref) ?? JSONScalar;
      inFlight.add(ref);
      const built = componentType(ref);
      inFlight.delete(ref);
      return built ?? JSONScalar;
    }

    const single = unwrapNullableUnion(node);
    if (single) return outputType(single, path, fallbackName);
    if (Array.isArray(node.anyOf ?? node.oneOf)) return JSONScalar;

    if (Array.isArray(node.allOf)) {
      return objectType(
        flattenAllOf(node, resolve),
        nameFor(path, fallbackName),
        path,
      );
    }

    if (node.type === "array") {
      const item = outputType(node.items ?? {}, `${path}[]`, fallbackName);
      return new GraphQLList(new GraphQLNonNull(item));
    }

    if (node.type === "object" || node.properties) {
      // A record (`additionalProperties` with no fixed keys) is keyed by data,
      // so it has no GraphQL field set -- that is what JSON is for.
      if (!node.properties || Object.keys(node.properties).length === 0)
        return JSONScalar;
      return objectType(node, nameFor(path, fallbackName), path);
    }

    // Before the `type` checks: z.literal(1) emits {type:"number", const:1},
    // and a pinned `schema_version: 1` is an Int, not a Float. Reading `type`
    // first would publish Float for all 68 components that pin it that way.
    if (node.const !== undefined) {
      if (typeof node.const === "number")
        return Number.isInteger(node.const) ? GraphQLInt : GraphQLFloat;
      if (typeof node.const === "boolean") return GraphQLBoolean;
      return GraphQLString;
    }

    // An INSTANT is a Float, not an Int -- but that is decided ABOVE, by the
    // `EpochMillis` component, not here. Until #10386 this branch tested the
    // field name (`/_at$/`) because a bare `z.int()` cannot say whether it
    // holds a count or an epoch. The name rescued 7 fields and missed 8 that
    // production proves overflow Int32, so the fact moved into the schema.
    // Everything reaching this line is a plain integer: a count, a block
    // height, a netuid, a duration in ms.
    if (node.type === "integer") return GraphQLInt;
    if (node.type === "number") return GraphQLFloat;
    if (node.type === "boolean") return GraphQLBoolean;
    if (node.type === "string") return GraphQLString;
    if (
      Array.isArray(node.enum) &&
      node.enum.every((v: unknown) => typeof v === "string")
    ) {
      return GraphQLString;
    }
    return JSONScalar;
  }

  function componentType(name: string): GraphQLObjectType | null {
    const schema = resolve(name);
    if (!schema) return null;
    const flat = flattenAllOf(schema, resolve);
    if (!flat.properties || Object.keys(flat.properties).length === 0)
      return null;
    return objectType(schema, name, name);
  }

  for (const name of Object.keys(schemas)) componentType(name);

  // graphql-js resolves `fields` lazily, which is what lets a self-referential
  // component build at all. Force every field map now that construction is
  // done: an invalid field name or a broken type reference should fail here,
  // where the schema is being built, rather than on the first query that
  // happens to select it -- and `unnameable` is only populated by that walk.
  for (const type of types.values()) type.getFields();

  return { types, componentType, derivedNames, unnameable, nullOnly };
}
