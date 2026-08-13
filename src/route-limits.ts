// Per-route `limit` page-size ceilings, in one place (#9127).
import { QUERY_ENUMS } from "../schemas-src/query-enums.ts";
//
// Each of these numbers used to be stated three times: the constant the handler
// enforces, the `maximum` the contract publishes, and the "(default N, max M)"
// prose in the route and MCP-tool descriptions. Three copies of one fact, with
// nothing tying them together -- so they drifted. #8251 raised the validator
// ceiling 100 -> 2000 for the directory's full-set fetch and moved only the
// constant, leaving the published OpenAPI declaring a maximum of 100 while the
// route served 2000. A client generated from our own spec rejected, at build
// time, the exact request our own site makes.
//
// Now the constant is the only declaration: `contracts.ts` reads the schema
// `maximum` from here and interpolates the same value into the prose, so the
// published contract cannot disagree with what the handler enforces. Changing a
// ceiling is a one-line edit that regenerates into every downstream artifact.
//
// This module is deliberately a LEAF -- plain numbers, zero imports. `contracts.ts`
// is depended on by the MCP server, the scripts, the generators and the UI's doc
// tooling; it can take on a leaf like this without risking an import cycle, which
// is why the ceilings live here rather than being pulled out of the seven feature
// modules that own the rest of each route's behaviour. Those modules re-export
// their own ceiling, so every existing import path still works.
//
// The generic pagination bounds that apply to *every* paginated route, rather
// than to one, live in `workers/request-params.ts` (MIN_LIMIT / MAX_LIMIT /
// MAX_OFFSET) -- these are the per-route narrowings of those.

/** `/api/v1/validators` -- network-wide validator/operator leaderboard. */
export const GLOBAL_VALIDATOR_LIMIT_DEFAULT = 20;
// #8251: raised 100 -> 2000 so the validators directory can serve the FULL
// validator set (~1,014 live) in one request for client-side virtualization,
// with headroom for growth. ~115KB/100 rows uncompressed (measured live), so a
// full fetch is ~1.2MB pre-gzip -- acceptable for a once-per-visit, cached,
// short-stale directory read. `apps/ui` depends on it: `server.ts` fetches
// `?limit=2000` on the SSR path and `ALL_VALIDATORS_LIMIT` mirrors it.
export const GLOBAL_VALIDATOR_LIMIT_MAX = 2000;

/**
 * `/api/v1/registry/leaderboards` -- the registry board rankings.
 *
 * Named here rather than borrowed: the route published `BLOCK_PAGINATION`'s
 * ceiling, which is the BLOCK EXPLORER's page size and coincides with this one
 * at 100 by accident, and the handler's default of 20 was a literal at two
 * call sites with nothing tying them together (#10218).
 */
export const LEADERBOARDS_LIMIT_DEFAULT = 20;
export const LEADERBOARDS_LIMIT_MAX = 100;

/** `/api/v1/subnets/movers` -- cross-subnet momentum leaderboard. */
export const MOVERS_LIMIT_DEFAULT = 20;
export const MOVERS_LIMIT_MAX = 100;

/**
 * `/api/v1/validators/economics` -- cross-subnet cost-to-validate ranking (#9324).
 *
 * The max is deliberately above the current subnet count: the whole point of the
 * route is "across ALL subnets, where is it cheapest to earn", and a ceiling that
 * silently truncated the answer would make the ranking wrong rather than merely
 * short. One row per subnet, so this is bounded by the network, not by a scan.
 */
export const VALIDATOR_ECONOMICS_LIMIT_DEFAULT = 50;
export const VALIDATOR_ECONOMICS_LIMIT_MAX = 512;

/** `/api/v1/chain/turnover` -- network-wide turnover leaderboard. */
export const CHAIN_TURNOVER_LIMIT_DEFAULT = 20;
export const CHAIN_TURNOVER_LIMIT_MAX = 100;

/** `/api/v1/accounts/top-holders` -- balance-based top-holder leaderboard. */
export const TOP_HOLDERS_LIMIT_DEFAULT = 20;
export const TOP_HOLDERS_LIMIT_MAX = 100;

