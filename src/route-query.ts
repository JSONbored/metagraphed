// THE runtime validator for REST query parameters (#10218).
//
// One parse, at one place, against the route's own Zod schema -- the same
// object `openapi.json`, the MCP tool inputs and the GraphQL type system are
// all emitted from. Before this, a request's parameters were checked by
// whichever of five hand-rolled parsers the handler happened to call
// (`parseLimitParam`, `parseNonNegativeIntParam`, `parseNetuidParam`,
// `parseDateRange`, `validateEnumParam`), each restating a bound the contract
// had already published, and only where a handler remembered to call it. What
// that produced is the class of bug this module removes:
//
//   ?offset=notanumber   answered 200 from row 0 on 10 routes, while
//                        ?limit=notanumber on the SAME request 400s
//   ?netuid=             parsed as subnet 0 -- a real subnet -- on 152 params
//   ?limit=500           on a maximum-100 route: 100 rows, HTTP 200, no header
//
// A published bound the server does not enforce is a contract lie, and an
// enforced bound the contract does not publish is undiscoverable. Deriving the
// check from the published schema makes both impossible in one direction: a
// parameter is accepted exactly when, and exactly as, it is published.
//
// ── What lives here and what lives in the schema ───────────────────────────
//
// The schema declares the TYPE, the BOUND and the VOCABULARY. This module
// declares the ENCODING -- the two facts that are true of a URL and of nothing
// else: every value arrives as a string, and a key may repeat. Coercion
// therefore cannot live in `schemas-src/query-params.ts`, because those
// builders also feed the MCP tool inputs, which are handed real JSON and must
// keep rejecting `limit: "20"` as the type error it is.
//
// The rejection MESSAGE is derived from the published bound rather than
// written per parameter, for the same reason the check is: a hand-written
// sentence is one more copy of the number, and the copies drifted.
import { z } from "zod";
import {
  collectionQuerySchemas,
  graphqlReshapes,
  routeParameterKind,
  routeQuerySchemasForPathname,
  type RouteQuerySchemas,
} from "./contracts.ts";
import {
  codecOwnsArgument,
  publishedArgumentKind,
} from "../schemas-src/graphql/argument-divergences.ts";
import { SERVING_BOUND } from "../schemas-src/query-params.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
  DEFAULT_HISTORY_WINDOW,
  DEFAULT_UPTIME_WINDOW,
  HISTORY_WINDOW_DAYS,
  UPTIME_WINDOW_DAYS,
} from "./route-limits.ts";
/**
 * A rejected parameter and the sentence a caller is given for it.
 *
 * Declared here, with the check that produces it, rather than in
 * `workers/list-query.ts` where it used to live -- that module is the list
 * ENGINE, and a type every surface's error path speaks does not belong behind
 * the gate that stops MCP loaders importing it.
 */
export interface QueryError {
  parameter: string;
  message: string;
}

/**
 * A route's validated query parameters, typed as the contract declares them:
 * `limit` is a number here because the schema says integer, not because
 * something downstream called `Number()` on it.
 *
 * An index signature rather than a per-route generic. The router resolves the
 * route from a pathname at runtime, so a handler cannot be handed its own
 * route's inferred type without threading the literal path through every call
 * site -- and the named members below are the ones nearly every handler reads.
 */
export interface RouteQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly window?: string;
  readonly netuid?: number;
  readonly sort?: string;
  readonly order?: string;
  readonly format?: string;
  readonly from?: string;
  readonly to?: string;
  readonly [parameter: string]: unknown;
}

export type RouteQueryResult = { query: RouteQuery } | { error: QueryError };

/**
 * Parsed once per URL instance.
 *
 * The router calls this to reject a bad request and the handler calls it again
 * to read the values, which would otherwise be two parses of the same string.
 * Keyed on the URL object rather than on its href because a request carries
 * exactly one, and a WeakMap cannot outlive it.
 */
let parsedQueries = new WeakMap<URL, RouteQueryResult>();

// Keyed on objects that die with their request, so it cannot outlive a test
// file in practice -- registered because the gate computes the mutable set
// rather than trusting that judgement, which is why it catches what it catches.
registerModuleStateReset("src/route-query.ts", () => {
  parsedQueries = new WeakMap();
});

