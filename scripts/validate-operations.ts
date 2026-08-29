// Every surface exposure resolves to an operation, and every operation is
// reachable (#10781).
//
// BOTH DIRECTIONS, because each catches a different way the registry rots:
//
//   an exposure naming no operation   -> a GraphQL field or MCP tool pointing at
//                                        an id nothing declares. This is the
//                                        failure `saved_query` and `extrinsic`
//                                        had for months while their route was a
//                                        PATH STRING: `/api/v1/queries/{id}` has
//                                        never existed, and nothing could tell
//                                        that from a route since renamed.
//
//   an operation no surface exposes   -> a route no caller can reach from any
//                                        surface. Not automatically wrong --
//                                        `api-index`, `openapi` and
//                                        `search-resolve` are meta routes REST
//                                        serves and neither other surface
//                                        should -- so those are DECLARED, and
//                                        the list only shrinks.
//
// The first direction is now largely structural: `OPERATIONS` throws
// `UnknownOperationError` while composing, so a bad id fails at import before
// this gate runs. That is deliberate -- the gate exists so the failure has a
// readable report and so the SECOND direction, which no throw can express, is
// checked at all.

import { pathToFileURL } from "node:url";
import { OPERATIONS, type Operation } from "../src/operations.ts";
import {
  GRAPHQL_EXPOSURES,
  type GraphqlExposure,
} from "../schemas-src/graphql/query-exposures.ts";
import { MCP_EXPOSURES, type McpExposure } from "../src/mcp-tool-exposures.ts";

/**
 * Operations no surface exposes, each with the reason.
 *
 * A number would not do here: the question "should something expose this" has
 * a per-route answer, and a count cannot hold one. THE LIST ONLY SHRINKS -- an
 * entry naming an operation that has since gained a surface fails as stale, the
 * same idiom the argument-divergence and unreferenced-export gates use.
 */
export const DECLARED_UNEXPOSED: Readonly<Record<string, string>> = {
  "api-index":
    "the route index itself. GraphQL publishes its schema through introspection " +
    "and MCP through tools/list, so both already answer this question in their " +
    "own vocabulary; mirroring the REST index would be a third answer.",
  openapi:
    "the OpenAPI document. Same reason as api-index -- it describes the REST " +
    "surface, and the other two surfaces describe themselves.",
  "export-chain-events":
    "the paid export tier (#11600), and HTTP-only on purpose. The x402 gate " +
    "prices a request by its resolved pathname; every MCP call arrives on " +
    "/mcp and every GraphQL call on /api/v1/graphql, both `edge` family at " +
    "weight 1. Mirroring this route on either surface would serve a " +
    "25,000-row export for free through the surface the payment exists to " +
    "bound. The free paginated twin (list_chain_events / chainEvents) is " +
    "reachable from both and is unchanged.",
  "search-resolve":
    "a redirect helper: it resolves a search hit to its canonical URL and " +
    "answers 302, which is an HTTP affordance neither GraphQL nor MCP has.",
  "validator-operator-directory":
    "an HTTP transport projection for the website's validator directory. " +
    "Agents already receive the richer validator rows through " +
    "list_global_validators; mirroring the compact SSR payload would expose a " +
    "second, less capable answer to the same domain question.",
  "account-holder-directory":
    "an HTTP transport projection for the website's account directory. " +
    "Agents already receive the richer independently sortable rows through " +
    "list_accounts; mirroring the compact SSR payload would expose a second, " +
    "less capable answer to the same domain question.",

  // ── three feeds REST serves and no surface reaches ────────────────────────
  //
  // A CAPABILITY GAP, recorded rather than hidden, and it is what this gate
  // found on its first run (#10781). `get_feed`'s `kind` enum
  // (schemas-src/mcp-tools/feed.ts FEED_KINDS) publishes registry, incidents,
  // gaps, upgrades and subnet -- five of the eight feed routes. The other three
  // have no selector value, so an agent cannot ask for them at all. Closing
  // this means adding the kind AND the runtime allow-list entry in
  // src/feed-mcp.ts, which is a feature and belongs in its own issue; declaring
  // it here is what stops it being invisible for another eight months.
  "feed-revenue":
    "REST-only: `get_feed` publishes no `revenue` kind, so no agent can select " +
    "this feed. A gap to close, not a difference to keep.",
  "feed-wallets":
    "REST-only: `get_feed` publishes no `wallets` kind. Same gap as feed-revenue.",
  "feed-watch":
    "REST-only: `get_feed` publishes no `watch` kind. Same gap as feed-revenue.",
};

export interface OperationsReport {
  /** Exposures naming an id no operation declares. */
  unresolved: string[];
  /** Operations no surface exposes and nothing declares. */
  unexposed: string[];
  /** Declared entries that no longer name an unexposed operation. */
  stale: string[];
  /** Operations checked. */
  total: number;
}

/**
 * A pure function over its inputs, so a test can drive it with a MUTATED
 * registry and prove each direction actually fails. A gate only ever run
 * against a passing tree proves nothing about what it would catch.
 */
export function checkOperations(
  operations: readonly Operation[] = OPERATIONS,
  graphqlExposures: readonly GraphqlExposure[] = GRAPHQL_EXPOSURES,
  mcpExposures: Readonly<Record<string, McpExposure>> = MCP_EXPOSURES,
  declaredUnexposed: Readonly<Record<string, string>> = DECLARED_UNEXPOSED,
): OperationsReport {
  const known = new Set(operations.map((operation) => operation.id));
  const unresolved: string[] = [];
  for (const exposure of graphqlExposures) {
    if (exposure.operation === null) continue;
    if (!known.has(exposure.operation)) {
      unresolved.push(
        `GraphQL field ${exposure.field} names operation "${exposure.operation}"`,
      );
    }
  }
  for (const [tool, exposure] of Object.entries(mcpExposures)) {
    for (const id of [
      ...(exposure.operation === null ? [] : [exposure.operation]),
      ...(exposure.additionalOperations ?? []),
    ]) {
      if (!known.has(id)) {
        unresolved.push(`MCP tool ${tool} names operation "${id}"`);
      }
    }
  }

  const unexposed: string[] = [];
  const usedDeclarations = new Set<string>();
  for (const operation of operations) {
    if (operation.graphql.length > 0 || operation.mcp.length > 0) continue;
    if (operation.id in declaredUnexposed) {
      usedDeclarations.add(operation.id);
      continue;
    }
    unexposed.push(
      `${operation.id} (${operation.rest?.path ?? "no route"}) is exposed by no surface`,
    );
  }

  return {
    unresolved,
    unexposed,
    stale: Object.keys(declaredUnexposed).filter(
      (id) => !usedDeclarations.has(id),
    ),
    total: operations.length,
  };
}

function main(): void {
  const report = checkOperations();
  const problems = [
    ...report.unresolved.map(
      (line) => `  ${line}, which no route or surface declares`,
    ),
    ...report.unexposed.map((line) => `  ${line}`),
    ...report.stale.map(
      (id) =>
        `  ${id} is declared unexposed and now HAS a surface -- delete the entry`,
    ),
  ];
  if (problems.length) {
    console.error(
      `operations: ${problems.length} problem(s) across ${report.total} operation(s):\n` +
        problems.join("\n"),
    );
    process.exit(1);
  }
  const withRest = OPERATIONS.filter((operation) => operation.rest).length;
  console.log(
    `operations: ${report.total} operation(s) -- ${withRest} served by a route, ` +
      `${report.total - withRest} surface-only; every exposure resolves, ` +
      `${Object.keys(DECLARED_UNEXPOSED).length} declared unexposed.`,
  );
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
