// ONE registry of operations, and the three surfaces that expose them (#10781).
//
// ## What was wrong
//
// One operation was named in four places, in four vocabularies:
//
//   API_ROUTES        src/contracts.ts                    id  + path
//   FEED_ROUTES       src/contracts.ts                    id  + path   (a SECOND
//                                                                       route table
//                                                                       nothing else
//                                                                       knew about)
//   QUERY_BINDINGS    schemas-src/graphql/published-names path only
//   MCP_TOOL_ROUTES   src/mcp-route-map.ts                path only
//
// The id existed on the REST side alone, so GraphQL and MCP each restated the
// PATH as a string and joined on it. A string join cannot tell a typo from a
// rename, and both happened: `saved_query` named `/api/v1/queries/{id}`, which
// the OpenAPI document has never contained, and `extrinsic` named `{ref}` where
// the route publishes `{hash}`. Both sat there for months because the gate that
// should have caught them SKIPPED exactly the entries whose route it could not
// resolve -- a gate that skips is a gate that passes (#10772).
//
// `get_feed` looked like a fifth orphan and was not: it names a FEED route, and
// feeds live in their own table. Nothing joined the two, so no gate could tell
// "unresolvable" from "resolvable somewhere else".
//
// ## What this is
//
// Every operation, keyed by an id, carrying the REST route that serves it and
// every GraphQL field and MCP tool that exposes it. The surface tables are now
// PROJECTIONS of this -- `QUERY_BINDINGS` and `MCP_TOOL_ROUTES` are computed
// here, not maintained beside it -- so there is one place an operation is
// named and one place a rename has to happen.
//
// ## Three modelling decisions, each measured rather than assumed
//
// EXPOSURE IS A LIST, NOT AN OPTIONAL FIELD. The obvious shape is
// `graphql?: Field`, and it is wrong: 4 operations carry more than one GraphQL
// field (`opportunity_boards` and `registry_leaderboards` both serve
// registry-leaderboards) and 16 carry more than one MCP tool
// (agent-catalog has three). An optional field would have made the second
// exposure an exception to smuggle somewhere, which is the shape this epic
// exists to delete. A zero-length list says "this surface does not expose it"
// without a special case.
//
// A SURFACE-ONLY OPERATION IS AN OPERATION. `saved_query` is served by GraphQL
// and no route; twelve MCP tools compose several routes or none. They are not
// missing entries, they are operations whose `rest` is null -- representable,
// not exceptional.
//
// A MISS IS A TYPED ERROR. `operationById` throws `UnknownOperationError`
// rather than returning null, because null is what `dataComponent` returned for
// two different reasons and the caller could not tell which (#10718). An id
// that does not resolve is a defect in the registry, and it fails at load with
// the offending surface named.

import {
  API_ROUTES,
  FEED_ROUTES,
  routeQuerySchemasForPathname,
  schemaRefForArtifactPath,
  type RouteQuerySchemas,
} from "./contracts.ts";
import {
  GRAPHQL_EXPOSURES,
  SUBSCRIPTION_EXPOSURES,
  type GraphqlExposure,
} from "../schemas-src/graphql/query-exposures.ts";
import { MCP_EXPOSURES, type McpExposure } from "./mcp-tool-exposures.ts";

/** The REST route serving an operation: an API route or a feed route. */
export type RestRoute =
  (typeof API_ROUTES)[number] | (typeof FEED_ROUTES)[number];

/** One MCP tool's exposure of an operation, with the tool's own name. */
export interface McpToolExposure extends McpExposure {
  readonly tool: string;
}

export interface Operation {
  /** The id every surface resolves to. Unique across REST, feeds and surfaces. */
  readonly id: string;
  /**
   * The REST route that serves it, or null where no route does.
   *
   * Null is one fact and only one: no route. It is NOT "the response does not
   * describe the GraphQL type" -- that is `GraphqlExposure.reshapes`, and
   * conflating the two is what #10772 spent an issue undoing.
   */
  readonly rest: RestRoute | null;
  /** Every GraphQL field exposing it. Empty where GraphQL does not. */
  readonly graphql: readonly GraphqlExposure[];
  /** Every MCP tool exposing it. Empty where MCP does not. */
  readonly mcp: readonly McpToolExposure[];
}

/** A reference to an operation the registry does not have. */
export class UnknownOperationError extends Error {
  /** The id that did not resolve. */
  readonly operationId: string;
  /** The surface entry that named it, so the fix has an address. */
  readonly namedBy: string;

  // Assigned in the body rather than declared as parameter properties: node
  // runs this tree by STRIPPING types, and a parameter property is syntax that
  // has to be compiled rather than erased ("not supported in strip-only mode").
  constructor(operationId: string, namedBy: string) {
    super(
      `${namedBy} names operation "${operationId}", which no route or surface declares. ` +
        `Operation ids are declared by src/contracts.ts (API_ROUTES, FEED_ROUTES) ` +
        `and by the surface-only entries in src/operations.ts.`,
    );
    this.name = "UnknownOperationError";
    this.operationId = operationId;
    this.namedBy = namedBy;
  }
}