/**
 * `/api/v1/subnets/{netuid}/holders` -- per-subnet alpha holder leaderboard (#9557).
 *
 * The same 20/100 pair as the chain-wide holder ranking above, deliberately: the
 * two answer the same shape of question at different scopes, and a caller moving
 * between them should not have to relearn the page size. The cap does not bound
 * the WORK -- ranking requires aggregating every holder on the subnet before any
 * slice is taken -- it bounds the payload, which is what a caller charting a
 * leaderboard actually needs.
 */
export const SUBNET_HOLDERS_LIMIT_DEFAULT = 20;
export const SUBNET_HOLDERS_LIMIT_MAX = 100;

/**
 * `/api/v1/chain/holders` -- every subnet ranked by alpha-ownership concentration (#9607).
 *
 * Bounded by the network rather than by a scan: one row per subnet, ~129 today.
 * The default shows the concentrated tail a caller came for; the max is above
 * the subnet count on purpose, so "rank every subnet" is one request and the
 * answer is never silently truncated -- the same reasoning
 * VALIDATOR_ECONOMICS_LIMIT_MAX is sized on.
 */
export const CHAIN_HOLDERS_LIMIT_DEFAULT = 20;
export const CHAIN_HOLDERS_LIMIT_MAX = 512;

/**
 * `/api/v1/subnets/{netuid}/surface-history` -- one subnet's surface audit trail (#9612).
 *
 * A feed rather than a leaderboard, so it takes the analytics-feed sizing the
 * chain-identity-history feed uses: enough to read a subnet's recent churn in
 * one request, capped where a page stops being a page. The table never prunes
 * -- history outliving the surface it describes is the point -- so an uncapped
 * read would grow without bound.
 */
export const SURFACE_HISTORY_LIMIT_DEFAULT = 50;
export const SURFACE_HISTORY_LIMIT_MAX = 200;

/**
 * `/api/v1/chain/governance/emission-changes` -- the emission-gate change log (#9615).
 *
 * Analytics-feed sizing, like the identity-history feed below. The three source
 * tables gain a row only when a value actually moves, so the whole log is 171
 * rows today -- the cap exists for the day it is not, and because the union
 * read is unbounded without one.
 */
export const EMISSION_CHANGES_LIMIT_DEFAULT = 50;
export const EMISSION_CHANGES_LIMIT_MAX = 200;

/** `/api/v1/accounts` -- site-wide accounts leaderboard. */
export const ACCOUNTS_LIST_LIMIT_DEFAULT = 20;
export const ACCOUNTS_LIST_LIMIT_MAX = 100;

/** `/api/v1/subnets/{netuid}/event-summary` -- the recent-events tail. */
export const SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT = 10;
export const SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX = 50;

/** `/api/v1/chain/identity-history` -- network-wide identity-change feed. */
// Analytics-feed limit convention copied from the chain-calls / chain-signers
// feeds (parseLimitParam with defaultLimit: 50, maxLimit: 200 -- the
// recent-events feed sizing): default 50 changes, capped at 200.
export const CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT = 50;
export const CHAIN_IDENTITY_HISTORY_LIMIT_MAX = 200;

/**
 * The three window families that predate this module's `*_WINDOW_DAYS` idiom
 * (#10218).
 *
 * Each was declared twice: a `label -> days` map next to the handler that
 * reads it, and the same labels written out again as a Zod enum in
 * `schemas-src/route-queries.ts` -- 30 restatements of the analytics pair, 6
 * of the history set, 1 of the uptime set. Two declarations of one vocabulary
 * is what the three families BELOW this comment already avoid by deriving the
 * enum from the map's keys, and these now do the same.
 *
 * They live here, with the ceilings, because that is where a route's declared
 * bounds live and because this module is a leaf: `schemas-src` can read it
 * without dragging a Worker module into the schema layer. `workers/config.ts`
 * and `src/neuron-history.ts` re-export their own family, so every existing
 * import path still works -- the same arrangement the per-route ceilings use.
 */

/** The trailing 7d/30d aggregate the analytics feeds compute over. */
export const ANALYTICS_WINDOW_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const ANALYTICS_WINDOWS = Object.keys(ANALYTICS_WINDOW_DAYS);
export const DEFAULT_ANALYTICS_WINDOW = "7d";

