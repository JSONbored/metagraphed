// What every route accepts as a query parameter, in ONE place (#10062).
//
// Part of the epic that collapses MCP, REST and GraphQL onto one schema layer
// (#10060). Until this file, a single parameter was described in up to four
// places: the literal at the `route()` call in `src/contracts.ts`, the shared
// description keyed by NAME, the route's prose, and a `*QuerySchema` export in
// `schemas-src/routes/` that nothing imported. 142 of those 143 exports were
// dead code -- and dead code that disagreed: measured on emitted JSON, 51 of
// the 88 routes that had one published something its schema did not say.
//
// ── What this is FOR ───────────────────────────────────────────────────────
//
// It is not published yet. 3/5 (#10063) makes `route()` emit its parameters
// from here and deletes the literals, and 4/5 (#10064) derives the MCP tool
// inputs from the same objects. The whole value of this step is that the flip
// is then provably a NO-OP: `validate:route-query-parity` asserts, for every
// route, that this file emits exactly what the route publishes today, so
// `openapi.json` stays byte-identical when the source of truth moves.
//
// Correcting the contract is deliberately NOT part of this step. Two sources
// existing is what let them drift; changing what they say while both are still
// alive is how it happened the first time. The `DIVERGENCE` markers below are
// the checklist for that pass, and they are here rather than in a tracking
// document because this is where someone will be standing when it matters.
//
// ── Keyed by path, matching MCP_TOOL_ROUTES ────────────────────────────────
//
// `src/mcp-route-map.ts` already declares which route each MCP tool mirrors,
// keyed by the plain (non-network-prefixed) path. Using the same key means 4/5
// is a lookup rather than a second mapping to keep in step. The 42
// `/api/v1/{network}/…` forms are the same handlers behind a prefix and are
// deliberately absent, exactly as they are there.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// COLLECTION ROUTES. The 34 list routes generate their 9-18 parameters from
// `API_QUERY_COLLECTIONS`, and `listQuerySchema()` (#10080) already composes
// the matching Zod from the same config. A hand-written copy would be a second
// declaration of a computed thing -- the exact failure this file removes a
// layer of. `querySchemaForRoute()` in `src/contracts.ts` resolves a route to
// whichever producer owns it; the gate proves the union covers every route.
//
// DESCRIPTIONS. This file states CONSTRAINTS. A parameter's prose is per-route
// (it names what the rows are) and still lives with the route, so the gate
// compares schema objects with `description` stripped. Unifying the prose is a
// later step and a different judgement -- not an oversight here.
//
// STRICTNESS. These objects are deliberately NOT `.strict()` yet, and that is a
// decision rather than a default. `.strict()` is what makes an unknown argument
// a parse error, which is exactly what 5/5's `safeParse` needs -- but the
// runtime accepts `format` on EVERY route whether it declares one or not
// (`GLOBALLY_ACCEPTED_PARAMS`, a documented judgement that exists so
// /chain-events/stats can keep ignoring it). A blanket `.strict()` here would
// assert a rejection the server does not perform, on 118 routes. Choosing per
// route needs the runtime's answer for each, which is 5/5's work, not a default
// worth guessing now. The gate compares `properties`, so this does not affect
// what 3/5 publishes either way.
import { z } from "zod";
import { QUERY_ENUMS } from "./query-enums.ts";
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
  ANALYTICS_WINDOWS,
  BULK_HEALTH_TRENDS_LIMIT_MAX,
  CHAIN_CONCENTRATION_HISTORY_WINDOWS,
  DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  CHAIN_CALL_MODULE_MAX_LENGTH,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
  CHAIN_EVENTS_LIMIT_DEFAULT,
  CHAIN_EVENTS_LIMIT_MAX,
  CHAIN_EVENT_NAME_MAX_LENGTH,
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_TURNOVER_LIMIT_DEFAULT,
  CHAIN_TURNOVER_LIMIT_MAX,
  EMISSION_CHANGES_LIMIT_DEFAULT,
  EMISSION_CHANGES_LIMIT_MAX,
  EMISSION_PIPELINE_LIMIT_MAX,
  FAILURE_REASONS_WINDOWS,
  FEED_LIMIT_MAX,
  FEED_WATCH_IDS_MAX_LENGTH,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  HISTORY_WINDOWS,
  LEADERBOARDS_LIMIT_DEFAULT,
  LEADERBOARDS_LIMIT_MAX,
  MOVERS_LIMIT_DEFAULT,
  MOVERS_LIMIT_MAX,
  PIPELINE_HISTORY_WINDOWS,
  SEMANTIC_LIMIT_DEFAULT,
  SEMANTIC_LIMIT_MAX,
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_TYPES,
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOWS,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  UPTIME_WINDOWS,
  SUBNET_HOLDERS_LIMIT_DEFAULT,
  SUBNET_HOLDERS_LIMIT_MAX,
  SURFACE_HISTORY_LIMIT_DEFAULT,
  SURFACE_HISTORY_LIMIT_MAX,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
  VALIDATOR_ECONOMICS_LIMIT_DEFAULT,
  VALIDATOR_ECONOMICS_LIMIT_MAX,
} from "../src/route-limits.ts";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  MAX_LIMIT,
} from "../workers/request-params.ts";
import {
  CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
  CHAIN_ALPHA_VOLUME_LIMIT_MAX,
} from "../src/chain-alpha-volume.ts";
import {
  CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
} from "../src/chain-axon-removals.ts";
import {
  CHAIN_CALLS_LIMIT_DEFAULT,
  CHAIN_CALLS_LIMIT_MAX,
} from "../src/chain-calls-artifact.ts";
import {
  CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_DEREGISTRATIONS_LIMIT_MAX,
} from "../src/chain-deregistrations.ts";
import {
  CHAIN_SUBNET_LIFECYCLE_LIMIT_DEFAULT,
  CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX,
} from "../src/subnet-lifecycle-read.ts";
import { CHAIN_EVENTS_STATS_BLOCKS_MAX } from "../src/chain-events-cold-tier.ts";
import {
  CHAIN_FEES_LIMIT_DEFAULT,
  CHAIN_FEES_LIMIT_MAX,
} from "../src/chain-fees-artifact.ts";
import {
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
  CHAIN_PROMETHEUS_LIMIT_MAX,
} from "../src/chain-prometheus.ts";
import {
  CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_REGISTRATIONS_LIMIT_MAX,
} from "../src/chain-registrations.ts";
import {
  CHAIN_SERVING_LIMIT_DEFAULT,
  CHAIN_SERVING_LIMIT_MAX,
} from "../src/chain-serving.ts";
import {
  CHAIN_SIGNERS_LIMIT_DEFAULT,
  CHAIN_SIGNERS_LIMIT_MAX,
} from "../src/chain-signers-artifact.ts";
import {
  CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
  CHAIN_STAKE_FLOW_LIMIT_MAX,
} from "../src/chain-stake-flow.ts";
import {
  CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
  CHAIN_STAKE_MOVES_LIMIT_MAX,
} from "../src/chain-stake-moves.ts";
import {
  CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
  CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
} from "../src/chain-stake-transfers.ts";
import {
  CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
  CHAIN_TRANSFER_PAIR_LIMIT_MAX,
} from "../src/chain-transfer-pairs.ts";
import {
  CHAIN_TRANSFER_LIMIT_DEFAULT,
  CHAIN_TRANSFER_LIMIT_MAX,
} from "../src/chain-transfers.ts";
import {
  CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
} from "../src/chain-weight-setters.ts";
import {
  CHAIN_WEIGHTS_LIMIT_DEFAULT,
  CHAIN_WEIGHTS_LIMIT_MAX,
} from "../src/chain-weights.ts";
import {
  COUNTERPARTIES_LIMIT_DEFAULT,
  COUNTERPARTIES_LIMIT_MAX,
} from "../src/counterparties.ts";
import {
  DEFAULT_OHLC_WINDOW_DAYS,
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
  OHLC_INTERVAL_DEFAULT,
} from "../src/subnet-ohlc.ts";
import {
  DEFAULT_NOMINATOR_BASIS,
  NOMINATOR_BASES,
} from "../src/validator-nominator-positions.ts";
import { TOP_HOLDERS_SORTS } from "../src/top-holders.ts";
import { NOMINATOR_LIMIT_DEFAULT } from "../src/validator-nominators.ts";
import { VALIDATOR_ECONOMICS_SORTS } from "../src/validator-economics.ts";
import {
  blockBoundSchema,
  observedAtBoundSchema,
  daySchema,
  directionSchema,
  fieldsSchema,
  filterTokenSchema,
  keysetCursorSchema,
  formatSchema,
  kindSchema,
  kindStringSchema,
  limitSchema,
  netuidListSchema,
  netuidSchema,
  offsetSchema,
  orderSchema,
  feedInstantSchema,
  querySchema,
  sectionsSchema,
  SERVING_BOUND,
  sortSchema,
  stakeActionSchema,
  ss58Schema,
  windowSchema,
} from "./query-params.ts";