/**
 * Validate a request URL's query string against its route's schema.
 *
 * Returns the parsed values, or the first violation in the order the caller
 * wrote them -- URL order, not schema order, so the message names the
 * parameter a caller would look at first.
 *
 * A route with no schema (not in the contract, or classified nowhere) is
 * passed through unvalidated, exactly as the name-only allowlist did. That is
 * the same "we have nothing to say about this path" answer, not an assertion
 * that anything is allowed.
 */
export function parseRouteQuery(url: URL): RouteQueryResult {
  const cached = parsedQueries.get(url);
  if (cached) return cached;
  const result = validate(url);
  parsedQueries.set(url, result);
  return result;
}

/**
 * The validated query for a handler that runs DOWNSTREAM of the router's
 * check, which is every handler: the router rejects before dispatch, so by the
 * time a handler asks, the answer cannot be an error.
 *
 * `{}` for an unschema'd route is the honest answer rather than a fallback --
 * such a route declares no parameters for a handler to read.
 */
export function routeQuery(url: URL): RouteQuery {
  const parsed = parseRouteQuery(url);
  return "error" in parsed ? {} : parsed.query;
}

/**
 * The same check for a surface that speaks TYPED JSON rather than a query
 * string -- GraphQL resolver arguments today (#10218).
 *
 * The published schema, unwrapped: no coercion, because a GraphQL `Int` arrives
 * as a number and `window: "7d"` as a string, already the type the contract
 * declares. Coercing here would accept `limit: "20"`, which on a typed surface
 * is the type error it looks like.
 *
 * Non-strict, deliberately: a resolver's argument list is not its route's
 * parameter list -- `netuid` is a path segment on the REST side and an argument
 * here -- so an argument the route does not declare is a GraphQL concern and
 * graphql-js has already checked it against the SDL. What this adds is the part
 * the SDL cannot express: the enum a route narrows to its own subset, and the
 * numeric ceiling behind a plain `Int`.
 *
 * `null`/`undefined` arguments are dropped rather than parsed. GraphQL supplies
 * every declared argument, absent ones as null, and a null there means "not
 * given" -- the same thing an omitted query parameter means.
 */
export function validateRouteArgs(
  routePath: string,
  args: Record<string, unknown>,
): QueryError | null {
  const schemas = routeQuerySchemasForPathname(routePath);
  if (!schemas) return null;
  const supplied: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value !== null && value !== undefined && name in schemas.plain.shape) {
      supplied[name] = value;
    }
  }
  const parsed = schemas.graphql.safeParse(supplied);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const parameter = String(issue?.path[0] ?? "");
  return {
    parameter,
    message: messageFor(parameter, schemas, issue, supplied[parameter]),
  };
}

/**
 * The route's own parse of a non-URL argument set, defaults applied (#10313).
 *
 * `validateRouteArgs` answers "is this allowed"; this answers "what is it".
 * The difference matters for GraphQL, whose resolvers receive arguments rather
 * than a URL and therefore cannot use `routeValue`: without this they restate
 * the route's default -- `limit ?? MAX_CANDLES` -- which is a second copy of a
 * number the schema already publishes, and the copy is what drifts.
 *
 * Returns null when the path has no query schema, so a caller can tell "this
 * route declares nothing" from "this route declares nothing about that
 * argument".
 */
export function parseRouteArgs<T = Record<string, unknown>>(
  routePath: string,
  args: Record<string, unknown>,
): T | null {
  const schemas = routeQuerySchemasForPathname(routePath);
  if (!schemas) return null;
  const supplied: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value !== null && value !== undefined && name in schemas.plain.shape) {
      supplied[name] = value;
    }
  }
  const parsed = schemas.graphql.safeParse(supplied);
  if (!parsed.success) return null;
  // `.meta({ default })` is published, not applied by parse -- the same reason
  // `pageLimit` reads it back rather than trusting the parsed object.
  const withDefaults = { ...(parsed.data as Record<string, unknown>) };
  for (const [name, field] of Object.entries(schemas.plain.shape)) {
    if (withDefaults[name] !== undefined) continue;
    const declared = field as z.ZodType;
    const inner =
      declared instanceof z.ZodOptional
        ? (declared.unwrap() as z.ZodType)
        : declared;
    const fallback = inner.meta()?.default;
    if (fallback !== undefined) withDefaults[name] = fallback;
  }
  return withDefaults as T;
}