/**
 * `/api/v1/subnets/{netuid}/uptime` -- the long-horizon availability history.
 *
 * Deliberately disjoint from the analytics pair: this route reads a daily
 * rollup that exists to answer "how has this held up over months", so its
 * shortest window is the analytics family's longest-plus-two.
 */
export const UPTIME_WINDOW_DAYS: Record<string, number> = {
  "90d": 90,
  "1y": 365,
};
export const UPTIME_WINDOWS = Object.keys(UPTIME_WINDOW_DAYS);
export const DEFAULT_UPTIME_WINDOW = "90d";

/**
 * The per-entity history windows (subnet/neuron/economics timelines).
 *
 * `all` maps to no lower bound rather than to a day count, which is why the
 * span is nullable -- the one family where the value is not simply a number.
 */
export const HISTORY_WINDOW_DAYS: Record<string, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
  all: null,
};
export const HISTORY_WINDOWS = Object.keys(HISTORY_WINDOW_DAYS);
export const DEFAULT_HISTORY_WINDOW = "30d";

/**
 * The 7d/30d/90d trend window, named (#11008).
 *
 * SIXTEEN routes declared this vocabulary as an inline `["7d", "30d", "90d"]`
 * -- the per-entity history and activity family: a subnet's performance,
 * concentration, yield and validator-economics history, an account's stake
 * flow, registrations, serving and prometheus, and chain turnover. Every other
 * window vocabulary in this file is named and derived from its own days map
 * (46 of the 64 `windowSchema()` call sites use one); this was the outlier, and
 * a value set written sixteen times is sixteen places to forget when it moves.
 *
 * DISTINCT from HISTORY_WINDOWS, which is this plus `1y` and `all` -- the
 * long-horizon variant a daily rollup can answer and these cannot. Naming them
 * apart is the point: they were never the same window, and the inline spelling
 * made that impossible to see.
 */
export const TREND_WINDOW_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const TREND_WINDOWS = Object.keys(TREND_WINDOW_DAYS);
export const DEFAULT_TREND_WINDOW = "30d";

/**
 * The feed families (`/api/v1/feeds/*`) -- page size and watchlist length.
 *
 * 50 items is what `src/feeds.ts` has always served and what all 24 published
 * feed paths declare; it is here rather than inline in the feed table so the
 * published bound and the enforced one are the same number (#10218).
 */
export const FEED_LIMIT_MAX = 50;
/**
 * `?ids=` on the watch feed: 50 kind-prefixed entities, the longest of which
 * is an ss58 at 48 characters plus its prefix and separator.
 */
export const FEED_WATCH_IDS_MAX_LENGTH = 2500;

/**
 * `/api/v1/health/failure-reasons` -- the probe failure-reason mix (#9622).
 *
 * Windows rather than a free integer: the route reads a DAILY rollup, so an
 * arbitrary hour count would imply a resolution the table does not have. 30d is
 * the default because it matches the raw table's retention -- the window a
 * reader already reasons in -- while 90d and 180d reach into the history the
 * rollup keeps that the raw table no longer can, which is the whole reason it
 * exists.
 */
export const FAILURE_REASONS_WINDOW_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
};
export const FAILURE_REASONS_WINDOWS = Object.keys(FAILURE_REASONS_WINDOW_DAYS);
export const DEFAULT_FAILURE_REASONS_WINDOW = "30d";

/**
 * `/api/v1/chain/concentration/history` -- the network-wide concentration
 * series (#9628).
 *
 * Windows rather than a free day count, because the source is a DAILY rollup.
 * 30d is the default and matches what the per-subnet twin already offers, even
 * though `neuron_daily` -- which the rollup cannot predate -- is itself only
 * ~27 days deep: the payload reports the depth it FOUND, so a wider window is
 * answered honestly rather than refused.
 */
export const CHAIN_CONCENTRATION_HISTORY_WINDOW_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const CHAIN_CONCENTRATION_HISTORY_WINDOWS = Object.keys(
  CHAIN_CONCENTRATION_HISTORY_WINDOW_DAYS,
);
export const DEFAULT_CHAIN_CONCENTRATION_HISTORY_WINDOW = "30d";