/**
 * `offset` on the two routes that genuinely enforce NO ceiling.
 *
 * Everything else clamps at MAX_OFFSET via `clampOffset`/`parsePagination` and
 * publishes `offsetSchema()` for it. These two read the parameter with
 * `parseNonNegativeIntParam`, which applies no upper bound at all, so
 * publishing one would claim a limit the handler does not impose.
 *
 * Told apart by probe rather than by reading, because the two paths are
 * indistinguishable from a normal request: a non-safe integer
 * (`?offset=99999999999999999999`) is a 400 from parseNonNegativeIntParam and
 * a clamp-to-empty 200 from clampOffset. Measured 2026-08-08 -- these two
 * answered 400, the other 14 answered 200 with zero rows, which is the clamp
 * honouring the parameter rather than ignoring it (`?offset=0` returns rows).
 *
 * #10096 originally recorded all 16 as one divergence. They are not: two of
 * them are correct, and publishing MAX_OFFSET on those would have been a new
 * contract lie rather than a fix.
 */
// `default: 0` for the same reason offsetSchema() carries one (#10060):
// omitting the parameter starts at row 0, and a caller could not read that
// anywhere machine-readable.
// A page offset with no deep-paging ceiling of its own. Still a SERVING bound
// -- it is a page position, so a surface that clamps page bounds clamps this
// one too (#10316); it just has nothing to clamp the top of.
const unboundedOffsetSchema = () =>
  z
    .int()
    .min(0)
    .meta({ [SERVING_BOUND]: true, default: 0 });

/**
 * Routes that accept no query parameters at all.
 *
 * Listed rather than left to fall out of the map's absence: "declares nothing"
 * and "nobody wrote it down" are different claims, and only one of them should
 * survive a route quietly losing its parameters. The gate reads this list, so
 * a new route must appear in one place or the other.
 */