/**
 * The ceiling one route publishes for one parameter, or undefined for none.
 *
 * Read off `plain` for the same reason `messageFor` does: the wire form wraps a
 * numeric field in its string-decoding step, and the number a caller is bound
 * by is the one in the published schema.
 */
export function publishedCeiling(
  routePath: string,
  parameter: string,
): number | undefined {
  const schemas = routeQuerySchemasForPathname(routePath);
  const field = schemas?.plain.shape[parameter] as z.ZodType | undefined;
  if (!field) return undefined;
  const maximum = publishedShape(field).maximum;
  // `z.int()` publishes the JS safe-integer range on every integer, so a
  // parameter with no ceiling of its own still reports 2^53-1. That is the
  // representation of "any integer", not a bound anybody chose (#10218).
  return maximum === Number.MAX_SAFE_INTEGER ? undefined : maximum;
}

/**
 * Is this parameter's bound a serving POLICY, which bends, or a validity
 * constraint, which does not?
 *
 * Read from the published schema rather than from a list of names here. The
 * distinction is declared once, on the builder that creates the bound
 * (`limitSchema`, `offsetSchema`, and the one window that is hand-built), and
 * `SERVING_BOUND` carries it all the way into `openapi.json` -- so a caller can
 * see which of a route's bounds bend, and a window parameter written next month
 * answers the question by being built the same way rather than by someone
 * remembering to add it here.
 *
 * A name list would have been shorter and would have been wrong within a
 * release: `limit` and `offset` were the obvious two, and `chain-events/stats`
 * publishes `blocks`, a window size whose ceiling behaves identically and whose
 * clamping is pinned by a test.
 */
function isServingBound(field: z.ZodType | undefined): boolean {
  return unwrapOptional(field)?.meta()?.[SERVING_BOUND] === true;
}

/**
 * The schema behind `.optional()`, where a builder's `.meta()` actually lives.
 *
 * Every route field is optional, and `.optional()` does not inherit the inner
 * schema's metadata -- the same unwrap `parseRouteArgs` does to read a published
 * default, and for the same reason.
 */
function unwrapOptional(field: z.ZodType | undefined): z.ZodType | undefined {
  if (!field) return undefined;
  return field instanceof z.ZodOptional ? (field.unwrap() as z.ZodType) : field;
}

/**
 * A page or window value brought inside the range the route publishes.
 *
 * ── The decision this encodes ──────────────────────────────────────────────
 *
 * #10174 settled clamp-versus-reject for REST (rejects) and MCP (clamps), one
 * predictable sentence per surface. GraphQL was never settled and was split
 * down the middle: twelve fields clamped and five rejected, both pinned by
 * `tests/graphql.test.ts`, so a caller could not predict which they would get
 * -- exactly the state #10174 found the other two surfaces in.
 *
 * GRAPHQL CLAMPS, for the two reasons #10174 used:
 *
 *   It is the FORGIVING direction. Flipping the twelve clamping fields to
 *   rejecting breaks every live caller that passes a large page; flipping the
 *   five rejecting fields to clamping breaks nobody, because an error becomes
 *   an answer. #10174 chose the same way for MCP and said so.
 *
 *   It matches the surface it most resembles. Like MCP and unlike REST, a
 *   GraphQL caller gets HTTP 200 whatever happens and has to read the body to
 *   learn anything, so a rejection is far less visible here than the 400 REST
 *   returns -- and the response already reports the limit actually applied.
 *
 * Both ends, because the twelve include below-range clamping (`limit: 0` up to
 * 1, a negative `offset` up to 0) and those callers are as live as the others.
 */
function clampToPublished(field: z.ZodType, value: unknown): unknown {
  if (typeof value !== "number" || !Number.isInteger(value)) return value;
  const json = publishedShape(field);
  const { minimum } = json;
  // `z.int()` publishes the JS safe-integer range on every integer, so a
  // parameter with no ceiling of its own still reports 2^53-1 -- not a bound
  // anybody chose, and not one to clamp against (#10218).
  const maximum =
    json.maximum === Number.MAX_SAFE_INTEGER ? undefined : json.maximum;
  if (typeof maximum === "number" && value > maximum) return maximum;
  if (typeof minimum === "number" && value < minimum) return minimum;
  return value;
}

