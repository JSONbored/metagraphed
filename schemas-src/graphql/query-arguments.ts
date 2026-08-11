// Derive each Query field's ARGUMENTS from the route it mirrors (#10214).
//
// The Query root is the last part of the SDL nothing generates, and its
// arguments are the half that does not need declaring: 171 of the 185
// route-backed fields reproduce exactly from the route's own published
// parameters, given four rules `validate-graphql-route-parity` already
// encodes and this module now shares with it.
//
// WHY THE ROUTE IS THE SOURCE. `buildSchema(SDL)` builds an SDL-only schema
// with no resolver map, so there is no per-field hook that could validate an
// argument at request time: whatever the SDL declares is exactly what a client
// may send, and whatever it omits is a route capability a GraphQL caller
// simply cannot reach. Deriving both from the route makes the two impossible
// to drift apart -- which is the thing the hand-written SDL could not promise.
import {
  DECLARED_ARGUMENT_TYPES,
  DECLARED_MISSING_NETWORK,
  DECLARED_UNPUBLISHED_ARGUMENTS,
  type DeclaredArgumentType,
} from "./argument-divergences.ts";

/** One published argument, written the way the SDL writes it. */
export interface QueryArgument {
  name: string;
  /** The GraphQL spelling, nullability included -- `Int!`, `[String!]`. */
  type: string;
}

/**
 * One published parameter, or the `$ref` that stands in for it.
 *
 * Both spellings appear in the same array -- the document inlines a
 * route-specific parameter and `$ref`s a shared one -- which is why `deref`
 * below exists at all. Declared as the union rather than `unknown` so that
 * function's INPUT is typed, not just its output.
 */
export type ParameterOrRef = Parameter | { $ref: string };

/**
 * Only the sliver of the OpenAPI document this module reads.
 *
 * Narrow on purpose. Nothing in this repo generates a type for the spec
 * DOCUMENT -- `public/metagraph/types.d.ts` models the API's requests and
 * responses, which is a different thing -- so this is a model of a document
 * rather than a hand-rolled copy of something already declared.
 */
export interface OpenApiParameters {
  paths?: Record<string, { get?: { parameters?: readonly ParameterOrRef[] } }>;
  components?: { parameters?: Record<string, Parameter> };
}

export interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: {
    type?: string;
    enum?: unknown[];
  };
}

/** Resolve a `$ref`'d parameter against the document that holds it. */
function deref(
  node: ParameterOrRef | undefined,
  openapi: OpenApiParameters,
): Parameter | null {
  if (!node || typeof node !== "object") return null;
  const ref = (node as { $ref?: string }).$ref;
  if (typeof ref !== "string") return node as Parameter;
  const resolved = ref
    .replace(/^#\//, "")
    .split("/")
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown>)?.[key],
      openapi,
    );
  return (resolved as Parameter) ?? null;
}

/**
 * The GraphQL scalar for one published parameter.
 *
 * `network` is the published `Network` enum rather than a String: the two
 * values are a closed set the schema can enforce, and 15 fields already spell
 * it that way.
 *
 * A `["true","false"]` STRING enum becomes a real `Boolean`. A query string
 * can only carry those two words as text; GraphQL has a Boolean, every
 * resolver on this shape normalises the same way (`if (x === true)
 * params.set("x", "true")`), and the SDL is the stricter of the two spellings.
 */
export function scalarFor(parameter: Parameter): string {
  const schema = parameter.schema;
  if (parameter.name === "network") return "Network";
  if (
    schema?.type === "string" &&
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((value) => value === "true" || value === "false")
  ) {
    return "Boolean";
  }
  if (schema?.type === "integer") return "Int";
  if (schema?.type === "number") return "Float";
  if (schema?.type === "boolean") return "Boolean";
  return "String";
}

/**
 * True when the field's return type can be projected by a selection set, so
 * REST's `fields` parameter has no work left to do.
 *
 * The caller supplies the answer because only it knows the emitted types; this
 * module stays free of the type emitter so the gate and the generator can both
 * use it.
 */
export interface DeriveOptions {
  /** Does the route have a `/api/v1/{network}/…` twin? */
  hasNetworkTwin: boolean;
  /** Is the field's return type fully typed (no `JSON` member)? */
  returnsProjectable: boolean;
  /**
   * Is this a NESTED field, whose parent already supplies the path parameters?
   *
   * `Subnet.surfaces` filters `/api/v1/subnets/{netuid}/surfaces` from inside a
   * `Subnet`, so `netuid` is the parent's identity rather than an argument --
   * which is exactly why the field is nested and not a root one. Only the
   * query half derives. Default false: a root field publishes its path
   * parameters as required arguments, because a GraphQL field has no path.
   */
  nested?: boolean;
}

