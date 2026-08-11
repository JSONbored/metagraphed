// Which API route each MCP tool mirrors (#9880).
//
// DERIVED, not declared (#10781). This file used to hold the map itself, with
// each entry spelling a route PATH as a string -- independently of
// `API_ROUTES`, which owns the path, and of
// `schemas-src/graphql/query-exposures.ts`, which spelled the same paths again
// for GraphQL. Three spellings of one fact, joined by string equality, and a
// string join cannot tell a typo from a rename.
//
// The declarations moved to `src/mcp-tool-exposures.ts` keyed by OPERATION ID,
// and `OPERATIONS` resolves the id to its route. The shape below is unchanged,
// so every consumer reads what it always read -- but the path is now looked up
// from the route table rather than restated beside it, and an id that resolves
// to nothing throws at load with the tool named, where a bad path used to read
// as an ordinary string.
//
// `route: null` IS A CLASSIFICATION, NOT AN OMISSION, and it still carries its
// reason: `ask`, `call_subnet_surface` and `decode_evm_call` genuinely mirror
// no route. The reasons live with the declarations.

import { MCP_EXPOSURES } from "./mcp-tool-exposures.ts";
import { operationPath } from "./operations.ts";

export interface McpToolRoute {
  /** The plain (non-network-prefixed) route path, or null. */
  route: string | null;
  /** Why null. Required when route is null, read by whoever asks "why". */
  reason?: string;
  /**
   * Further routes the same tool answers.
   *
   * Two tools genuinely serve a LIST form and a DETAIL form off one name --
   * `get_domain_summary` returns every domain without `domain` and one with
   * it, and `list_review_gaps` reads both gap feeds. Collapsing that to a
   * single route would make the other look agent-unreachable when it is not.
   */
  additionalRoutes?: string[];
}

function toolRoute(tool: string): McpToolRoute {
  const exposure = MCP_EXPOSURES[tool];
  /* v8 ignore next -- the key comes from Object.keys of the same record. */
  if (!exposure) throw new Error(`No MCP exposure declared for tool ${tool}`);
  const namedBy = `MCP tool ${tool}`;
  const additional = (exposure.additionalOperations ?? [])
    .map((id) => operationPath(id, namedBy))
    .filter((path): path is string => path !== null);
  return {
    route:
      exposure.operation === null
        ? null
        : operationPath(exposure.operation, namedBy),
    ...(exposure.reason === undefined ? {} : { reason: exposure.reason }),
    ...(additional.length === 0 ? {} : { additionalRoutes: additional }),
  };
}

/** Every MCP tool, and the route it mirrors. */
export const MCP_TOOL_ROUTES: Readonly<Record<string, McpToolRoute>> =
  Object.freeze(
    Object.fromEntries(
      Object.keys(MCP_EXPOSURES).map((tool) => [tool, toolRoute(tool)]),
    ),
  );
