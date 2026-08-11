// The one way an MCP list loader pages a collection (#9730).
//
// ## Why this module exists rather than an option at 32 call sites
//
// `paginateRows` in workers/list-query.ts pages only when the caller passed
// `limit` or `cursor`. With neither, it returns EVERY row -- and `DEFAULT_LIMIT`
// is unreachable, because it applies only once the caller has already opted in.
//
// That is right for REST, where a browser can stream the whole collection, and
// wrong for MCP, where the context window is the hard constraint. Measured
// against production on 2026-08-07, calling each zero-required-argument tool
// with `{}`:
//
//   list_endpoints      9,059,868 bytes   3,492 rows
//   list_surfaces       7,820,280 bytes   3,492 rows
//   list_evidence       3,623,240 bytes   3,871 rows
//   list_search         2,881,186 bytes   3,757 rows
//   list_search_index   2,208,844 bytes   3,757 rows
//   list_profiles       1,287,854 bytes     129 rows
//
// Seventeen tools over 100 KB. The largest is roughly 2.3M tokens -- ten times a
// 200K context window -- from a tool that takes no required arguments and is
// therefore a plausible FIRST call from an agent exploring the server.
//
// #9701 fixed exactly one of these (`list_candidates`, 7.5 MB) by setting the
// limit inside that one loader. Doing that 32 more times would leave the next
// loader to be written with the same hole and nothing to catch it. A single
// wrapper makes the correct call the only import available, and
// tests/mcp-list-query-default.test.ts asserts no `src/*-mcp.ts` reaches past
// it -- so a loader added tonight is covered tonight.
//
// ## What it does NOT change
//
// Nothing about REST. `applyQueryFilters` keeps its existing behaviour for
// every caller that does not pass `defaultLimit`, and the two `workers/` call
// sites do not. `total` and `next_cursor` still ride in the envelope, so the
// full collection stays reachable by paging -- it stops being reachable by
// accident.
import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "./route-limits.ts";

/**
 * `applyQueryFilters` with the MCP page default applied.
 *
 * Identical in every other respect -- same collection config, same filters,
 * same validation, same errors. An explicit `limit` in the query string still
 * wins; this only supplies one when the caller gave none.
 */
/**
 * The query-string spelling of a boolean, and the one decoder for it (#10787).
 *
 * A route that publishes a filter as a `["true","false"]` STRING enum is
 * spelling a boolean the only way a query string can. GraphQL has a real
 * `Boolean` and publishes it, which is the stricter and more honest of the two
 * spellings -- but four fields could not, because their resolvers hand the
 * argument straight to an MCP loader that validated it with
 * `optionalEnum(args, name, ["true","false"])`. A JS boolean was rejected
 * there where the string was accepted, and NOTHING PREVENTED IT BUT A COMMENT:
 * the divergence table carried a paragraph saying "moving the spelling means
 * moving the forwarding with it", and nobody moved either.
 *
 * This is that forwarding, once. It is a LENIENT codec in the sense #8942
 * measured -- MCP's decoder accepts what REST's would reject, over the same
 * canonical vocabulary -- and it is declared here rather than hand-written at
 * each site, so a loader written next month gets it by importing the decoder
 * it already needs.
 */
export const BOOLEAN_WORDS = ["true", "false"] as const;

/**
 * `args` with the named boolean filters rewritten in the route's spelling.
 *
 * Returns the SAME object when nothing needed rewriting, so a loader whose
 * caller already sent the string form allocates nothing.
 */
export function withBooleanWords(
  args: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): Record<string, unknown> | null | undefined {
  if (!args) return args;
  let decoded: Record<string, unknown> | null = null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== "boolean") continue;
    decoded ??= { ...args };
    decoded[key] = value ? "true" : "false";
  }
  return decoded ?? args;
}

export function applyMcpQueryFilters(
  data: Record<string, unknown> | null | undefined,
  url: URL,
  queryCollection: string,
  queryFilterNames: string[] = [],
  options: { csvResponse?: boolean; defaultLimit?: number } = {},
): ReturnType<typeof applyQueryFilters> {
  return applyQueryFilters(data, url, queryCollection, queryFilterNames, {
    ...options,
    // A loader may raise its own ceiling (a collection whose rows are tiny, or
    // one whose whole point is the full network), but it has to say so -- the
    // default is what applies when nobody thought about it, which is precisely
    // the case that produced a 9 MB response.
    defaultLimit: options.defaultLimit ?? MCP_LIST_LIMIT_DEFAULT,
  });
}

export type { Row };
