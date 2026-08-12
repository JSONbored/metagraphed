// Assemble the published GraphQL schema from the declared sources (#10214).
//
// This is the thing the epic exists to produce: `src/graphql-sdl.ts` was
// 6,582 lines nothing generated, and every gate around it existed only
// because it was hand-written. #10214 deleted it -- the served SDL is now a
// print of the schema this module builds (`generated/graphql/schema.ts`,
// emitted by scripts/generate-graphql-types.ts and drift-gated). Everything
// it contained is declared somewhere else --
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
import { GRAPHQL_ENUMS, enumFieldSites } from "./enums.ts";
import {
  ALIASED_TYPE_NAMES,
  FIELD_ARGUMENT_ROUTES,
  MIRROR_OVERLAYS,
  PROJECTED_TYPES,
  PUBLISHED_TYPE_NAMES,
  QUERY_BINDINGS,
  RETYPED_FIELDS,
  SUBSCRIPTION_BINDINGS,
} from "./published-names.ts";
import {
  deriveQueryArguments,
  fieldsArgumentApplies,
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
  // Injectable for the same reason, and for one more: both rules `retype`
  // enforces THROW, and a rule that only ever runs against declarations known
  // to satisfy it is a rule nothing has shown can fail.
  retypedFields: Readonly<Record<string, string>> = RETYPED_FIELDS,
  enumSites: ReadonlyMap<string, string> = enumFieldSites(),
  overlays: Readonly<
    Record<string, (typeof MIRROR_OVERLAYS)[string]>
  > = MIRROR_OVERLAYS,
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

  /**
   * Published name -> EVERY component that supplies its fields.
   *
   * More than one is normal here, and load-bearing. `Validator` is published
   * over both `ValidatorDetailArtifact` and `GlobalValidatorsArtifactValidators`
   * -- the SDL's own comment says so: the list names its timestamps differently
   * and carries `featured`/`uid_count`/`stake_dominance` the detail does not.
   * Keeping only the first published ONE producer's shape as if it described
   * both, which lost the other's fields AND promised non-null for fields the
   * other cannot answer: `Validator.schema_version` and three `ValidatorSubnet`
   * fields came back null on every row of `validators` when
   * `conformance:graphql-nullability` asked production.
   */
  // A SET, so "already contributing" is structural rather than a branch. The
  // same component reaches `add` twice whenever a type's alias equals its
  // published name, and a conditional `includes` guard for that is a branch
  // nothing in the current registry exercises -- unreachable code guarding an
  // invariant the data structure can hold on its own.
  const componentsFor = new Map<string, Set<string>>();
  const add = (published: string, component: string) => {
    const existing = componentsFor.get(published);
    if (existing) existing.add(component);
    else componentsFor.set(published, new Set([component]));
  };
  for (const [component] of emitted) {
    add(publishedName(component), component);
    const alias = ALIASED_TYPE_NAMES[component];
    if (alias) add(alias, component);
  }
  // A projection names the ONE component it is a view of, so it replaces the
  // union rather than joining it -- its `added`/`dropped` describe that shape.
  for (const [published, projection] of Object.entries(projections)) {
    componentsFor.set(published, new Set([projection.component]));
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
    const components = [...(componentsFor.get(name) ?? [])];
    if (!components.length)
      throw new Error(`nothing declares the type ${name}`);
    const contributors = components.map((component) => {
      const emittedSource = emitted.get(component);
      if (!emittedSource)
        throw new Error(`${name} names the absent component ${component}`);
      return emittedSource;
    });
    const source = contributors[0];
    const projection = projections[name];
    // A type is one or the other: a view of a component, or a mirror with
    // resolver edits. Declaring it both ways is two answers to "what is this
    // type's shape", and the builder cannot pick between them.
    const overlay = overlays[name];
    if (projection && overlay) {
      throw new Error(
        `${name} is declared as both a projection of ${projection.component} and a mirror overlay`,
      );
    }
    const edits = projection ?? overlay;
    const type = new GraphQLObjectType({
      name,
      description: source.description ?? undefined,
      // A THUNK, so a type that references itself (or a cycle through two)
      // resolves rather than recursing while it is still being constructed.
      fields: () => {
        const fields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};
        const dropped = new Set(edits?.dropped ?? []);
        const renamed = new Map<string, string>();
        if (projection?.itemsFrom) renamed.set(projection.itemsFrom, "items");
        if (projection?.totalFrom) renamed.set(projection.totalFrom, "total");
        // The union of the contributing components, in first-seen order.
        const fieldNames: string[] = [];
        for (const contributor of contributors) {
          for (const fieldName of Object.keys(contributor.getFields())) {
            if (!fieldNames.includes(fieldName)) fieldNames.push(fieldName);
          }
        }
        for (const fieldName of fieldNames) {
          if (dropped.has(fieldName)) continue;
          const carriers = contributors.filter(
            (contributor) => contributor.getFields()[fieldName],
          );
          const field = carriers[0].getFields()[fieldName];
          // A field only SOME of the producers carry cannot be promised: ask
          // the other one and it answers null, which graphql-js turns into a
          // nulled parent. So the union publishes it, nullable -- which is
          // exactly what the hand-written SDL already did by hand for
          // `featured`, `uid_count` and `stake_dominance`.
          // Two ways a promise the component makes cannot be kept here. A
          // field only SOME of the producers carry: ask the other one and it
          // answers null, which graphql-js turns into a nulled parent -- what
          // the SDL already did by hand for `featured`, `uid_count` and
          // `stake_dominance`. And a field a PROJECTION declares nullable,
          // because the resolver building the view fills fewer fields than the
          // component's own producer does (`OpportunityEntry`, measured).
          const everywhere = carriers.length === contributors.length;
          const relaxed = projection?.nullable?.includes(fieldName) ?? false;
          const republished = republish(field.type);
          const published = renamed.get(fieldName) ?? fieldName;
          fields[published] = {
            ...fieldArguments(`${name}.${published}`),
            type: retype(
              `${name}.${published}`,
              (everywhere && !relaxed) ||
                !(republished instanceof GraphQLNonNull)
                ? republished
                : (republished.ofType as GraphQLOutputType),
            ),
            description: field.description ?? undefined,
          };
        }
        for (const [fieldName, added] of Object.entries(edits?.added ?? {})) {
          fields[fieldName] = {
            ...fieldArguments(`${name}.${fieldName}`),
            type: fromSpelling(added) as GraphQLOutputType,
          };
        }
        return fields;
      },
    });
    built.set(name, type);
    sources.set(name, components.join(" + "));
    return type;
  }

  /**
   * A field's published type where it is not the one its component emits.
   *
   * TWO SOURCES, one rule each, and the rule is the point -- a mechanism that
   * lets a declaration say anything about a field's type is a second
   * hand-written SDL with extra steps.
   *
   * An ENUM site may only replace `String` (in whatever nullability the
   * component gave it), because that is what the emitter maps every registered
   * Zod enum to. Anything else means the site names a field that is not an
   * enum, which is a typo rather than a narrowing.
   *
   * A RETYPE may change the named type and NOTHING else: same list depth, same
   * `!` in the same places. The exception is `JSON`, which carries no shape at
   * all, so replacing it cannot contradict anything -- that is the direction
   * this epic moves in. Without the rule, `X!` -> `X` would be spelled the
   * same way as a rename, and relaxing a promise is the one change a client
   * can be broken by.
   */
  function retype(
    site: string,
    emittedType: GraphQLOutputType,
  ): GraphQLOutputType {
    const enumName = enumSites.get(site);
    if (enumName) {
      const inner = nullableInner(emittedType);
      if (inner !== GraphQLString) {
        throw new Error(
          `${site} is declared as the enum ${enumName}, but its component emits ${String(emittedType)}`,
        );
      }
      return rewrap(emittedType, enums.get(enumName)!);
    }
    const spelling = retypedFields[site];
    if (!spelling) return emittedType;
    const replacement = fromSpelling(spelling) as GraphQLOutputType;
    if (
      nullableInner(emittedType) !== JSONScalar &&
      wrapping(emittedType) !== wrapping(replacement)
    ) {
      throw new Error(
        `${site} is retyped from ${String(emittedType)} to ${spelling}, which changes ` +
          `more than the named type; only a JSON field may change shape`,
      );
    }
    return replacement;
  }

  /** The type inside every list and non-null wrapper. */
  function nullableInner(type: GraphQLType): GraphQLNamedType {
    let inner = type;
    while (inner instanceof GraphQLNonNull || inner instanceof GraphQLList) {
      inner = inner.ofType as GraphQLType;
    }
    return inner as GraphQLNamedType;
  }

  /** `[Foo!]!` -> `[_!]!` -- the shape with the name taken out. */
  function wrapping(type: GraphQLType): string {
    return String(type).replace(/[A-Za-z_][A-Za-z0-9_]*/, "_");
  }

  /** Put `inner` back inside the wrappers `type` carries. */
  function rewrap(
    type: GraphQLOutputType,
    inner: GraphQLNamedType,
  ): GraphQLOutputType {
    if (type instanceof GraphQLNonNull) {
      return new GraphQLNonNull(
        rewrap(
          type.ofType as GraphQLOutputType,
          inner,
        ) as GraphQLNullableOutputType,
      );
    }
    if (type instanceof GraphQLList) {
      return new GraphQLList(rewrap(type.ofType as GraphQLOutputType, inner));
    }
    return inner as GraphQLOutputType;
  }

  /**
   * A nested field's arguments, derived from the route it filters.
   *
   * The PATH parameters are dropped: the parent supplies them, which is what
   * makes this a nested field rather than a root one.
   */
  function fieldArguments(site: string): {
    args?: GraphQLFieldConfigArgumentMap;
  } {
    const route = FIELD_ARGUMENT_ROUTES[site];
    if (!route) return {};
    const args: GraphQLFieldConfigArgumentMap = {};
    for (const argument of deriveQueryArguments(site, route, openapi, {
      hasNetworkTwin: false,
      returnsProjectable: true,
      nested: true,
    })) {
      args[argument.name] = {
        type: fromSpelling(argument.type) as GraphQLInputType,
      };
    }
    return Object.keys(args).length ? { args } : {};
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
            // No `binding.route` guard: a field that mirrors no route still
            // publishes whatever it DECLARES, and skipping the derivation
            // dropped `saved_query`'s two arguments from the schema (#10772).
            if (withArguments) {
              const twin = binding.route?.replace(
                "/api/v1/",
                "/api/v1/{network}/",
              );
              for (const argument of deriveQueryArguments(
                binding.field,
                binding.route,
                openapi,
                {
                  hasNetworkTwin: Boolean(twin && openapi.paths?.[twin]),
                  returnsProjectable: !fieldsArgumentApplies(binding.returns),
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
  // Arguments ON for the Subscription root too. It was built with them off,
  // on the reasoning that a subscription mirrors no route -- true, and
  // irrelevant: `chainEvents(tables:)` is DECLARED, and switching derivation
  // off skipped the declarations as well as the derivation (#10772).
  const subscription = root("Subscription", SUBSCRIPTION_BINDINGS, true);
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
