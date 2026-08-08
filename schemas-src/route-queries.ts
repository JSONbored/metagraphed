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
  orderSchema,
  querySchema,
  sortSchema,
  windowSchema,
} from "./query-params.ts";

/**
 * DIVERGENCE: `offset` is published two different ways.
 *
 * The 34 collection routes publish `offsetSchema()`, which carries
 * `maximum: MAX_OFFSET` -- the deep-paging bound `clampOffset()` applies. Every
 * one of the 17 sites below publishes the same parameter with no ceiling, while
 * running through the same clamp. One enforcement, two published statements,
 * and the split is total: not a single non-collection route publishes the
 * bounded form, which is why nobody noticed one of them was different.
 *
 * Reproduced as-published so this step stays byte-identical. The correction is
 * to publish the bound everywhere, which is a contract change and belongs with
 * the other content fixes rather than in a refactor that claims to change
 * nothing.
 */
const uncappedOffsetSchema = () => z.int().min(0);

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
export const ROUTE_QUERY_SCHEMAS: Record<string, z.ZodObject> = {
  "/api/v1/search/semantic": z.object({
    q: querySchema(1000).optional(),
    limit: limitSchema(20, 10).optional(),
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
    limit: limitSchema(512).optional(),
    fields: fieldsSchema().optional(),
  }),
  "/api/v1/economics/trends": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/health/trends": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(512).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    direction: directionSchema(["stake", "unstake"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/validator-economics/history": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/validators/economics": z.object({
    // DIVERGENCE: the only `sort` on the surface published without an enum.
    // Every other one names its columns, and the handler here does have a
    // closed set -- so a caller has to guess, and a wrong guess is a silent
    // no-op rather than a 400.
    sort: z.string().optional(),
    limit: limitSchema(512).optional(),
    offset: z.int().min(0).max(512).optional(),
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
    limit: limitSchema(100).optional(),
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
    limit: limitSchema(2000).optional(),
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
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/top-holders": z.object({
    sort: sortSchema([
      "total_tao",
      "free_tao",
      "delegated_tao",
      "net_flow_7d",
      "net_flow_30d",
      "net_flow_90d",
    ] as const).optional(),
    limit: limitSchema(100).optional(),
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
    limit: limitSchema(100).optional(),
    offset: uncappedOffsetSchema().optional(),
    // DIVERGENCE: an SS58 address published as a bare string, while
    // `ss58Schema()` carries the 47-48 base58 pattern the same value gets on
    // 26 other parameters. A typo'd address reads as "this nominator has no
    // stake" instead of as a malformed key.
    coldkey: z.string().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/validators/{hotkey}/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
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
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/subnets/{netuid}/event-summary": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    limit: limitSchema(50).optional(),
  }),
  "/api/v1/subnets/{netuid}/neurons/{uid}/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "1y", "all"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/identity-history": z.object({
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/events": z.object({
    kind: kindStringSchema().optional(),
    netuid: netuidSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/history": z.object({
    netuid: netuidSchema().optional(),
    from: daySchema("first").optional(),
    to: daySchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/extrinsics": z.object({
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/accounts/{ss58}/transfers": z.object({
    direction: directionSchema(["all", "sent", "received"] as const).optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    limit: limitSchema(100).optional(),
  }),
  "/api/v1/subnets/{netuid}/surface-history": z.object({
    limit: limitSchema(200).optional(),
  }),
  "/api/v1/chain/governance/emission-changes": z.object({
    kind: kindSchema(["param", "subnet", "flow"] as const).optional(),
    limit: limitSchema(200).optional(),
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
    limit: limitSchema(512).optional(),
  }),
  "/api/v1/health/failure-reasons": z.object({
    window: windowSchema(["7d", "30d", "90d", "180d"] as const).optional(),
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
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
  }),
  "/api/v1/subnets/{netuid}/emission-pipeline/history": z.object({
    window: windowSchema(["7d", "30d", "90d", "180d"] as const).optional(),
  }),
  "/api/v1/blocks": z.object({
    limit: limitSchema(100).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    limit: limitSchema(100).optional(),
    offset: uncappedOffsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/blocks/{ref}/events": z.object({
    limit: limitSchema(1000).optional(),
    offset: uncappedOffsetSchema().optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain-events": z.object({
    pallet: z.string().max(64).optional(),
    method: z.string().max(64).optional(),
    block: blockBoundSchema("first").optional(),
    extrinsic: z.int().min(0).optional(),
    cursor: z
      .string()
      .regex(/^\d+\.\d+$/)
      .max(33)
      .optional(),
    before: blockBoundSchema("first").optional(),
    limit: limitSchema(200).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain-events/stats": z.object({
    blocks: z.int().min(1).max(5000).optional(),
  }),
  "/api/v1/extrinsics": z.object({
    limit: limitSchema(100).optional(),
    offset: uncappedOffsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
    block: blockBoundSchema("first").optional(),
    // DIVERGENCE: see `coldkey` on /validators/{hotkey}/nominators -- an SS58
    // published without the shared pattern.
    signer: z.string().optional(),
    // DIVERGENCE: `call_module` is capped at 100 characters on the three
    // chain-analytics feeds and uncapped here, for one filter matched the same
    // way against the same column.
    call_module: z.string().optional(),
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
    limit: limitSchema(100).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    limit: limitSchema(100).optional(),
    offset: uncappedOffsetSchema().optional(),
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
    limit: limitSchema(100).optional(),
    call_module: z.string().max(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/signers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    sort: sortSchema(["tx_count", "total_fee_tao"] as const).optional(),
    limit: limitSchema(100).optional(),
    call_module: z.string().max(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/transfers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/transfer-pairs": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    sort: sortSchema(["volume", "count"] as const).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-flow": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/alpha-volume": z.object({
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/weights": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/weights/setters": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/serving": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/axon-removals": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/prometheus": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/registrations": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/deregistrations": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-transfers": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/stake-moves": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    format: formatSchema().optional(),
  }),
  "/api/v1/chain/fees": z.object({
    window: windowSchema(["7d", "30d"] as const).optional(),
    limit: limitSchema(100).optional(),
    call_module: z.string().max(100).optional(),
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
    limit: limitSchema(512).optional(),
  }),
  "/api/v1/chain/identity-history": z.object({
    limit: limitSchema(200).optional(),
  }),
  "/api/v1/chain/turnover": z.object({
    window: windowSchema(["7d", "30d", "90d"] as const).optional(),
    limit: limitSchema(100).optional(),
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
    limit: limitSchema(100).optional(),
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
};