/**
 * Everything the route's schema says about a field's arguments, EXCEPT the page
 * bounds (#10316).
 *
 * ── Why the parse cannot simply be `validateRouteArgs` ─────────────────────
 *
 * Running the route's whole object over GraphQL's arguments looks like the
 * obvious move, and it silently changes published behaviour. #10174 settled
 * clamp-versus-reject for REST (rejects) and MCP (clamps) -- one predictable
 * sentence per surface. GraphQL was never settled, and it is split down the
 * middle: `tests/graphql.test.ts` pins TWELVE fields that clamp
 * (`chain_prometheus(limit: 99999)` forwards `limit=100`) and FIVE that reject
 * (`subnet_movers` answers BAD_USER_INPUT above `MOVERS_LIMIT_MAX`). Both are
 * published behaviour today, and a parse that enforced the schema's bound would
 * flip all twelve to rejecting without anybody deciding that.
 *
 * That decision is the #10174 this surface never had, and it is deliberately
 * NOT taken here -- one behaviour change made on purpose beats seventeen made
 * by a refactor. Until it is, the parse leaves `limit` and `offset` to the
 * resolver, which is the only part of the 250 hand-written checks this cannot
 * yet delete.
 *
 * Everything else -- enums, patterns, formats, lengths, `netuid`'s range -- is
 * vocabulary and shape, identical on every surface, and is enforced here.
 *
 * ── What each step is for ──────────────────────────────────────────────────
 *
 * DECLARED DIVERGENCES are skipped, because ten of GraphQL's arguments are
 * legitimately not the route's (`endpoints.cursor` is an opaque keyset where
 * REST takes an integer offset) and `validate:graphql-route-parity` has already
 * verified each against production.
 *
 * SHAPES are converted first: a GraphQL Boolean against a published
 * `["true","false"]` string enum, and a list against a comma-joined string, are
 * the same value spelled the way each type system can hold it.
 *
 * DEFAULTS are applied last, from `.meta({default})`, so a resolver never
 * restates one.
 */
export interface RouteArgs<T> {
  /** Parsed arguments with published defaults applied, or null on rejection. */
  value: T | null;
  /** The vocabulary/shape violation, if any. Serving bounds never report one. */
  error: QueryError | null;
  /** Arguments the parse resolved by clamping, so a caller's value is not kept. */
  clamped: ReadonlySet<string>;
}

/**
 * Does GraphQL own this argument's spelling, rather than the route?
 *
 * Two ways it can, and BOTH have to be read here (#10772). The first is a
 * declared PRESENCE (`DECLARED_ARGUMENTS`), which is all this asked before.
 * The second is a declared TYPE (`DECLARED_ARGUMENT_TYPES`), and missing it is
 * what regressed `providers(cursor: "<opaque string>")`: the route's `cursor`
 * is an integer offset, GraphQL's is an opaque keyset, and the route's schema
 * answered "cursor must be a non-negative integer" for a value it was never
 * given.
 *
 * The second is DERIVED, not listed. A declared type only takes the argument
 * away from the route when the route's schema cannot hold the value at all --
 * so `Int` against a `z.number()` bound stays the route's, keeping its
 * clamping and its published default, while `String` against that same bound
 * does not. Skipping every declared type instead would have silently stripped
 * the bounds off fourteen arguments to fix two.
 *
 * An argument the route does not declare is GraphQL's by definition: there is
 * no schema to hold it (`addedByGraphql`).
 *
 * A shape the parse already CONVERTS is not a divergence either, and reading
 * the kinds without asking cost two of these their validation: a GraphQL list
 * against the route's comma-joined string, and a Boolean against its
 * `["true","false"]`, are different kinds that `toRouteShape` turns into the
 * route's spelling a line later -- so `compare_validators(hotkeys: [])` stopped
 * being rejected. The conversion IS the codec; only a value nothing converts
 * belongs to GraphQL.
 */
function graphqlOwnsSpelling(
  field: string,
  name: string,
  declared: z.ZodType | undefined,
): boolean {
  if (codecOwnsArgument(field, name)) return true;
  const published = publishedArgumentKind(field, name);
  if (published === null) return false;
  if (!declared) return true;
  if (graphqlReshapes(declared)) return false;
  return published !== routeParameterKind(declared);
}