export const NO_QUERY_PARAMETERS: readonly string[] = [
  "/api/v1",
  // #10285. Declaring nothing here is NOT the same as taking no parameters:
  // querySchemaForRoute returns null for a route absent from this list, and a
  // null schema means the router validates nothing at all -- so the route
  // would silently ACCEPT any query string instead of rejecting it.
  "/api/v1/chain/deregistration-ranking",
  "/api/v1/subnets/{netuid}/overview",
  "/api/v1/agent-catalog/{netuid}",
  "/api/v1/providers/{slug}",
  "/api/v1/coverage",
  "/api/v1/ask",
  "/api/v1/webhooks/subscriptions/{id}",
  "/api/v1/alerts/triggers/{id}",
  "/api/v1/surfaces/{surface_id}/verify",
  "/api/v1/registry/summary",
  "/api/v1/lineage",
  "/api/v1/fixtures/{surface_id}",
  "/api/v1/agent-resources",
  "/api/v1/subnets/{netuid}/health/trends",
  "/api/v1/subnets/{netuid}/concentration",
  "/api/v1/subnets/{netuid}/performance",
  "/api/v1/subnets/{netuid}/idle-stake",
  "/api/v1/subnets/{netuid}/volume",
  "/api/v1/subnets/{netuid}/validator-economics",
  "/api/v1/validators/{hotkey}",
  "/api/v1/subnets/{netuid}/hyperparameters",
  "/api/v1/accounts/{ss58}",
  "/api/v1/accounts/{ss58}/entities",
  "/api/v1/accounts/{ss58}/subnets",
  "/api/v1/accounts/{ss58}/portfolio",
  "/api/v1/accounts/{ss58}/positions",
  "/api/v1/accounts/{ss58}/identity",
  "/api/v1/accounts/{ss58}/balance",
  "/api/v1/accounts/{ss58}/root-claim",
  "/api/v1/accounts/{ss58}/children",
  "/api/v1/accounts/{ss58}/parents",
  "/api/v1/evm/address/{h160}",
  "/api/v1/sudo/key",
  "/api/v1/network/parameters",
  "/api/v1/network/randomness",
  "/api/v1/subnets/{netuid}/recycled",
  // #10447: both revenue routes take no query parameters. The window is
  // fixed at one day for now -- a ?window= that silently changed the
  // denominator would make two callers quoting "the" ratio mean different
  // things, so it waits until the series exists to make it meaningful.
  "/api/v1/subnets/{netuid}/revenue",
  // #10488: both wallet routes take no query parameters. The window is fixed
  // by the loader, so an accepted-but-ignored ?window= would be worse than a
  // 400 -- the caller would believe it narrowed something.
  "/api/v1/subnets/{netuid}/wallets",
  "/api/v1/subnets/{netuid}/owner-cut",
  "/api/v1/chain/revenue-coverage",
  "/api/v1/subnets/{netuid}/burn",
  "/api/v1/chain/indexer-lag",
  "/api/v1/chain/burn",
  "/api/v1/subnets/{netuid}/ownership-history",
  "/api/v1/subnets/{netuid}/conviction",
  "/api/v1/subnets/{netuid}/lease",
  "/api/v1/crowdloans",
  "/api/v1/crowdloans/{crowdloan_id}",
  "/api/v1/subnets/{netuid}/lease/history",
  "/api/v1/blocks/summary",
  "/api/v1/blocks/{ref}",
  "/api/v1/blocks/{ref}/chain-events",
  "/api/v1/extrinsics/{hash}",
  "/api/v1/networks",
  "/api/v1/chain/concentration",
  "/api/v1/chain/performance",
  "/api/v1/chain/idle-stake",
  "/api/v1/self-health",
  "/api/v1/chain/yield",
  "/api/v1/domains",
  "/api/v1/domains/{tag}/summary",
  "/api/v1/freshness",
  "/api/v1/source-health",
  "/api/v1/changelog",
  "/api/v1/schemas",
  "/api/v1/adapters/{slug}",
  "/api/v1/openapi.json",
  "/api/v1/build",
];

/**
 * Every non-collection route's query parameters, as Zod.
 *
 * Composed from `schemas-src/query-params.ts` wherever the parameter is a
 * shared one (242 of 286 are), and stated inline where the values are genuinely
 * this route's own -- a `board` enum, a `lens`, a call hash pattern. The split
 * is the point: a shared parameter cannot be given a second definition here,
 * and a route-specific one is not forced into a vocabulary it does not belong
 * to.
 */
/**
 * The literal-keyed map is the point: `Record<string, z.ZodObject>` erased the
 * per-route type, so a consumer indexing it got a generic object and could not
 * `z.infer<>` the real shape. `satisfies` keeps the annotation's guarantee
 * (every value is a ZodObject) while preserving each key's own type, which is
 * what lets schemas-src/mcp-tools/* build a tool input FROM its route instead
 * of restating it (#10064).
 */
/**
 * What every feed family accepts (#10218).
 *
 * The feed routes live in their own table (`FEED_ROUTES`), and their
 * parameters were the one set still written as raw JSON Schema -- the second
 * vocabulary #10073 deleted everywhere else, surviving because it was in a
 * different array. What that cost: all 24 published feed paths declare
 * `limit` maximum 50 and nothing enforced it, so `?limit=51` answered 200.
 *
 * `since`/`until` carry no PATTERN, for the reason they never did: `src/feeds.ts`
 * accepts a whole UTC day OR an offset-bearing date-time and rejects a malformed
 * one with a message naming which, and a published regex would make the router's
 * derived message preempt that better one on all 24 paths.
 *
 * They no longer publish NOTHING, though (#10219). `feedInstantSchema` states the
 * two accepted forms, which end of the day a bare date resolves to, and the
 * ordering between the pair -- the three things a caller cannot infer and the
 * handler was never going to tell them in advance.
 */