/**
 * `/api/v1/subnets/{netuid}/emission-pipeline/history` -- one subnet's pipeline
 * series (#9625).
 *
 * Windows rather than a free day count, because the source is a DAILY snapshot
 * and an arbitrary number would imply a resolution it does not have. 30d is the
 * default even though only 5 days of pipeline captures exist: the window a
 * reader already thinks in, and the payload reports the depth it actually
 * found rather than the one it was asked for.
 */
export const PIPELINE_HISTORY_WINDOW_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
};
export const PIPELINE_HISTORY_WINDOWS = Object.keys(
  PIPELINE_HISTORY_WINDOW_DAYS,
);
export const DEFAULT_PIPELINE_HISTORY_WINDOW = "30d";

/**
 * `list_candidates` (MCP) -- the network-wide candidate-surface catalog.
 *
 * The DEFAULT that used to live here is MCP_LIST_LIMIT_DEFAULT below now: the
 * hole #9701 fixed here was never specific to candidates, only measured here
 * first (7,537,056 bytes for 2,037 candidates -- roughly 1.9M tokens, about ten
 * 200K context windows, from a tool taking no required arguments). #9730 found
 * sixteen more sharing the same seam, the largest at 9 MB, and moved the
 * default to the seam. Only the CEILING is candidate-specific.
 */
export const CANDIDATES_LIMIT_MAX = 1000;

/**
 * `/api/v1/chain/concentration/subnets` -- every subnet ranked by how widely
 * one lens of its distribution is spread (#9717).
 *
 * Sized exactly like CHAIN_HOLDERS_LIMIT_*, and for the same reason: the
 * collection is bounded by the network (one row per subnet, ~129 today), not by
 * a scan. The default shows the tail a caller came for; the max sits above the
 * subnet count on purpose, so "rank every subnet" is one request and is never
 * silently truncated. Screening the whole network in a single call is the case
 * this route exists for -- a ceiling below the subnet count would defeat it.
 */
export const CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT = 20;
export const CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX = 512;

/**
 * `/api/v1/chain/emission-pipeline` -- the v440 decomposition per subnet (#9720).
 *
 * A CEILING with no default: the collection is one row per subnet (~129 today)
 * and the REST route has always served all of them, so imposing a default here
 * would truncate every existing caller's body without their asking. The MCP
 * tool carries the narrowing default instead -- a browser can stream 56 KB and
 * a context window cannot, the same asymmetry #9701 is argued on. The max sits above the subnet count so "the whole pipeline" stays
 * one request.
 */
export const EMISSION_PIPELINE_LIMIT_MAX = 512;
export const EMISSION_PIPELINE_MCP_LIMIT_DEFAULT = 20;

/** Rows list_provider_endpoints returns when the caller names no limit. */
export const PROVIDER_ENDPOINTS_LIMIT_DEFAULT = 50;

/**
 * Every MCP list tool that pages through `applyQueryFilters` (#9730).
 *
 * A DEFAULT, not a ceiling, and the MCP surface is the reason. `paginateRows`
 * in workers/list-query.ts pages only when the caller passed `limit` or
 * `cursor`; with neither it returns EVERY row, and `DEFAULT_LIMIT` is
 * unreachable until the caller has already opted in. So the 32 loaders under
 * src/*-mcp.ts forwarded no limit and served the whole collection.
 *
 * Measured against production 2026-08-07, calling each zero-required-argument
 * tool with `{}`: list_endpoints **9,059,868 bytes** (3,492 rows), list_surfaces
 * 7,820,280, list_evidence 3,623,240, list_search 2,881,186, list_search_index
 * 2,208,844, list_profiles 1,287,854 -- seventeen tools over 100 KB. The largest
 * is roughly 2.3M tokens, more than ten times a 200K context window, from a tool
 * that takes no required arguments and is therefore a plausible FIRST call.
 *
 * Deliberately narrower than the REST routes, which keep serving unbounded: a
 * browser can stream 9 MB and a context window cannot, so the surface with the
 * hard constraint carries the default -- #9701's asymmetry, generalised from
 * the one tool that got measured to every tool that shares the seam. `total`
 * and `next_cursor` ride in the envelope either way, so the full set stays
 * reachable by paging; it is no longer reachable by accident.
 *
 * 20 matches the value #9701 chose, for the same reason: enough rows to see the
 * shape of a collection, small enough that a wrong guess costs nothing.
 */