export function resolveRouteArgs<T = Record<string, unknown>>(
  routePath: string,
  field: string,
  args: Record<string, unknown>,
): RouteArgs<T> {
  const schemas = routeQuerySchemasForPathname(routePath);
  const owned: Record<string, unknown> = {};
  const clamped = new Set<string>();
  for (const [name, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    const declared = schemas?.plain.shape[name] as z.ZodType | undefined;
    if (graphqlOwnsSpelling(field, name, declared)) continue;
    if (declared && isServingBound(declared)) {
      owned[name] = clampToPublished(declared, value);
      clamped.add(name);
    } else {
      // NOT converted here. The `graphql` codec layer both parse entries below
      // read does it, so the conversion has ONE definition rather than a
      // hand-written switch beside the schema that already describes it.
      owned[name] = value;
    }
  }
  const error = validateRouteArgs(routePath, owned);
  if (error) return { value: null, error, clamped };
  return { value: parseRouteArgs<T>(routePath, owned), error: null, clamped };
}

/**
 * The page size this request resolved to: what the caller asked for, or the
 * default the route PUBLISHES (#10060).
 *
 * The number is not restated here and no longer restated by the handler. It is
 * declared once, beside the ceiling, in the module that owns the route's bounds
 * -- `schemas-src/route-queries.ts` passes it to `limitSchema(max, fallback)`,
 * which puts it in `openapi.json` as the parameter's `default`, and this reads
 * it back out of the same object. A caller and the server now get the page size
 * from one place.
 *
 * Before this, 103 of the 128 published `limit` parameters carried no `default`
 * while their handler applied one -- so the contract could not say what a
 * caller got for omitting it, and the MCP tool mirroring the same route DID
 * declare one, leaving the two published surfaces disagreeing about a route
 * neither was wrong about.
 *
 * Throws for a route that publishes no default. That is a developer-config
 * error, not a request the caller can make: the 36 collection routes and the
 * three others that return every matching row when `limit` is absent read
 * `routeQuery(url).limit` directly, because `undefined` is the answer there and
 * substituting a number would truncate them.
 */
export const pageLimit = (url: URL): number => routeValue<number>(url, "limit");

/**
 * The value this request resolved to for one parameter: what the caller sent,
 * or the default the route PUBLISHES (#10060).
 *
 * The general form of `pageLimit` above, and for the same reason. A handler
 * writing `url.searchParams.get("window") || DEFAULT_X_WINDOW` states a fact
 * the contract also states, in a place the contract cannot see -- and 986 of
 * the 1,076 published query parameters carried no `default` while the handlers
 * behind them applied 60-odd of them. This reads the published one back, so
 * there is one number and a caller can see it.
 *
 * Throws where the route publishes no default for the parameter. That is a
 * developer-config error rather than a request a caller can make: a parameter
 * whose absence means "no filter" has no default to read, and its handler asks
 * `routeQuery(url)` directly, where `undefined` is the answer.
 */
export function routeValue<T>(url: URL, parameter: string): T {
  const asked = routeQuery(url)[parameter];
  if (asked !== undefined) return asked as T;
  const fallback = publishedDefault(url.pathname, parameter);
  if (fallback === undefined) {
    throw new Error(`No published ${parameter} default for ${url.pathname}`);
  }
  return fallback as T;
}

/**
 * A parsed STRING parameter, or null where the caller sent none (#10060).
 *
 * The shape the loaders take, which is why it exists: they were handed
 * `url.searchParams.get("kind")` and typed `string | null`, so reading the
 * parsed object instead needed something that keeps that signature rather than
 * the index signature's `unknown`.
 *
 * A type TEST, not a cast. The value came out of a Zod parse against the
 * published schema, so its runtime type is whatever the contract declares --
 * and if a caller reaches for the wrong accessor, the answer is `null` rather
 * than a number wearing a string's type.
 */
export function routeText(url: URL, parameter: string): string | null {
  const value = routeQuery(url)[parameter];
  return typeof value === "string" ? value : null;
}

/** The same, for a parameter the contract declares as a number. */
export function routeInt(url: URL, parameter: string): number | null {
  const value = routeQuery(url)[parameter];
  return typeof value === "number" ? value : null;
}

/**
 * What the schema builder recorded with `.meta({ default })`, read back off the
 * published field.
 *
 * `.meta()` does not see through `.optional()`, and every query parameter is
 * optional, so the wrapper comes off first -- and stays off for a route that
 * declares no such parameter at all, where there is nothing to unwrap. This is
 * the same metadata object `z.toJSONSchema` turns into the published `default`
 * keyword, so the contract and the runtime cannot be reading different values.
 */
function publishedDefault(pathname: string, parameter: string): unknown {
  const field = routeQuerySchemasForPathname(pathname)?.plain.shape[
    parameter
  ] as z.ZodType | undefined;
  const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
  return (inner as z.ZodType | undefined)?.meta()?.default;
}

/**
 * The pagination triplet from the already-validated query.
 *
 * `parsePagination` used to do this AND enforce it, restating `limit`'s bound
 * (#9916's reject-don't-clamp rule) next to a hand-rolled `offset` clamp that
 * did the opposite -- so one request could have its page size rejected and its
 * offset silently moved. Both bounds are published; the router enforces both
 * from the schema, and the page size now comes from the schema too.
 *
 * `defaultLimit` used to be a caller-supplied profile (FEED_PAGINATION /
 * BLOCK_PAGINATION) because the contract did not state the default. It does
 * now, on every route that has one, so the argument is gone rather than kept
 * as a second way to say the same thing.
 */
export function resolvePage(url: URL): {
  limit: number;
  offset: number;
  cursor: string | null;
} {
  const { offset, cursor } = routeQuery(url);
  return {
    limit: pageLimit(url),
    offset: offset ?? 0,
    cursor: cursor ?? null,
  };
}

/**
 * The window a request resolved to, and whatever its family attaches to that
 * label -- a day count, or null where `all` means "no lower bound".
 *
 * THE window reader for every surface (#10218). There used to be three, one
 * per family, and each re-checked the label against its own map before using
 * it -- a second statement of a vocabulary the route already publishes, in the
 * one place guaranteed to disagree with it (`analyticsWindow` rejected against
 * every window the API knows, not against the two its route declares). The
 * router parses against the route's schema before dispatch, so the label
 * reaching here is one the route declared and the only questions left are the
 * default and the span.
 *
 * `spans` is the family's `label -> span` map from `src/route-limits.ts`,
 * whose KEYS are what `schemas-src/route-queries.ts` publishes as the enum.
 * One declaration, read by both.
 */
export function resolveWindow<T>(
  url: URL,
  spans: Record<string, T>,
  fallback: string,
): { label: string; days: T } {
  const label = (routeQuery(url).window as string | undefined) ?? fallback;
  return { label, days: spans[label] };
}

/**
 * The three window families bound to that reader, one definition each.
 *
 * Here rather than beside their handlers because two of the three are read
 * from more than one module -- `analyticsWindow` by the analytics handlers,
 * the rpc-usage proxy and seven GraphQL resolvers -- and a per-file copy of
 * "which map, which default" is the shape of duplication this whole issue is
 * about. `src/route-limits.ts` owns the maps and the defaults, and
 * `schemas-src/route-queries.ts` publishes the enum from the same keys.
 */
export const analyticsWindow = (url: URL) =>
  resolveWindow(url, ANALYTICS_WINDOW_DAYS, DEFAULT_ANALYTICS_WINDOW);
export const historyWindow = (url: URL) =>
  resolveWindow(url, HISTORY_WINDOW_DAYS, DEFAULT_HISTORY_WINDOW);
export const uptimeWindow = (url: URL) =>
  resolveWindow(url, UPTIME_WINDOW_DAYS, DEFAULT_UPTIME_WINDOW);

function validate(url: URL): RouteQueryResult {
  const schemas = routeQuerySchemasForPathname(url.pathname);
  if (!schemas) return { query: {} };
  return parseSearchParams(url.searchParams, schemas);
}

/**
 * Validate the parameters an MCP list tool built, against the collection's own
 * schema (#10218).
 *
 * The second door into the list engine. MCP's enforcement lives in the handler
 * by a measured decision (#8942), and for the list-backed tools the handler is
 * that engine -- so the check has to be here, and it has to be the SAME check
 * the REST door runs, off the same `API_QUERY_COLLECTIONS` config both schemas
 * are composed from. `applyQueryFilters` used to carry a hand-written 120-line
 * copy of it.
 */
export function validateCollectionQuery(
  params: URLSearchParams,
  collection: string,
  filterNames: string[] = [],
  options: { csvResponse?: boolean } = {},
): QueryError | null {
  const schemas = collectionQuerySchemas(collection, filterNames, options);
  if (!schemas) return null;
  const parsed = parseSearchParams(params, schemas);
  return "error" in parsed ? parsed.error : null;
}

function parseSearchParams(
  params: URLSearchParams,
  schemas: RouteQuerySchemas,
): RouteQueryResult {
  // The NAME pass, in the caller's order, before Zod sees anything.
  // `.strict()` would catch an undeclared parameter too, but not in that order
  // and not with this message -- and duplicates are invisible to it, because a
  // repeated key survives `URLSearchParams` and does not survive an object.
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!(key in schemas.wire.shape)) {
      return {
        error: {
          parameter: key,
          message: `${key} is not supported for this route.`,
        },
      };
    }
    if (seen.has(key)) {
      return {
        error: { parameter: key, message: `${key} may only be provided once.` },
      };
    }
    seen.add(key);
    values[key] = params.get(key) as string;
  }

  const parsed = schemas.wire.safeParse(values);
  if (!parsed.success)
    return { error: firstViolation(params, schemas, parsed.error) };
  // A key whose value decoded to `undefined` (`?offset=`) is DROPPED, so
  // "absent" is one thing rather than two: Zod omits a key that was never sent
  // but keeps one whose preprocess returned undefined, and a reader doing
  // `Object.entries` or `in` would tell those apart when nothing should.
  const query: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed.data)) {
    if (value !== undefined) query[name] = value;
  }
  return { query };
}