export const FEED_QUERY_SCHEMAS = {
  common: z.object({
    tag: filterTokenSchema().optional(),
    since: feedInstantSchema("first").optional(),
    until: feedInstantSchema("last").optional(),
    limit: limitSchema(FEED_LIMIT_MAX, FEED_LIMIT_MAX).optional(),
  }),
  /** `/api/v1/feeds/watch` -- the URL-carried watchlist. */
  ids: z.string().max(FEED_WATCH_IDS_MAX_LENGTH).optional(),
  /** `/api/v1/feeds/subnets/{netuid}` -- the path parameter, echoed as a filter. */
  netuid: netuidSchema().optional(),
} as const;

export const ROUTE_QUERY_SCHEMAS = {
  // #10600: the two composite subnet routes. They took NO parameters until
  // now -- not for want of size (272,825 B and 202,948 B) but because the
  // ordinary lever does not fit: a query collection pages ONE data_key, and
  // their bulk is four parallel arrays over the same subject, so paging one
  // would narrow a quarter of the payload and leave the rest.
  //
  // `sections` rather than `fields`, decided on #10600: `fields` means "pick
  // columns out of the rows of a list" on all five routes that carry it, and
  // its published description says so. One name with two units of selection
  // would give a caller a different KIND of answer with nothing telling them.
  "/api/v1/subnets/{netuid}": z.object({
    sections: sectionsSchema(QUERY_ENUMS.subnetDetailSection).optional(),
  }),
  "/api/v1/subnets/{netuid}/profile": z.object({
    sections: sectionsSchema(QUERY_ENUMS.subnetProfileSection).optional(),
  }),
  "/api/v1/search/semantic": z.object({
    // Both were wrong before #10075: `q` published no ceiling though the
    // handler rejects one over SEMANTIC_QUERY_MAX_LENGTH, and `limit`
    // published `{"type":"string"}` for a value the handler reads as an
    // integer and clamps -- so a client generated from this spec sent a
    // string where an integer was wanted, with no way to learn either bound.
    // The bounds come FROM src/route-limits.ts rather than being restated
    // here -- that module is the owner, and schemas-src/mcp-tools/ has read it
    // directly since #9127.
    q: querySchema(SEMANTIC_QUERY_MAX_LENGTH).optional(),
    limit: limitSchema(SEMANTIC_LIMIT_MAX, SEMANTIC_LIMIT_DEFAULT).optional(),
    // #10065: the handler has scoped on this since semantic search shipped --
    // it filters the results and rejects an unknown value by name ("Unknown
    // type `bogus`. Valid types: subnet, surface, provider", verified live) --
    // and the contract never mentioned it. The vocabulary comes FROM
    // src/ai-search.ts rather than being restated, so the two cannot drift.
    type: z.enum(SEMANTIC_TYPES).optional(),
  }),
  "/api/v1/chain/emission-pipeline": z.object({
    netuid: netuidSchema().optional(),
    sort: sortSchema([
      "final_share",
      "emission_share",
      "weighted_share",
      "gated_share",
      "gate_delta",
      "distance_to_bar",
      "tao_in_emission",
      "excess_tao",
      "tao_total",
      "liquidity_fraction",
      "miner_burned",
      "netuid",
    ] as const).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(EMISSION_PIPELINE_LIMIT_MAX).optional(),
    fields: fieldsSchema().optional(),
  }),
  "/api/v1/economics/trends": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/health/trends": z.object({
    // Integers, not strings (#10089). handleBulkHealthTrends runs
    // parseLimitParam / parseNonNegativeIntParam, so `?limit=abc` has always
    // been a 400 -- the published `{"type":"string"}` said otherwise. `offset`
    // carries no ceiling because the handler enforces none.
    // The one windowed route with NO default, and deliberately (#10060): this
    // route answers EVERY window at once and `?window=` narrows to one.
    // Verified live -- bare, `windows` carries `7d` and `30d`; `?window=7d`
    // carries only `7d`. Publishing a default here would describe a narrowing
    // the server does not perform.
    window: windowSchema(ANALYTICS_WINDOWS as [string, ...string[]]).optional(),
    limit: limitSchema(BULK_HEALTH_TRENDS_LIMIT_MAX).optional(),
    offset: unboundedOffsetSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/health/percentiles": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/health/incidents": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/performance/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/concentration/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/turnover": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
    // The same boolean-as-string filter `validator_permit` is on
    // /subnets/{netuid}/metagraph, and published the same way: both values,
    // because the handler reads `=== "true"` and `changes=false` therefore
    // MEANS something -- "no change filter". Publishing only `true` said the
    // other half of a boolean was an error, which nothing enforced until
    // #10218 started parsing with this object and turned the claim into a 400.
    changes: z.enum(["true", "false"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/weights": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/weights/setters": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/serving": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/prometheus": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-transfers": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-moves": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/registrations": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/axon-removals": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/deregistrations": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-flow": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    direction: directionSchema(["all", "in", "out"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/ohlc": z.object({
    interval: z
      .enum(["1h", "1d"] as const)
      .meta({ default: OHLC_INTERVAL_DEFAULT })
      .optional(),
    days: z
      .int()
      .min(1)
      .max(MAX_OHLC_WINDOW_DAYS)
      .meta({ default: DEFAULT_OHLC_WINDOW_DAYS })
      .optional(),
    // The candle ceiling, published (#9981/#10318). MAX_CANDLES has capped
    // this response at 2,000 since it shipped, and a caller had no way to ask
    // for fewer and no way to learn the cap existed -- 1h over the default 90
    // days is 486 KB and 13.5 s, the largest and slowest thing this API
    // serves. The DEFAULT is the cap, so today's answer is unchanged for
    // every existing consumer; what is new is the lever.
    limit: limitSchema(MAX_CANDLES, MAX_CANDLES).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-quote": z.object({
    // THE ONLY REQUIRED QUERY PARAMETER ON THE API (#10401).
    //
    // It was `.optional()` while the handler rejected every request without it,
    // so the contract published a possibility that could not be exercised --
    // the divergence #10214's generator found by comparing this against
    // GraphQL's honest `amount: Float!`.
    //
    // Being the first required one is not incidental: src/route-query.ts's
    // violation reporting was written when every field was optional, and its
    // "the failing key is always one the caller supplied" invariant does not
    // survive a required field being ABSENT. That path is fixed and tested
    // alongside this change rather than left to be discovered.
    amount: z.number().gt(0),
    direction: stakeActionSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/validator-economics/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/validators/economics": z.object({
    // Was the only `sort` on the surface published without an enum, while the
    // handler has a closed set and says so in its own 400 ("Supported:
    // earning_floor_cost_tao, ..."). A caller had to guess a column name, and
    // every wrong guess was a rejected request the contract gave no way to
    // avoid (#10096). Read from VALIDATOR_ECONOMICS_SORTS, the module that
    // owns it, not a fourth copy.
    sort: sortSchema(
      VALIDATOR_ECONOMICS_SORTS as unknown as [string, ...string[]],
      "earning_floor_cost_tao",
    ).optional(),
    limit: limitSchema(
      VALIDATOR_ECONOMICS_LIMIT_MAX,
      VALIDATOR_ECONOMICS_LIMIT_DEFAULT,
    ).optional(),
    // Bounded by the ranking's own ceiling, not the generic deep-paging one:
    // one row per subnet, so seeking past the limit seeks nothing.
    offset: z
      .int()
      .min(0)
      .max(VALIDATOR_ECONOMICS_LIMIT_MAX)
      .meta({ [SERVING_BOUND]: true })
      .optional(),
    emission_gate_open: z.boolean().optional(),
    cap_binding: z.boolean().optional(),
  }),
  "/api/v1/subnets/movers": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    sort: sortSchema(
      ["stake", "emission", "validators", "neurons"] as const,
      "stake",
    ).optional(),
    limit: limitSchema(MOVERS_LIMIT_MAX, MOVERS_LIMIT_DEFAULT).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/validators": z.object({
    sort: sortSchema(
      [
        "avg_validator_trust",
        "max_validator_trust",
        "stake_dominance",
        "subnet_count",
        "total_emission",
        "total_stake",
        "uid_count",
      ] as const,
      "subnet_count",
    ).optional(),
    limit: limitSchema(
      GLOBAL_VALIDATOR_LIMIT_MAX,
      GLOBAL_VALIDATOR_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts": z.object({
    sort: sortSchema(
      [
        "total_stake",
        "total_emission",
        "subnet_count",
        "uid_count",
        "validator_count",
        "stake_dominance",
        "last_active",
      ] as const,
      "total_stake",
    ).optional(),
    limit: limitSchema(
      ACCOUNTS_LIST_LIMIT_MAX,
      ACCOUNTS_LIST_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/top-holders": z.object({
    // `sort` is TOP_HOLDERS_SORTS, not a copy of it. The copy that used to sit
    // in contracts.ts listed the three HOLDINGS sorts and omitted
    // net_flow_7d/30d/90d (#10089) -- so the published enum offered exactly
    // the three that DECLINE to a fixed 2026-08-02 materialization when their
    // producer's last pass is unproven, and withheld the three that are
    // recomputed daily. The route's own 400 has always named all six.
    // The enum IS TOP_HOLDERS_SORTS, read from the module that owns it.
    sort: sortSchema(
      TOP_HOLDERS_SORTS as [string, ...string[]],
      "total_tao",
    ).optional(),
    limit: limitSchema(
      TOP_HOLDERS_LIMIT_MAX,
      TOP_HOLDERS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/validators/{hotkey}/nominators": z.object({
    // Described here rather than on the MCP tool, so BOTH surfaces carry the
    // sentence -- REST published this parameter with no prose at all, and the
    // one thing a caller cannot guess about it is that the two values answer
    // different questions rather than the same one better or worse (#10793).
    basis: z
      .enum(NOMINATOR_BASES)
      .describe(
        "Which question to answer. `flow` (the default) sums TAO MOVED inside " +
          "`window`, so a delegator who staked earlier and has not touched it " +
          "since is absent. `positions` reads the standing ledger instead: " +
          // "coldkey (an ss58 address)" rather than a bare one, matching this
          // route's existing description and scan-public-safety's explanatory-
          // parenthetical exemption: an ss58 coldkey is public on-chain data,
          // and the scan's job is to catch prose that treats it as a secret.
          "every coldkey (an ss58 address) delegating right now and how much " +
          "alpha each holds " +
          "per subnet, whenever they staked. Different units over different " +
          "time semantics, so the two are not comparable. On `positions`, " +
          "`window` and `sort` are REJECTED rather than ignored.",
      )
      .meta({ default: DEFAULT_NOMINATOR_BASIS, examples: ["positions"] })
      .optional(),
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    sort: sortSchema(
      ["net_staked", "gross_staked", "last_activity"] as const,
      "net_staked",
    ).optional(),
    // PUBLISHED 100 while the route enforced 2000 (#10064 sweep). Three
    // statements disagreed: this contract and the cold-tier builder said
    // NOMINATOR_LIMIT_MAX (100), handleValidatorNominators validated against
    // GLOBAL_VALIDATOR_LIMIT_MAX (2000), and production serves 2000 --
    // verified live, `?limit=2000` returns 2000 rows and `?limit=2001` is the
    // 400. A caller reading the contract made 20 requests where one would do.
    //
    // Declared as what the route ENFORCES rather than narrowing the route,
    // because narrowing would 400 callers who are being served today. The
    // cold-tier builder still clamps at NOMINATOR_LIMIT_MAX, so a fallback
    // page is shorter than this ceiling; that is a tier difference, not a
    // second contract.
    limit: limitSchema(
      GLOBAL_VALIDATOR_LIMIT_MAX,
      NOMINATOR_LIMIT_DEFAULT,
    ).optional(),
    offset: unboundedOffsetSchema().optional(),
    // The handler DOES validate this -- `?coldkey=notanaddress` is a 400,
    // verified live -- and the contract simply did not say so, while
    // ss58Schema() carries the same 47-48 base58 pattern on 26 other
    // parameters (#10096). Publishing it costs no behaviour change and lets a
    // generated client catch a typo before the request.
    //
    // NOT done for `author` on /blocks or `signer` on /extrinsics: both answer
    // 200 to a malformed address and filter to nothing, so publishing the
    // pattern there would claim validation the server does not perform --
    // the #10073 mistake inverted. Making THEM reject is a behaviour change
    // and needs its own decision.
    coldkey: ss58Schema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/validators/{hotkey}/history": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
    // #9383 added this to the handler's allowlist, the MCP tool and the
    // GraphQL field, and the response echoes it back as `data.netuid` -- but
    // it was never declared, so openapi.json told every generated client that
    // passing it was an error. Verified live before declaring: the scoped and
    // unscoped series differ (#10065).
    netuid: netuidSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/metagraph": z.object({
    // A PRESENCE flag, one value. #10096 and #10218 landed in the same window
    // and disagreed: #10096 made the handler 400 anything but `true`, and
    // #10218 published both values on the belief that `false` still meant "the
    // unfiltered metagraph". The server settles it -- verified live 2026-08-09,
    // `?validator_permit=false` is a 400 and `=true` a 200 -- so the published
    // enum was the half that was wrong, and a generated client was being told
    // to send a value the route refuses.
    //
    // Declared as what the route ENFORCES, and #10096's reasoning is why that
    // is the right half to keep: `=false` reads as "the ones WITHOUT a permit",
    // and answering it with all 256 rows is the silent wrong answer. A caller
    // who wants the complement omits the parameter and filters the rows.
    validator_permit: z.enum(["true"] as const).optional(),
    fields: fieldsSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/neurons/{uid}": z.object({
    fields: fieldsSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/hyperparameters/history": z.object({
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  // No `cursor`: the sibling above pages a table that grows per subnet per
  // change, this one a table that grows per subnet per LIFETIME. Publishing a
  // keyset token here would advertise resumability the loader does not provide.
  "/api/v1/subnets/{netuid}/lifecycle": z.object({
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/validators": z.object({
    fields: fieldsSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/yield": z.object({
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/yield/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/emission-split/history": z.object({
    window: windowSchema(
      SUBNET_EMISSION_SPLIT_HISTORY_WINDOWS as [string, ...string[]],
      DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/events": z.object({
    kind: kindStringSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    // The handler has always accepted and forwarded this, and the sibling
    // /accounts/{ss58}/events feed publishes it -- but this route did not, so
    // the contract said passing it was an error while the route paged on it.
    // Found by sweeping all 202 GET routes through the real router (#10065).
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/event-summary": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    limit: limitSchema(
      SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
      SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/neurons/{uid}/history": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/history": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/identity-history": z.object({
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/events": z.object({
    kind: kindStringSchema().optional(),
    netuid: netuidSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/history": z.object({
    netuid: netuidSchema().optional(),
    from: daySchema("first").optional(),
    to: daySchema("last").optional(),
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    // handleAccountHistory forwards this to loadAccountHistoryColdTier and has
    // since #9315; only the contract left it out (#10065).
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/extrinsics": z.object({
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/transfers": z.object({
    direction: directionSchema(["all", "sent", "received"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/counterparties": z.object({
    counterparty: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/)
      .optional(),
    limit: limitSchema(
      COUNTERPARTIES_LIMIT_MAX,
      COUNTERPARTIES_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/stake-flow": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    direction: directionSchema(["all", "in", "out"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/stake-moves": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/accounts/{ss58}/deregistrations": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/accounts/{ss58}/prometheus": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/accounts/{ss58}/axon-removals": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/accounts/{ss58}/serving": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/accounts/{ss58}/weight-setters": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
  "/api/v1/accounts/{ss58}/registrations": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
  }),
  "/api/v1/accounts/{ss58}/subnets/{netuid}/history": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
  }),
  "/api/v1/accounts/{ss58}/identity-history": z.object({
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/network/tao-usd": z.object({
    window: windowSchema(["1h", "24h", "7d", "30d"] as const, "24h").optional(),
    include_points: z.boolean().optional(),
  }),
  "/api/v1/subnets/{netuid}/burn/history": z.object({
    window: windowSchema(["24h", "7d", "30d", "90d"] as const, "7d").optional(),
  }),
  "/api/v1/subnets/{netuid}/holders": z.object({
    limit: limitSchema(
      SUBNET_HOLDERS_LIMIT_MAX,
      SUBNET_HOLDERS_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/surface-history": z.object({
    limit: limitSchema(
      SURFACE_HISTORY_LIMIT_MAX,
      SURFACE_HISTORY_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/chain/governance/emission-changes": z.object({
    kind: kindSchema(["param", "subnet", "flow"] as const).optional(),
    limit: limitSchema(
      EMISSION_CHANGES_LIMIT_MAX,
      EMISSION_CHANGES_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/chain/holders": z.object({
    sort: sortSchema(
      [
        "top1_share",
        "top5_share",
        "top10_share",
        "top20_share",
        "holder_count",
        "total_alpha",
      ] as const,
      "top1_share",
    ).optional(),
    limit: limitSchema(
      CHAIN_HOLDERS_LIMIT_MAX,
      CHAIN_HOLDERS_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/health/failure-reasons": z.object({
    window: windowSchema(
      FAILURE_REASONS_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
    netuid: netuidSchema().optional(),
    kind: kindStringSchema().optional(),
  }),
  "/api/v1/search/resolve": z.object({
    // NOT a divergence, recorded so the next sweep does not file one. `q` is
    // unbounded on purpose: this route recognises an identifier by SHAPE and
    // returns an empty `matches` for anything else, so a long string is
    // answered rather than rejected. Verified live -- 512 characters is a 200
    // with `matches: []`.
    q: z.string().optional(),
  }),
  "/api/v1/chain/concentration/history": z.object({
    window: windowSchema(
      CHAIN_CONCENTRATION_HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/emission-pipeline/history": z.object({
    window: windowSchema(
      PIPELINE_HISTORY_WINDOWS as [string, ...string[]],
      "30d",
    ).optional(),
  }),
  "/api/v1/blocks": z.object({
    limit: limitSchema(
      BLOCK_PAGINATION.maxLimit,
      BLOCK_PAGINATION.defaultLimit,
    ).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    // DIVERGENCE: the block author is an SS58 and publishes no pattern.
    author: z.string().optional(),
    spec_version: z.int().min(0).optional(),
    from: observedAtBoundSchema("first").optional(),
    to: observedAtBoundSchema("last").optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    min_extrinsics: z.int().min(0).optional(),
    min_events: z.int().min(0).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/blocks/{ref}/extrinsics": z.object({
    limit: limitSchema(
      BLOCK_PAGINATION.maxLimit,
      BLOCK_PAGINATION.defaultLimit,
    ).optional(),
    offset: offsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/blocks/{ref}/events": z.object({
    limit: limitSchema(MAX_LIMIT, FEED_PAGINATION.defaultLimit).optional(),
    offset: offsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain-events": z.object({
    pallet: z.string().max(CHAIN_EVENT_NAME_MAX_LENGTH).optional(),
    method: z.string().max(CHAIN_EVENT_NAME_MAX_LENGTH).optional(),
    block: blockBoundSchema("first").optional(),
    extrinsic: z.int().min(0).optional(),
    // OPAQUE, like the twelve sibling feeds -- and this is a live bug fix, not
    // a tidy-up (#10316). The hand-written `^\d+\.\d+$` here published a
    // TWO-part cursor while `chain-events-cold-tier.ts` decodes THREE
    // (`CURSOR_ARITY = 3`, observed_at.block_number.event_index), so the route
    // rejected the only cursor that works and accepted one it ignores.
    // Verified against production 2026-08-09:
    //
    //   GET /api/v1/chain-events?limit=1
    //     -> next_cursor "1786310148001.8809458.214"
    //   GET /api/v1/chain-events?limit=1&cursor=1786310148001.8809458.214
    //     -> 400 invalid_query, "cursor must match ^\d+\.\d+$."
    //
    // Following the route's own `next_cursor` -- the documented way to page --
    // was a 400. The cold tier already treats an unusable cursor as inert
    // rather than an error (see its own comment), so an opaque token is what
    // this route has always actually accepted.
    cursor: keysetCursorSchema().optional(),
    before: blockBoundSchema("first").optional(),
    // Resolved (#10109): this published 200 while the serving path clamped at
    // 100, because TWO constants carried the name CHAIN_EVENTS_LIMIT_MAX with
    // different values and the contract was written from the one the request
    // path does not use. One constant now, in src/route-limits.ts, and it is
    // the number the route enforces.
    limit: limitSchema(
      CHAIN_EVENTS_LIMIT_MAX,
      CHAIN_EVENTS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain-events/stats": z.object({
    // A WINDOW SIZE, so its ceiling is a serving policy like `limit`'s and
    // bends the same way -- `blocks: 99999` answers over the newest 5000
    // rather than refusing (#10316).
    blocks: z
      .int()
      .min(1)
      .max(CHAIN_EVENTS_STATS_BLOCKS_MAX)
      .meta({ [SERVING_BOUND]: true })
      .optional(),
  }),
  "/api/v1/extrinsics": z.object({
    limit: limitSchema(
      BLOCK_PAGINATION.maxLimit,
      BLOCK_PAGINATION.defaultLimit,
    ).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    block: blockBoundSchema("first").optional(),
    // DIVERGENCE: see `coldkey` on /validators/{hotkey}/nominators -- an SS58
    // published without the shared pattern.
    signer: z.string().optional(),
    // The same cap its three sibling feeds enforce (#10096). This took the
    // identical filter with no bound at all, so a 150-character value was a
    // 400 on /chain/calls and a 200 here -- handleExtrinsics now applies
    // validateMaxLength, so the number is published because it is enforced.
    call_module: z.string().max(CHAIN_CALL_MODULE_MAX_LENGTH).optional(),
    call_function: z.string().optional(),
    call_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    success: z.enum(["true", "false"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: observedAtBoundSchema("first").optional(),
    to: observedAtBoundSchema("last").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/sudo": z.object({
    limit: limitSchema(
      BLOCK_PAGINATION.maxLimit,
      BLOCK_PAGINATION.defaultLimit,
    ).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    block: blockBoundSchema("first").optional(),
    call_function: z.string().optional(),
    success: z.enum(["true", "false"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: observedAtBoundSchema("first").optional(),
    to: observedAtBoundSchema("last").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/governance/config-changes": z.object({
    limit: limitSchema(
      BLOCK_PAGINATION.maxLimit,
      BLOCK_PAGINATION.defaultLimit,
    ).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    block: blockBoundSchema("first").optional(),
    call_function: z.string().optional(),
    success: z.enum(["true", "false"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: observedAtBoundSchema("first").optional(),
    to: observedAtBoundSchema("last").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/runtime": z.object({
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/activity": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/calls": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    group_by: z.enum(["module", "module_function"] as const).optional(),
    limit: limitSchema(
      CHAIN_CALLS_LIMIT_MAX,
      CHAIN_CALLS_LIMIT_DEFAULT,
    ).optional(),
    call_module: z.string().max(CHAIN_CALL_MODULE_MAX_LENGTH).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/signers": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    sort: sortSchema(
      ["tx_count", "total_fee_tao"] as const,
      "tx_count",
    ).optional(),
    limit: limitSchema(
      CHAIN_SIGNERS_LIMIT_MAX,
      CHAIN_SIGNERS_LIMIT_DEFAULT,
    ).optional(),
    call_module: z.string().max(CHAIN_CALL_MODULE_MAX_LENGTH).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/transfers": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_TRANSFER_LIMIT_MAX,
      CHAIN_TRANSFER_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/transfer-pairs": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_TRANSFER_PAIR_LIMIT_MAX,
      CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
    ).optional(),
    sort: sortSchema(["volume", "count"] as const, "volume").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-flow": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_STAKE_FLOW_LIMIT_MAX,
      CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/alpha-volume": z.object({
    limit: limitSchema(
      CHAIN_ALPHA_VOLUME_LIMIT_MAX,
      CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/weights": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_WEIGHTS_LIMIT_MAX,
      CHAIN_WEIGHTS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/weights/setters": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
      CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/serving": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_SERVING_LIMIT_MAX,
      CHAIN_SERVING_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/axon-removals": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_AXON_REMOVALS_LIMIT_MAX,
      CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/prometheus": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_PROMETHEUS_LIMIT_MAX,
      CHAIN_PROMETHEUS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/registrations": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_REGISTRATIONS_LIMIT_MAX,
      CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/deregistrations": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_DEREGISTRATIONS_LIMIT_MAX,
      CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  // The five-value window, not the 7d/30d the per-UID feed above takes: a
  // SUBNET registers or deregisters a handful of times in its life, so a 7d
  // default would answer "nothing happened" almost always. Defaults to `all`
  // for the same reason.
  // No `offset`: the chain feeds do not page, and with a 1000 ceiling over a
  // few-hundred-row table the whole network's lifecycle fits in one request.
  "/api/v1/chain/subnet-lifecycle": z.object({
    window: windowSchema(
      HISTORY_WINDOWS as [string, ...string[]],
      "all",
    ).optional(),
    limit: limitSchema(
      CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX,
      CHAIN_SUBNET_LIFECYCLE_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-transfers": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
      CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-moves": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_STAKE_MOVES_LIMIT_MAX,
      CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/fees": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
    limit: limitSchema(
      CHAIN_FEES_LIMIT_MAX,
      CHAIN_FEES_LIMIT_DEFAULT,
    ).optional(),
    call_module: z.string().max(CHAIN_CALL_MODULE_MAX_LENGTH).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/concentration/subnets": z.object({
    lens: z
      .enum([
        "emission",
        "stake",
        "entity_emission",
        "entity_stake",
        "validator_stake",
      ] as const)
      .optional(),
    sort: sortSchema(
      [
        "nakamoto_coefficient",
        "gini",
        "holders",
        "top_1pct_share",
        "total",
        "netuid",
      ] as const,
      "nakamoto_coefficient",
    ).optional(),
    order: orderSchema("desc").optional(),
    limit: limitSchema(
      CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
      CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/chain/identity-history": z.object({
    limit: limitSchema(
      CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
      CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/chain/turnover": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const, "30d").optional(),
    limit: limitSchema(
      CHAIN_TURNOVER_LIMIT_MAX,
      CHAIN_TURNOVER_LIMIT_DEFAULT,
    ).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/uptime": z.object({
    window: windowSchema(
      UPTIME_WINDOWS as [string, ...string[]],
      "90d",
    ).optional(),
    min_samples: z.int().min(0).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/registry/leaderboards": z.object({
    board: z
      .enum([
        "healthiest",
        "fastest-rpc",
        "most-complete",
        "most-enriched",
        "fastest-growing",
        "most-reliable",
        "open-slots",
        "cheapest-registration",
        "highest-emission",
        "validator-headroom",
        "biggest-alpha-gain-1d",
        "biggest-alpha-gain-7d",
      ] as const)
      .optional(),
    limit: limitSchema(
      LEADERBOARDS_LIMIT_MAX,
      LEADERBOARDS_LIMIT_DEFAULT,
    ).optional(),
  }),
  "/api/v1/compare": z.object({
    netuids: netuidListSchema().optional(),
    dimensions: z.string().optional(),
  }),
  "/api/v1/compare/validators": z.object({
    hotkeys: z
      .string()
      .regex(
        /^[1-9A-HJ-NP-Za-km-z]{47,48}(,[1-9A-HJ-NP-Za-km-z]{47,48}){0,15}$/,
      )
      .max(783)
      .optional(),
    netuid: netuidSchema().optional(),
  }),
  "/api/v1/rpc/usage": z.object({
    window: windowSchema(
      ANALYTICS_WINDOWS as [string, ...string[]],
      "7d",
    ).optional(),
  }),
} satisfies Record<string, z.ZodObject>;
