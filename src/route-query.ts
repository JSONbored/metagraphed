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
  routeQuerySchemasForPathname,
  type RouteQuerySchemas,
} from "./contracts.ts";
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
  const parsed = schemas.plain.safeParse(supplied);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const parameter = String(issue?.path[0] ?? "");
  return { parameter, message: messageFor(parameter, schemas, issue) };
}

/**
 * The pagination triplet from the already-validated query.
 *
 * `parsePagination` used to do this AND enforce it, restating `limit`'s bound
 * (#9916's reject-don't-clamp rule) next to a hand-rolled `offset` clamp that
 * did the opposite -- so one request could have its page size rejected and its
 * offset silently moved. Both bounds are published; the router enforces both
 * from the schema, and what is left here is the page-size default, which the
 * contract does not state.
 *
 * `defaultLimit` therefore stays a caller-supplied profile (FEED_PAGINATION /
 * BLOCK_PAGINATION) rather than being read off the schema: 83 of the 84 routes
 * that publish a `limit` publish no `default` alongside it. Publishing them is
 * a contract change and its own issue -- this is the read, not the decision.
 */
export function resolvePage(
  url: URL,
  { defaultLimit }: { defaultLimit: number },
): { limit: number; offset: number; cursor: string | null } {
  const { limit, offset, cursor } = routeQuery(url);
  return {
    limit: limit ?? defaultLimit,
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
  for (const key of params.keys()) {
    const issue = issues.get(key);
    if (issue)
      return { parameter: key, message: messageFor(key, schemas, issue) };
  }
  /* v8 ignore next 3 -- every issue path is a key that came from the URL, so
     the loop above always finds one; this is the type system's exit, not a
     reachable branch. */
  const [parameter, issue] = [...issues][0] ?? ["", undefined];
  return { parameter, message: messageFor(parameter, schemas, issue) };
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
 */
function messageFor(
  parameter: string,
  schemas: RouteQuerySchemas,
  issue: z.core.$ZodIssue | undefined,
): string {
  const field = schemas.plain.shape[parameter] as z.ZodType | undefined;
  const json = field ? publishedShape(field) : {};

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