function firstViolation(
  params: URLSearchParams,
  schemas: RouteQuerySchemas,
  error: z.ZodError,
): QueryError {
  const issues = new Map<string, z.core.$ZodIssue>();
  for (const issue of error.issues) {
    const parameter = String(issue.path[0] ?? "");
    if (!issues.has(parameter)) issues.set(parameter, issue);
  }
  // Supplied keys first, in the CALLER'S order, so a request with two mistakes
  // is told about the one they wrote first.
  for (const key of params.keys()) {
    const issue = issues.get(key);
    if (issue)
      return {
        parameter: key,
        message: messageFor(key, schemas, issue, params.get(key)),
      };
  }
  // A REQUIRED FIELD THAT WAS NEVER SENT (#10401).
  //
  // This was `/* v8 ignore */`-ed as "the type system's exit, not a reachable
  // branch", and that was true for exactly as long as every query field was
  // optional: a violation could only come from a value the caller supplied, so
  // its path was always a key in the URL. `stake-quote.amount` is the first
  // required parameter on the API, and a missing one produces an issue whose
  // path is in NO key -- the loop above finds nothing and lands here.
  //
  // `params.get()` returns null for the absent key, which messageFor already
  // renders as the bound alone rather than appending `Received: "null"` -- so
  // the caller is told what the parameter must be, not what they failed to
  // send.
  const [parameter, issue] = [...issues][0] ?? ["", undefined];
  return {
    parameter,
    message: messageFor(parameter, schemas, issue, params.get(parameter)),
  };
}

