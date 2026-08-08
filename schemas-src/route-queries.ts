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
import {
  ACCOUNTS_LIST_LIMIT_MAX,
  BULK_HEALTH_TRENDS_LIMIT_MAX,
  CHAIN_CONCENTRATION_HISTORY_WINDOWS,
  CHAIN_CALL_MODULE_MAX_LENGTH,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
  CHAIN_EVENTS_LIMIT_MAX,
  CHAIN_EVENT_NAME_MAX_LENGTH,
  CHAIN_HOLDERS_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_TURNOVER_LIMIT_MAX,
  EMISSION_CHANGES_LIMIT_MAX,
  EMISSION_PIPELINE_LIMIT_MAX,
  FAILURE_REASONS_WINDOWS,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  MOVERS_LIMIT_MAX,
  PIPELINE_HISTORY_WINDOWS,
  SEMANTIC_LIMIT_DEFAULT,
  SEMANTIC_LIMIT_MAX,
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_TYPES,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  SUBNET_HOLDERS_LIMIT_MAX,
  SURFACE_HISTORY_LIMIT_MAX,
  TOP_HOLDERS_LIMIT_MAX,
  VALIDATOR_ECONOMICS_LIMIT_MAX,
} from "../src/route-limits.ts";
import { BLOCK_PAGINATION, MAX_LIMIT } from "../workers/request-params.ts";
import { CHAIN_ALPHA_VOLUME_LIMIT_MAX } from "../src/chain-alpha-volume.ts";
import { CHAIN_AXON_REMOVALS_LIMIT_MAX } from "../src/chain-axon-removals.ts";
import { CHAIN_CALLS_LIMIT_MAX } from "../src/chain-calls-artifact.ts";
import { CHAIN_DEREGISTRATIONS_LIMIT_MAX } from "../src/chain-deregistrations.ts";
import { CHAIN_EVENTS_STATS_BLOCKS_MAX } from "../src/chain-events-cold-tier.ts";
import { CHAIN_FEES_LIMIT_MAX } from "../src/chain-fees-artifact.ts";
import { CHAIN_PROMETHEUS_LIMIT_MAX } from "../src/chain-prometheus.ts";
import { CHAIN_REGISTRATIONS_LIMIT_MAX } from "../src/chain-registrations.ts";
import { CHAIN_SERVING_LIMIT_MAX } from "../src/chain-serving.ts";
import { CHAIN_SIGNERS_LIMIT_MAX } from "../src/chain-signers-artifact.ts";
import { CHAIN_STAKE_FLOW_LIMIT_MAX } from "../src/chain-stake-flow.ts";
import { CHAIN_STAKE_MOVES_LIMIT_MAX } from "../src/chain-stake-moves.ts";
import { CHAIN_STAKE_TRANSFERS_LIMIT_MAX } from "../src/chain-stake-transfers.ts";
import { CHAIN_TRANSFER_PAIR_LIMIT_MAX } from "../src/chain-transfer-pairs.ts";
import { CHAIN_TRANSFER_LIMIT_MAX } from "../src/chain-transfers.ts";
import { CHAIN_WEIGHT_SETTERS_LIMIT_MAX } from "../src/chain-weight-setters.ts";
import { CHAIN_WEIGHTS_LIMIT_MAX } from "../src/chain-weights.ts";
import { TOP_HOLDERS_SORTS } from "../src/top-holders.ts";
import { VALIDATOR_ECONOMICS_SORTS } from "../src/validator-economics.ts";
import {
  blockBoundSchema,
  daySchema,
  directionSchema,
  fieldsSchema,
  keysetCursorSchema,
  formatSchema,
  kindSchema,
  kindStringSchema,
  limitSchema,
  netuidListSchema,
  netuidSchema,
  offsetSchema,
  orderSchema,
  querySchema,
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
const unboundedOffsetSchema = () => z.int().min(0);

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
  "/api/v1/subnets/{netuid}",
  "/api/v1/subnets/{netuid}/profile",
  "/api/v1/subnets/{netuid}/overview",
  "/api/v1/agent-catalog",
  "/api/v1/agent-catalog/{netuid}",
  "/api/v1/providers/{slug}",
  "/api/v1/coverage",
  "/api/v1/ask",
  "/api/v1/webhooks/subscriptions/{id}",
  "/api/v1/alerts/triggers/{id}",
  "/api/v1/surfaces/{surface_id}/verify",
  "/api/v1/registry/summary",
  "/api/v1/lineage",
  "/api/v1/fixtures",
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
  "/api/v1/contracts",
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
export const ROUTE_QUERY_SCHEMAS = {
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
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/health/trends": z.object({
    // Integers, not strings (#10089). handleBulkHealthTrends runs
    // parseLimitParam / parseNonNegativeIntParam, so `?limit=abc` has always
    // been a 400 -- the published `{"type":"string"}` said otherwise. `offset`
    // carries no ceiling because the handler enforces none.
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(BULK_HEALTH_TRENDS_LIMIT_MAX).optional(),
    offset: unboundedOffsetSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/health/percentiles": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/health/incidents": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/trajectory": z.object({
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/performance/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/concentration/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/turnover": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
    // DIVERGENCE: see `validator_permit` on /subnets/{netuid}/metagraph --
    // the same boolean-as-string filter, published as a one-value enum.
    changes: z.enum(["true"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/weights": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/weights/setters": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/serving": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/prometheus": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-transfers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-moves": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/registrations": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/axon-removals": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/deregistrations": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-flow": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    direction: directionSchema(["all", "in", "out"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/ohlc": z.object({
    interval: z.enum(["1h", "1d"] as const).optional(),
    days: z.int().min(1).max(365).optional(),
  }),
  "/api/v1/subnets/{netuid}/stake-quote": z.object({
    amount: z.number().gt(0).optional(),
    direction: stakeActionSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/validator-economics/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
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
    ).optional(),
    limit: limitSchema(VALIDATOR_ECONOMICS_LIMIT_MAX).optional(),
    // Bounded by the ranking's own ceiling, not the generic deep-paging one:
    // one row per subnet, so seeking past the limit seeks nothing.
    offset: z.int().min(0).max(VALIDATOR_ECONOMICS_LIMIT_MAX).optional(),
    emission_gate_open: z.boolean().optional(),
    cap_binding: z.boolean().optional(),
  }),
  "/api/v1/subnets/movers": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    sort: sortSchema([
      "stake",
      "emission",
      "validators",
      "neurons",
    ] as const).optional(),
    limit: limitSchema(MOVERS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/validators": z.object({
    sort: sortSchema([
      "avg_validator_trust",
      "max_validator_trust",
      "stake_dominance",
      "subnet_count",
      "total_emission",
      "total_stake",
      "uid_count",
    ] as const).optional(),
    limit: limitSchema(GLOBAL_VALIDATOR_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts": z.object({
    sort: sortSchema([
      "total_stake",
      "total_emission",
      "subnet_count",
      "uid_count",
      "validator_count",
      "stake_dominance",
      "last_active",
    ] as const).optional(),
    limit: limitSchema(ACCOUNTS_LIST_LIMIT_MAX).optional(),
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
    sort: sortSchema(TOP_HOLDERS_SORTS as [string, ...string[]]).optional(),
    limit: limitSchema(TOP_HOLDERS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/validators/{hotkey}/nominators": z.object({
    basis: z.enum(["flow", "positions"] as const).optional(),
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    sort: sortSchema([
      "net_staked",
      "gross_staked",
      "last_activity",
    ] as const).optional(),
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
    limit: limitSchema(GLOBAL_VALIDATOR_LIMIT_MAX).optional(),
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
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
    // #9383 added this to the handler's allowlist, the MCP tool and the
    // GraphQL field, and the response echoes it back as `data.netuid` -- but
    // it was never declared, so openapi.json told every generated client that
    // passing it was an error. Verified live before declaring: the scoped and
    // unscoped series differ (#10065).
    netuid: netuidSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/metagraph": z.object({
    // DIVERGENCE: a one-value enum for a boolean filter. The sibling feeds
    // publish `["true","false"]` for the same shape, and the handler here
    // accepts (and ignores) any value -- verified live, `?validator_permit=false`
    // and `?validator_permit=bogus` both return the full metagraph. Whichever
    // of the three behaviours is right, three is too many.
    validator_permit: z.enum(["true"] as const).optional(),
    fields: fieldsSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/neurons/{uid}": z.object({
    fields: fieldsSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/hyperparameters/history": z.object({
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
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
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/events": z.object({
    kind: kindStringSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    // The handler has always accepted and forwarded this, and the sibling
    // /accounts/{ss58}/events feed publishes it -- but this route did not, so
    // the contract said passing it was an error while the route paged on it.
    // Found by sweeping all 202 GET routes through the real router (#10065).
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/event-summary": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    limit: limitSchema(SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX).optional(),
  }),
  "/api/v1/subnets/{netuid}/neurons/{uid}/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/identity-history": z.object({
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/events": z.object({
    kind: kindStringSchema().optional(),
    netuid: netuidSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/history": z.object({
    netuid: netuidSchema().optional(),
    from: daySchema("first").optional(),
    to: daySchema("last").optional(),
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    // handleAccountHistory forwards this to loadAccountHistoryColdTier and has
    // since #9315; only the contract left it out (#10065).
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/extrinsics": z.object({
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/transfers": z.object({
    direction: directionSchema(["all", "sent", "received"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/counterparties": z.object({
    counterparty: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/)
      .optional(),
    limit: z.int().min(1).max(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/stake-flow": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    direction: directionSchema(["all", "in", "out"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/stake-moves": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/deregistrations": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/prometheus": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/axon-removals": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/serving": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/weight-setters": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/registrations": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/subnets/{netuid}/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
  }),
  "/api/v1/accounts/{ss58}/identity-history": z.object({
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/network/tao-usd": z.object({
    window: windowSchema(["1h", "24h", "7d", "30d"] as const).optional(),
    include_points: z.boolean().optional(),
  }),
  "/api/v1/subnets/{netuid}/burn/history": z.object({
    window: windowSchema(["24h", "7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/holders": z.object({
    limit: limitSchema(SUBNET_HOLDERS_LIMIT_MAX).optional(),
  }),
  "/api/v1/subnets/{netuid}/surface-history": z.object({
    limit: limitSchema(SURFACE_HISTORY_LIMIT_MAX).optional(),
  }),
  "/api/v1/chain/governance/emission-changes": z.object({
    kind: kindSchema(["param", "subnet", "flow"] as const).optional(),
    limit: limitSchema(EMISSION_CHANGES_LIMIT_MAX).optional(),
  }),
  "/api/v1/chain/holders": z.object({
    sort: sortSchema([
      "top1_share",
      "top5_share",
      "top10_share",
      "top20_share",
      "holder_count",
      "total_alpha",
    ] as const).optional(),
    limit: limitSchema(CHAIN_HOLDERS_LIMIT_MAX).optional(),
  }),
  "/api/v1/health/failure-reasons": z.object({
    window: windowSchema(
      FAILURE_REASONS_WINDOWS as [string, ...string[]],
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
    ).optional(),
  }),
  "/api/v1/subnets/{netuid}/emission-pipeline/history": z.object({
    window: windowSchema(
      PIPELINE_HISTORY_WINDOWS as [string, ...string[]],
    ).optional(),
  }),
  "/api/v1/blocks": z.object({
    limit: limitSchema(BLOCK_PAGINATION.maxLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    // DIVERGENCE: the block author is an SS58 and publishes no pattern.
    author: z.string().optional(),
    spec_version: z.int().min(0).optional(),
    from: blockBoundSchema("first").optional(),
    to: blockBoundSchema("last").optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    min_extrinsics: z.int().min(0).optional(),
    min_events: z.int().min(0).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/blocks/{ref}/extrinsics": z.object({
    limit: limitSchema(BLOCK_PAGINATION.maxLimit).optional(),
    offset: offsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/blocks/{ref}/events": z.object({
    limit: limitSchema(MAX_LIMIT).optional(),
    offset: offsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain-events": z.object({
    pallet: z.string().max(CHAIN_EVENT_NAME_MAX_LENGTH).optional(),
    method: z.string().max(CHAIN_EVENT_NAME_MAX_LENGTH).optional(),
    block: blockBoundSchema("first").optional(),
    extrinsic: z.int().min(0).optional(),
    cursor: z
      .string()
      .regex(/^\d+\.\d+$/)
      .max(33)
      .optional(),
    before: blockBoundSchema("first").optional(),
    // Resolved (#10109): this published 200 while the serving path clamped at
    // 100, because TWO constants carried the name CHAIN_EVENTS_LIMIT_MAX with
    // different values and the contract was written from the one the request
    // path does not use. One constant now, in src/route-limits.ts, and it is
    // the number the route enforces.
    limit: limitSchema(CHAIN_EVENTS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain-events/stats": z.object({
    blocks: z.int().min(1).max(CHAIN_EVENTS_STATS_BLOCKS_MAX).optional(),
  }),
  "/api/v1/extrinsics": z.object({
    limit: limitSchema(BLOCK_PAGINATION.maxLimit).optional(),
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
    from: blockBoundSchema("first").optional(),
    to: blockBoundSchema("last").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/sudo": z.object({
    limit: limitSchema(BLOCK_PAGINATION.maxLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    block: blockBoundSchema("first").optional(),
    call_function: z.string().optional(),
    success: z.enum(["true", "false"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: blockBoundSchema("first").optional(),
    to: blockBoundSchema("last").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/governance/config-changes": z.object({
    limit: limitSchema(BLOCK_PAGINATION.maxLimit).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    block: blockBoundSchema("first").optional(),
    call_function: z.string().optional(),
    success: z.enum(["true", "false"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: blockBoundSchema("first").optional(),
    to: blockBoundSchema("last").optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/runtime": z.object({
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/activity": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/calls": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    group_by: z.enum(["module", "module_function"] as const).optional(),
    limit: limitSchema(CHAIN_CALLS_LIMIT_MAX).optional(),
    call_module: z.string().max(CHAIN_CALL_MODULE_MAX_LENGTH).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/signers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    sort: sortSchema(["tx_count", "total_fee_tao"] as const).optional(),
    limit: limitSchema(CHAIN_SIGNERS_LIMIT_MAX).optional(),
    call_module: z.string().max(CHAIN_CALL_MODULE_MAX_LENGTH).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/transfers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_TRANSFER_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/transfer-pairs": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_TRANSFER_PAIR_LIMIT_MAX).optional(),
    sort: sortSchema(["volume", "count"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-flow": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_STAKE_FLOW_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/alpha-volume": z.object({
    limit: limitSchema(CHAIN_ALPHA_VOLUME_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/weights": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_WEIGHTS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/weights/setters": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_WEIGHT_SETTERS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/serving": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_SERVING_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/axon-removals": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_AXON_REMOVALS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/prometheus": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_PROMETHEUS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/registrations": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_REGISTRATIONS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/deregistrations": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_DEREGISTRATIONS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-transfers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_STAKE_TRANSFERS_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-moves": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_STAKE_MOVES_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/fees": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(CHAIN_FEES_LIMIT_MAX).optional(),
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
    sort: sortSchema([
      "nakamoto_coefficient",
      "gini",
      "holders",
      "top_1pct_share",
      "total",
      "netuid",
    ] as const).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX).optional(),
  }),
  "/api/v1/chain/identity-history": z.object({
    limit: limitSchema(CHAIN_IDENTITY_HISTORY_LIMIT_MAX).optional(),
  }),
  "/api/v1/chain/turnover": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    limit: limitSchema(CHAIN_TURNOVER_LIMIT_MAX).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/uptime": z.object({
    window: windowSchema(["90d", "1y"] as const).optional(),
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
    limit: limitSchema(BLOCK_PAGINATION.maxLimit).optional(),
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
    window: windowSchema(["7d", "30d"] as const).optional(),
  }),
} satisfies Record<string, z.ZodObject>;