export const MCP_LIST_LIMIT_DEFAULT = 20;

/**
 * `/api/v1/search/semantic` -- the meaning-ranked registry search (#10075).
 *
 * Here for the reason this module exists: the route published `limit` as
 * `{"type":"string"}` and `q` as unbounded, while the handler runs
 * `clampLimit(value, 10, 20)` and rejects a `q` over 1,000 characters. A client
 * generated from our own spec sent a string where the handler wanted an
 * integer, and had no way to know either ceiling. Reading them from here means
 * the published parameter and the enforcement cannot say different things.
 *
 * `limit` is CLAMPED rather than rejected, unlike the #9916 routes -- a
 * similarity ranking has no meaningful page beyond the top matches, and
 * Vectorize itself caps `topK` at this value.
 */
export const SEMANTIC_LIMIT_DEFAULT = 10;
/**
 * The scopes `/api/v1/search/semantic?type=` accepts.
 *
 * Here rather than in src/ai-search.ts because schemas-src/route-queries.ts
 * has to state it in the contract, and this module is the zero-import leaf
 * both sides already read (#9127). ai-search.ts re-exports it, so the handler
 * and the published enum cannot drift.
 */
export const SEMANTIC_TYPES = QUERY_ENUMS.searchDocumentType;

export const SEMANTIC_LIMIT_MAX = 20;
/** Rejected above this with a 400, not truncated -- an embedded query that was
 * silently cut would rank against text the caller never sent. */
export const SEMANTIC_QUERY_MAX_LENGTH = 1000;

/**
 * `/api/v1/chain-events` -- the network-wide event feed (#10109).
 *
 * TWO constants carried this name with DIFFERENT values, and the contract was
 * written from the one the request path does not use:
 *
 *   src/chain-events-degraded.ts  100   what workers/api.ts clamps the REST
 *                                       route to -- verified live, `?limit=200`
 *                                       answered `count: 100`
 *   src/data-api-mcp.ts           200   what the MCP + GraphQL path clamps to,
 *                                       and what openapi.json published
 *
 * So a caller asking for the advertised ceiling got half of it, with HTTP 200,
 * no error and no header -- data truncation presented as a complete answer,
 * which is exactly what #9916 removed everywhere else.
 *
 * 100 is the resolution because it is what the route ENFORCES; publishing the
 * larger number was the lie. It also restores the direction #9701 assumes --
 * an MCP surface narrows against its route, never widens past it.
 *
 * The clamp itself is left alone. Rejecting an over-limit page rather than
 * truncating it is the #9916 rule and is worth doing here too, but it is a
 * behaviour change for existing callers and does not belong in the same diff
 * as making the published number true.
 */
export const CHAIN_EVENTS_LIMIT_DEFAULT = 50;
export const CHAIN_EVENTS_LIMIT_MAX = 100;

/**
 * The ceiling on a Substrate runtime NAME in a query filter (#10096).
 *
 * `call_module` on the three chain-analytics feeds, and `pallet`/`method` on
 * the event feed. The number was written out eight times before this: three
 * `validateMaxLength(url, "call_module", 100)` calls in
 * workers/request-handlers/analytics.ts, three published schemas, and two
 * local consts in schemas-src/mcp-tools/.
 *
 * The event feed's 64 is deliberately different -- a pallet or method name is
 * shorter than a module path -- so it is its own number rather than a shared
 * one pretending the two are the same constraint.
 */
export const CHAIN_CALL_MODULE_MAX_LENGTH = 100;
export const CHAIN_EVENT_NAME_MAX_LENGTH = 64;

/**
 * The window labels GET /api/v1/health/trends derives.
 *
 * Here rather than in schemas-src/routes/health-surfaces.ts because src/
 * modules need it too and nothing under src/ may import schemas-src/routes/ --
 * that edge failed the metagraphed-data-api Workers Build twice on #10121, and
 * again on #10065 when src/graphql.ts reached for this constant. This module
 * is the zero-import leaf both sides already read (#9127); health-surfaces.ts
 * re-exports it, so the published vocabulary has one owner either way.
 *
 * `workers/config.ts`'s HEALTH_TREND_WINDOWS maps each label to its day count
 * and is the runtime's copy; the two are checked against each other by
 * tests/route-limit-contract-parity.test.ts rather than one importing the
 * other, because schemas-src must not depend on the Worker's config module.
 */