/**
 * Say what the parameter should have been, in terms of the bound it violated.
 *
 * Derived from the published schema, not written per parameter: the sentence
 * carries the same numbers the contract does because it reads them from it. A
 * hand-written message is a copy of the bound, and every copy of a bound in
 * this codebase has eventually disagreed with it -- that is the whole reason
 * this module exists.
 *
 * Read off `plain`, never `wire`: the wire form wraps a numeric field in the
 * string-decoding step, and a caller needs to be told the integer range they
 * missed, not that a decode produced NaN.
 *
 * The RECEIVED value is echoed after the bound (#10316). It is the one part of
 * the sentence that is not a copy of anything the contract publishes -- it is
 * the caller's own input -- so it cannot drift, and without it the two surfaces
 * could not be unified: GraphQL's 250 hand-written checks name the offending
 * value (`"99d" is not a supported window`) and its tests assert that they do,
 * while REST's derived message named only the bound. Adding it here gives both
 * surfaces the better sentence rather than making one of them worse.
 */
function messageFor(
  parameter: string,
  schemas: RouteQuerySchemas,
  issue: z.core.$ZodIssue | undefined,
  received?: unknown,
): string {
  const field = schemas.plain.shape[parameter] as z.ZodType | undefined;
  const bound = boundFor(parameter, field ? publishedShape(field) : {}, issue);
  return received === undefined || received === null
    ? bound
    : `${bound} Received: ${quoteReceived(received)}.`;
}

