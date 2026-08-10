// Assemble the published GraphQL schema from the declared sources (#10214).
//
// This is the thing the epic exists to produce: `src/graphql-sdl.ts` is 5,409
// lines nothing generates, and every gate around it exists only because it is
// hand-written. Everything it contains is now declared somewhere else --
//
//   the object types          Zod, via `emitTypes()`
//   their published names     PUBLISHED_TYPE_NAMES / ALIASED_TYPE_NAMES
//   the projections           PROJECTED_TYPES (added/dropped/itemsFrom/totalFrom)
//   the Query root            QUERY_BINDINGS + `deriveQueryArguments`
//   the Subscription root     SUBSCRIPTION_BINDINGS
//   the enums and the scalar  GRAPHQL_ENUMS / `JSONScalar`
//
// -- so this reads those and returns a `GraphQLSchema`. It is built with
// graphql-js and printed by `printSchema`, never concatenated as text: the
// printer owns SDL syntax (escaping, block strings, field order), and a
// generator that assembled source strings would be a second, worse printer.
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parseType,
} from "graphql";
import type {
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputType,
  GraphQLNamedType,
  GraphQLNullableOutputType,
  GraphQLNullableType,
  GraphQLOutputType,
  GraphQLType,
  TypeNode,
} from "graphql";
import { JSONScalar, emitTypes } from "./emit.ts";
import { GRAPHQL_ENUMS } from "./enums.ts";
import {
  ALIASED_TYPE_NAMES,
  PROJECTED_TYPES,
  PUBLISHED_TYPE_NAMES,
  QUERY_BINDINGS,
  SUBSCRIPTION_BINDINGS,
} from "./published-names.ts";
import {
  deriveQueryArguments,
  type OpenApiParameters,
} from "./query-arguments.ts";

const SCALARS: Readonly<Record<string, GraphQLNamedType>> = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  ID: GraphQLID,
  JSON: JSONScalar,
};

/** Every published type, by name -- the schema's whole type namespace. */
export interface BuiltSchema {
  schema: GraphQLSchema;
  /** Published name -> the component it was built from, for reporting. */
  sources: Map<string, string>;
}