export const HEALTH_TREND_WINDOW_VALUES = ["7d", "30d"] as const;

/**
 * `/api/v1/health/trends` -- the all-subnet trend matrix (#10089).
 *
 * The same defect the semantic block above records, on a second route: `limit`
 * and `offset` were published as `{"type":"string"}` while
 * `handleBulkHealthTrends` runs `parseLimitParam(url, { maxLimit: 512 })` and
 * `parseNonNegativeIntParam`, so `?limit=abc` is a 400 the contract gave a
 * caller no way to anticipate.
 *
 * `BulkHealthTrendsQuerySchema` stated the correct bounds the whole time and is
 * the ONE route query schema runtime code imports -- it just was not the copy
 * being published. schemas-src is a leaf and cannot import this module, so
 * tests/route-limit-contract-parity.test.ts checks the two against each other.
 *
 * Rejected rather than clamped, per #9916: a truncated page reads as an
 * exhausted result set.
 */
export const BULK_HEALTH_TRENDS_LIMIT_MAX = 512;

/**
 * `/api/v1/subnets/{netuid}/emission-split/history` -- one subnet's emission
 * split by recipient class (#10928).
 *
 * Windows rather than a free day count, for the same reason as its
 * `concentration/history` sibling: the source is the DAILY `neuron_daily`
 * rollup, so an arbitrary day count would imply a resolution it does not have.
 * 30d is the default and matches every other neuron_daily-derived series.
 * `neuron_daily` is itself only ~27-33 days deep, so a 90d window is answered
 * with the depth actually FOUND rather than refused -- the payload reports
 * `point_count`, and a caller reading an array length as a month is the failure
 * this reports its way out of.
 */
export const SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS: Record<string, number> =
  {
    "7d": 7,
    "30d": 30,
    "90d": 90,
  };
export const SUBNET_EMISSION_SPLIT_HISTORY_WINDOWS = Object.keys(
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
);
export const DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW = "30d";

/**
 * `/api/v1/subnets/{netuid}/revenue` and `/api/v1/chain/revenue-coverage`
 * -- the window a revenue figure is compared against (#10925).
 *
 * THE VALUES ARE THE GRAINS THE REGISTRY DECLARES. `GRAIN_DAYS` in
 * src/revenue-serving.ts maps `daily -> 1`, `weekly -> 7`, `monthly -> 30`, and
 * a surface contributes only when the window is a whole number of its periods.
 * So these three are not a taste: they are exactly the windows any declared
 * surface can answer, and a fourth value would be a window nothing could fill.
 *
 * 1d REMAINS THE DEFAULT. The window was hardcoded to 1 at nine call sites, and
 * every caller quoting "the" coverage ratio today is quoting a one-day one --
 * changing the default would silently re-denominate all of them.
 *
 * `cumulative` is still unreachable at every window, deliberately: a lifetime
 * total is a running sum with no period, and dividing it by a window compares a
 * subnet's whole history against one day of emission.
 */
export const SUBNET_REVENUE_WINDOW_DAYS: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};
export const SUBNET_REVENUE_WINDOWS = Object.keys(SUBNET_REVENUE_WINDOW_DAYS);
export const DEFAULT_SUBNET_REVENUE_WINDOW = "1d";

/**
 * `/api/v1/subnets/{netuid}/wallets` and `/api/v1/subnets/{netuid}/owner-cut`
 * -- the window those two publish, which the CALLER DOES NOT CHOOSE (#10925).
 *
 * Named here rather than left as a literal because it was stated four times --
 * once in each route's REST handler and once in each of their MCP tools -- and
 * four copies of a number two surfaces must agree on is how a surface starts
 * reporting a 30-day accrual beside a `window_days` of 7. They agreed at the
 * time this was extracted; nothing was making them.
 *
 * Deliberately NOT folded into SUBNET_REVENUE_WINDOW_DAYS. That vocabulary is a
 * menu a caller picks from; this is a fixed property of two attribution
 * surfaces, and giving them a `?window=` they cannot honour would publish a
 * lever that does nothing -- the exact defect #10925 exists to remove.
 */
export const ATTRIBUTION_WINDOW_DAYS = 30;
