// Per-route `limit` page-size ceilings, in one place (#9127).
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

/** `/api/v1/subnets/movers` -- cross-subnet momentum leaderboard. */
export const MOVERS_LIMIT_DEFAULT = 20;
export const MOVERS_LIMIT_MAX = 100;

/** `/api/v1/chain/turnover` -- network-wide turnover leaderboard. */
export const CHAIN_TURNOVER_LIMIT_DEFAULT = 20;
export const CHAIN_TURNOVER_LIMIT_MAX = 100;

/** `/api/v1/accounts/top-holders` -- balance-based top-holder leaderboard. */
export const TOP_HOLDERS_LIMIT_DEFAULT = 20;
export const TOP_HOLDERS_LIMIT_MAX = 100;

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