export function buildGeneratedSchema(
  openapi: OpenApiParameters,
  // Takes the projections so a test can drive the builder with a MUTATED
  // declaration -- a generator only ever run against a passing tree proves it
  // runs, not that it reads what it claims to.
  projections: Readonly<
    Record<string, (typeof PROJECTED_TYPES)[string]>
  > = PROJECTED_TYPES,
): BuiltSchema {
  const { types: emitted } = emitTypes();
  const sources = new Map<string, string>();

  /** Every published name declared OVER a component, for the reverse lookup. */
  const projectionOf = new Map<string, string>();
  for (const [published, projection] of Object.entries(projections)) {
    if (!projectionOf.has(projection.component)) {
      projectionOf.set(projection.component, published);
    }
  }

  /**
   * The name a component is published under.
   *
   * BOTH routes, and the projection one is easy to miss: `AccountsListArtifact
   * Accounts` has no `PUBLISHED_TYPE_NAMES` entry because it is not renamed --
   * it is PROJECTED, as `AccountEntry`. Reading only the rename map publishes
   * the component's own id and silently mints a second type for a shape the
   * schema already names.
   */
  function publishedName(component: string): string {
    return (
      PUBLISHED_TYPE_NAMES[component] ??
      projectionOf.get(component) ??
      component
    );
  }

  /** Published name -> the component that supplies its fields. */
  const componentFor = new Map<string, string>();
  for (const [component] of emitted) {
    const published = publishedName(component);
    if (!componentFor.has(published)) componentFor.set(published, component);
    const alias = ALIASED_TYPE_NAMES[component];
    if (alias && !componentFor.has(alias)) componentFor.set(alias, component);
  }
  for (const [published, projection] of Object.entries(projections)) {
    componentFor.set(published, projection.component);
  }

  const enums = new Map<string, GraphQLEnumType>();
  for (const [name, declaration] of Object.entries(GRAPHQL_ENUMS)) {
    enums.set(
      name,
      new GraphQLEnumType({
        name,
        description: declaration.description,
        values: Object.fromEntries(
          declaration.values.map((value) => [value, {}]),
        ),
      }),
    );
  }

  const built = new Map<string, GraphQLObjectType>();

  /** Resolve a NAME to its published type, building it on first use. */
  function named(name: string): GraphQLNamedType {
    const scalar = SCALARS[name];
    if (scalar) return scalar;
    const enumType = enums.get(name);
    if (enumType) return enumType;
    const existing = built.get(name);
    if (existing) return existing;
    const component = componentFor.get(name);
    if (!component) throw new Error(`nothing declares the type ${name}`);
    const source = emitted.get(component);
    if (!source)
      throw new Error(`${name} names the absent component ${component}`);
    const projection = projections[name];
    const type = new GraphQLObjectType({
      name,
      description: source.description ?? undefined,
      // A THUNK, so a type that references itself (or a cycle through two)
      // resolves rather than recursing while it is still being constructed.
      fields: () => {
        const fields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};
        const dropped = new Set(projection?.dropped ?? []);
        const renamed = new Map<string, string>();
        if (projection?.itemsFrom) renamed.set(projection.itemsFrom, "items");
        if (projection?.totalFrom) renamed.set(projection.totalFrom, "total");
        for (const [fieldName, field] of Object.entries(source.getFields())) {
          if (dropped.has(fieldName)) continue;
          fields[renamed.get(fieldName) ?? fieldName] = {
            type: republish(field.type),
            description: field.description ?? undefined,
          };
        }
        for (const [fieldName, added] of Object.entries(
          projection?.added ?? {},
        )) {
          fields[fieldName] = {
            type: fromSpelling(added) as GraphQLOutputType,
          };
        }
        return fields;
      },
    });
    built.set(name, type);
    sources.set(name, component);
    return type;
  }

  /** An emitted field's type, with every object swapped for its published one. */
  function republish(type: GraphQLOutputType): GraphQLOutputType {
    if (type instanceof GraphQLNonNull) {
      return new GraphQLNonNull(
        republish(
          type.ofType as GraphQLOutputType,
        ) as GraphQLNullableOutputType,
      );
    }
    if (type instanceof GraphQLList) {
      return new GraphQLList(republish(type.ofType as GraphQLOutputType));
    }
    if (type instanceof GraphQLObjectType) {
      return named(publishedName(type.name)) as GraphQLOutputType;
    }
    return type;
  }

  /**
   * `[SubnetHealth!]!` -> the built type.
   *
   * Returns the graphql-js union rather than an output or input type: the same
   * spelling is a field's type on one side and an argument's on the other, and
   * only the caller knows which. Both call sites narrow at the boundary.
   */
  function fromSpelling(spelling: string): GraphQLType {
    const walk = (node: TypeNode): GraphQLType => {
      if (node.kind === "NonNullType") {
        return new GraphQLNonNull(walk(node.type) as GraphQLNullableType);
      }
      if (node.kind === "ListType") return new GraphQLList(walk(node.type));
      return named(node.name.value);
    };
    return walk(parseType(spelling));
  }

  /** One root, assembled from its declared bindings. */
  function root(
    name: "Query" | "Subscription",
    bindings: typeof QUERY_BINDINGS,
    withArguments: boolean,
  ): GraphQLObjectType {
    return new GraphQLObjectType({
      name,
      fields: () =>
        Object.fromEntries(
          bindings.map((binding) => {
            const args: GraphQLFieldConfigArgumentMap = {};
            if (
              withArguments &&
              binding.route &&
              openapi.paths?.[binding.route]
            ) {
              const twin = binding.route.replace(
                "/api/v1/",
                "/api/v1/{network}/",
              );
              const returns = named(binding.returns.replace(/[![\]]/g, ""));
              for (const argument of deriveQueryArguments(
                binding.field,
                binding.route,
                openapi,
                {
                  hasNetworkTwin: Boolean(openapi.paths?.[twin]),
                  returnsProjectable:
                    returns instanceof GraphQLObjectType &&
                    !Object.values(returns.getFields()).some((field) =>
                      String(field.type).includes("JSON"),
                    ),
                },
              )) {
                args[argument.name] = {
                  type: fromSpelling(argument.type) as GraphQLInputType,
                };
              }
            }
            return [
              binding.field,
              {
                type: fromSpelling(binding.returns) as GraphQLOutputType,
                description: binding.description,
                ...(Object.keys(args).length ? { args } : {}),
              },
            ];
          }),
        ),
    });
  }

  const query = root("Query", QUERY_BINDINGS, true);
  const subscription = root("Subscription", SUBSCRIPTION_BINDINGS, false);
  // The type set is what the ROOTS REACH, which is what a GraphQL schema's
  // type set means -- graphql-js collects it while building. Publishing every
  // registered component instead would advertise ~200 types no query can
  // select, which is a different contract from the one served today.
  return {
    schema: new GraphQLSchema({
      query,
      subscription,
      types: [...enums.values(), JSONScalar],
    }),
    sources,
  };
}