/** Two operations claiming one id -- the registry's key must stay unique. */
class DuplicateOperationError extends Error {
  constructor(id: string) {
    super(
      `Two operations claim the id "${id}". The id is the key every surface ` +
        `resolves to, so it has to be unique across API_ROUTES, FEED_ROUTES ` +
        `and the surface-only operations.`,
    );
    this.name = "DuplicateOperationError";
  }
}

function buildOperations(): readonly Operation[] {
  const restRoutes: RestRoute[] = [...API_ROUTES, ...FEED_ROUTES];

  /** Mutable while composing; frozen into `Operation`s at the end. */
  interface Draft {
    id: string;
    rest: RestRoute | null;
    graphql: GraphqlExposure[];
    mcp: McpToolExposure[];
  }
  const drafts = new Map<string, Draft>();
  const draft = (id: string, rest: RestRoute | null): Draft => {
    if (drafts.has(id)) throw new DuplicateOperationError(id);
    const created: Draft = { id, rest, graphql: [], mcp: [] };
    drafts.set(id, created);
    return created;
  };

  for (const rest of restRoutes) draft(rest.id, rest);

  // A surface-only operation is named by the surface itself, which is the only
  // name it has. It is created rather than rejected, and the id-collision check
  // above is what stops a field quietly taking a route's id.
  const attach = (
    id: string | null,
    surfaceName: string,
    namedBy: string,
  ): Draft => {
    if (id === null) return draft(surfaceName, null);
    const found = drafts.get(id);
    if (!found) throw new UnknownOperationError(id, namedBy);
    return found;
  };

  for (const exposure of [...GRAPHQL_EXPOSURES, ...SUBSCRIPTION_EXPOSURES]) {
    attach(
      exposure.operation,
      exposure.field,
      `GraphQL field ${exposure.field}`,
    ).graphql.push(exposure);
  }
  for (const [tool, exposure] of Object.entries(MCP_EXPOSURES)) {
    attach(exposure.operation, tool, `MCP tool ${tool}`).mcp.push({
      ...exposure,
      tool,
    });
    // A tool that answers more than one operation is exposing each of them, and
    // the extra ones would otherwise read as unexposed.
    for (const extra of exposure.additionalOperations ?? []) {
      const found = drafts.get(extra);
      if (!found) {
        throw new UnknownOperationError(extra, `MCP tool ${tool}`);
      }
      found.mcp.push({ ...exposure, tool });
    }
  }

  return [...drafts.values()].map((entry) => Object.freeze(entry));
}

/** Every operation, in declaration order: routes, feeds, then surface-only. */
export const OPERATIONS: readonly Operation[] = buildOperations();

const BY_ID = new Map(OPERATIONS.map((operation) => [operation.id, operation]));

/**
 * The operation with this id.
 *
 * THROWS rather than answering null. A caller asking by id has one in hand, so
 * a miss is a registry defect and not a branch to take -- and a null here is
 * the failure #10718 removed elsewhere, where one absent answer stood for two
 * different causes.
 */
export function operationById(id: string, namedBy = "caller"): Operation {
  const found = BY_ID.get(id);
  if (!found) throw new UnknownOperationError(id, namedBy);
  return found;
}

/** The operation this id names, or null -- for a caller that is ASKING whether. */
export function findOperation(id: string): Operation | null {
  return BY_ID.get(id) ?? null;
}

/** The REST path an operation is served at, or null where no route serves it. */
export function operationPath(id: string, namedBy = "caller"): string | null {
  return operationById(id, namedBy).rest?.path ?? null;
}

/**
 * The component an operation's response carries, or null where none does.
 *
 * Derived from the route's artifact path, the same way `dataComponent` derives
 * it for the gates -- not stored, so it cannot drift from the artifact the
 * route actually serves. A surface-only operation has no route and therefore no
 * published component; `GraphqlExposure.reshapes` is the separate fact that a
 * FIELD's return type is deliberately not this component.
 */
export function operationComponent(
  id: string,
  namedBy = "caller",
): string | null {
  const rest = operationById(id, namedBy).rest;
  if (!rest || !("artifact_path" in rest) || !rest.artifact_path) return null;
  return schemaRefForArtifactPath(rest.artifact_path);
}

/**
 * The canonical input schema for an operation: the route's own query schemas.
 *
 * Resolved through `routeQuerySchemasForPathname` rather than copied, so the
 * three surfaces read the SAME Zod object the REST boundary parses with -- the
 * point of the epic this belongs to. Null where no route serves the operation,
 * or where the route declares no query surface.
 */
export function operationInput(
  id: string,
  namedBy = "caller",
): RouteQuerySchemas | null {
  const path = operationPath(id, namedBy);
  return path === null ? null : routeQuerySchemasForPathname(path);
}