/**
 * The arguments a Query field publishes, derived from its route.
 *
 * Four rules, each one the route-parity gate already applies, each of which
 * stops applying by itself the moment the underlying fact changes:
 *
 *   PATH params become REQUIRED arguments -- `/subnets/{netuid}/…` is
 *   `netuid: Int!`, because a GraphQL field has no path to put them in.
 *
 *   `format` selects the CSV export. GraphQL has no CSV surface, and the SDL
 *   declares zero `format` arguments across all 196 fields, so this describes
 *   a rule the schema already keeps rather than carving an exception.
 *
 *   `fields` is REST's projection parameter, and a selection set already is
 *   one -- dropped exactly when the return type is fully typed. When the
 *   return is the opaque `JSON` scalar the selection set cannot reach inside
 *   it, the caller has no projection at all, and `fields` is kept.
 *
 *   `network` is a path segment on the `/{network}/` twin rather than a query
 *   parameter on the base path, so it is added when the twin exists.
 *
 * Anything else the published parameter cannot express -- a comma-joined list
 * GraphQL spells as a real list, an epoch-ms bound that overflows `Int` --
 * comes from `DECLARED_ARGUMENT_TYPES`, whose entries must stay live.
 */
export function deriveQueryArguments(
  field: string,
  // NULL where no route serves the field. Its declared arguments still apply:
  // `saved_query` mirrors nothing and publishes two of its own, and treating
  // "no route" as "no arguments" is what dropped them from the generated
  // schema entirely (#10772).
  route: string | null,
  openapi: OpenApiParameters,
  options: DeriveOptions,
  // Injectable so the GATE can derive without it and still see the difference
  // the declaration covers. Filtered here, the argument simply never appears,
  // and a check reading the filtered output would call every live entry stale.
  missingNetwork: readonly string[] = DECLARED_MISSING_NETWORK,
): QueryArgument[] {
  const published = ((route && openapi.paths?.[route]?.get?.parameters) || [])
    .map((parameter) => deref(parameter, openapi))
    .filter((parameter): parameter is Parameter => Boolean(parameter?.name));

  const declaredType = (name: string, derived: string): string => {
    const entry: DeclaredArgumentType | undefined =
      DECLARED_ARGUMENT_TYPES[`${field}.${name}`];
    return entry?.type ?? derived;
  };

  // A route parameter GraphQL deliberately does not publish -- a capability
  // gap, declared with its reason. Read HERE and not only in the gate, so the
  // generated schema omits it too: `buildSchema(SDL)` has no resolver map, so
  // an argument the schema publishes is one a caller may send, and `health`
  // would have accepted six filters its resolver never reads.
  const unpublished = (name: string): boolean =>
    `${field}.${name}` in DECLARED_UNPUBLISHED_ARGUMENTS;

  const args: QueryArgument[] = [];
  for (const parameter of published) {
    if (parameter.in !== "path") continue;
    if (options.nested) continue;
    if (unpublished(parameter.name)) continue;
    args.push({
      name: parameter.name,
      type: declaredType(parameter.name, `${scalarFor(parameter)}!`),
    });
  }
  for (const parameter of published) {
    if (parameter.in !== "query") continue;
    if (parameter.name === "format") continue;
    if (unpublished(parameter.name)) continue;
    if (parameter.name === "fields" && options.returnsProjectable) continue;
    const base = scalarFor(parameter);
    args.push({
      name: parameter.name,
      type: declaredType(
        parameter.name,
        parameter.required === true ? `${base}!` : base,
      ),
    });
  }
  if (
    options.hasNetworkTwin &&
    !args.some((a) => a.name === "network") &&
    !missingNetwork.includes(field)
  ) {
    args.push({ name: "network", type: "Network" });
  }

  // Arguments the route does not publish at all -- a capability GraphQL adds,
  // like `validators(cursor:)`'s in-process pagination. Appended last so the
  // derived order stays the route's.
  for (const [key, entry] of Object.entries(DECLARED_ARGUMENT_TYPES)) {
    const [owner, name] = key.split(".");
    if (owner !== field || !entry.addedByGraphql) continue;
    if (args.some((a) => a.name === name)) continue;
    args.push({ name, type: entry.type });
  }
  return args;
}