/**
 * The caller's value, quoted and bounded in length.
 *
 * TRUNCATED because the value is untrusted and unbounded -- a 767-character
 * `netuids` string echoed whole turns one bad request into an error body
 * nobody reads, and a `maxLength` violation is exactly the case where the input
 * is too long by construction.
 */
function quoteReceived(received: unknown): string {
  const text = typeof received === "string" ? received : String(received);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
}

/** The published bound, as a sentence. */
function boundFor(
  parameter: string,
  json: PublishedShape,
  issue: z.core.$ZodIssue | undefined,
): string {
  if (Array.isArray(json.enum)) {
    return `${parameter} must be one of: ${json.enum.join(", ")}.`;
  }
  if (json.type === "integer" || json.type === "number") {
    const bare = json.type === "integer" ? "integer" : "number";
    const noun = json.type === "integer" ? "an integer" : "a number";
    const { minimum } = json;
    // `z.int()` publishes the JS safe-integer range on every integer, so a
    // parameter with no ceiling of its own still carries maximum 2^53-1.
    // Quoting it at a caller would read as a bound the route cares about; it
    // is the representation of "any integer", which is what they get told.
    const maximum =
      json.maximum === Number.MAX_SAFE_INTEGER ? undefined : json.maximum;
    if (typeof minimum === "number" && typeof maximum === "number") {
      return `${parameter} must be ${noun} between ${minimum} and ${maximum}.`;
    }
    if (minimum === 0) return `${parameter} must be a non-negative ${bare}.`;
    if (typeof minimum === "number") {
      return `${parameter} must be ${noun} of at least ${minimum}.`;
    }
    // EXCLUSIVE lower bound (#10401). `z.number().gt(0)` publishes
    // `exclusiveMinimum`, not `minimum`, and reading only the inclusive
    // keywords meant `?amount=0` was answered "amount must be a number" -- a
    // sentence that is false about the value the caller sent and says nothing
    // about why it was refused. It matters more now that `amount` is required:
    // this is the message a caller gets for the route's main failure.
    //
    // Only the lower bound is handled, because `amount` is the only parameter
    // on the surface with an exclusive bound of any kind. An exclusiveMaximum
    // arm would be a branch nothing can reach or test.
    if (typeof json.exclusiveMinimum === "number") {
      return `${parameter} must be ${noun} greater than ${json.exclusiveMinimum}.`;
    }
    return `${parameter} must be ${noun}.`;
  }
  if (json.type === "boolean") return `${parameter} must be true or false.`;
  if (json.format === "date") {
    return `${parameter} must be a YYYY-MM-DD date.`;
  }
  if (issue?.code === "too_big" && typeof json.maxLength === "number") {
    return `${parameter} must be ${json.maxLength} characters or fewer.`;
  }
  if (typeof json.pattern === "string") {
    return `${parameter} must match ${json.pattern}.`;
  }
  /* v8 ignore next 2 -- reached only by a parameter whose schema declares no
     type, enum, format, length or pattern, which nothing on the surface does. */
  return `${parameter} is not valid for this route.`;
}

interface PublishedShape {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  /** `z.number().gt(x)` publishes this, NOT `minimum` (#10401). */
  exclusiveMinimum?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: PublishedShape[];
}

/**
 * One parameter's published JSON Schema.
 *
 * Only ever computed on the rejection path, so serializing per field costs
 * nothing on a request that parses -- which is the reason this is not
 * precomputed alongside the schemas themselves.
 *
 * An optional field can serialize as `anyOf: [T, {not: {}}]`, in which case the
 * constraint a caller violated is the first branch's.
 */
function publishedShape(field: z.ZodType): PublishedShape {
  const json = z.toJSONSchema(field, {
    target: "draft-2020-12",
    io: "input",
  }) as PublishedShape;
  /* v8 ignore next -- Zod inlines an optional's inner schema on every
     parameter the surface declares; the union form is defensive. */
  return json.type === undefined && json.anyOf?.[0] ? json.anyOf[0] : json;
}
