// The query-parameter vocabulary, shared by BOTH published surfaces (#9986).
//
// These builders were written for `schemas-src/mcp-tools/` and lived there, so
// the REST route schemas in `schemas-src/routes/` could not reach them and
// hand-declared the same parameters instead -- as unbounded stubs. Measured
// before this move: of 82 MCP input schemas that share properties with their
// route's query schema, 56 disagreed about the CONSTRAINTS, and in every case
// the route side was the looser one:
//
//   netuid        MCP max 65535        route max 9007199254740991 (z.int(), no bound)
//   offset        MCP max 1000000      route unbounded
//   window        MCP enum(7d..all)    route z.string()
//   counterparty  MCP ss58 pattern     route z.string()
//
// That is what two declarations of one parameter always becomes. There is now
// one definition per parameter and both surfaces import it, so a bound changes
// in one place or not at all.
//
// This module is deliberately NOT under mcp-tools/: the parameters are not an
// MCP concept, and putting them there is what made the route schemas rewrite
// them. `mcp-tools/shared.ts` re-exports every symbol, so the ~100 existing
// import sites keep working unchanged.
import { z } from "zod";
import { MAX_OFFSET } from "../workers/request-params.ts";

/**
 * A subnet id. Bounded because it genuinely is: `netuid` is a u16 on chain, and
 * `isU16Netuid` is what the REST routes reject against.
 */
export const netuidSchema = () =>
  z
    .int()
    .min(0)
    .max(65535)
    .describe(
      "Subnet id (netuid), 0-65535. 0 is the root subnet, which is special: " +
        "it has no AMM pool and is emission-ineligible.",
    )
    .meta({ examples: [64, 0] });

/**
 * A comma-separated list of subnet ids, for the routes that filter on a SET.
 *
 * Both bounds are real and both matter: at most 128 ids, each at most 5 digits
 * (a netuid is a u16), which is exactly the 767-character ceiling — 128 ids
 * plus 127 commas. The MCP side published `^\d+(,\d+)*$` for the same
 * parameter: unbounded in count and accepting a 9-digit "netuid", so a tool
 * caller could send a list its own route rejects.
 */
export const NETUID_LIST_MAX_LENGTH = 767;
export const NETUID_LIST_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;
export const netuidListSchema = () =>
  z
    .string()
    .max(NETUID_LIST_MAX_LENGTH)
    .regex(NETUID_LIST_PATTERN)
    .describe(
      "Comma-separated subnet ids to restrict the result to, e.g. `1,7,64`. " +
        "At most 128 ids, each 0-65535. Unknown ids match nothing rather than erroring.",
    )
    .meta({ examples: ["1,7,64"] });

/**
 * A page size, capped at the mirrored route's own ceiling.
 *
 * `fallback` is the value the handler uses when the argument is omitted, and
 * passing it is what puts the documented default INTO the contract rather than
 * only in the tool's prose. Deliberately NOT a Zod `.default()`: that would
 * substitute the value during parse, and these handlers own that decision.
 * Declaring the default without applying it keeps the published contract
 * honest and the runtime behaviour untouched.
 *
 * THE SENTENCE NO LONGER PROMISES CLAMPING. It used to -- "a larger value is
 * clamped to the ceiling rather than rejected" -- and that is false for 25 MCP
 * tools, measured by dispatching `limit: max + 1` at every tool that publishes
 * a ceiling: 15 collection-backed ones reject through validateListQuery, and
 * 10 hand-rolled handlers reject through parseBoundedIntParam.
 *
 * Clamp-vs-reject is a property of the HANDLER, not of the surface. That is
 * also why the REST-side sentence in contracts.ts was over-general the other
 * way ("rejected ... on every route", false on /api/v1/chain-events, which
 * clamps). Two published sentences, each true of most of its surface and
 * neither true of all of it, and nothing compared them until #10064.
 *
 * `tests/pagination-bound-parity.test.ts` pins the real partition on both
 * surfaces, so a handler moving between clamping and rejecting is a visible
 * change rather than a caller's surprise.
 */
export const limitSchema = (max: number, fallback?: number) => {
  const schema = z.int().min(1).max(max);
  return fallback === undefined
    ? schema
        .describe(`Maximum rows to return (1-${max}).`)
        .meta({ examples: [Math.min(20, max)] })
    : schema
        .describe(
          `Maximum rows to return (1-${max}). Defaults to ${fallback} when ` +
            "omitted. The response reports the limit actually applied.",
        )
        .meta({ default: fallback, examples: [fallback] });
};

/**
 * A page offset. `MAX_OFFSET` is the deep-paging bound every paginated route already
 * clamps to — previously declared as unbounded here and silently clamped there.
 */
export const offsetSchema = () =>
  z
    .int()
    .min(0)
    .max(MAX_OFFSET)
    .describe(
      `Rows to skip before the first returned row (0-${MAX_OFFSET}). ` +
        "Defaults to 0; a non-numeric value resolves to 0 and the response reports it.",
    )
    .meta({ examples: [0, 100] });

/**
 * An SS58 address. The pattern is the one 26 tool modules each declared
 * privately; hoisted so the regex and the sentence explaining it live once.
 *
 * Not narrowed to a network prefix: these routes accept any well-formed SS58,
 * and the chain is what rejects an address valid in shape but belonging to no
 * account.
 */
export const SS58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{47,48}$/;
export const ss58Schema = () =>
  z
    .string()
    .regex(SS58_PATTERN)
    .describe(
      "An SS58 account address (47-48 base58 characters). Coldkey or hotkey " +
        "depending on the tool — see the tool description for which this expects.",
    )
    .meta({ examples: ["5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"] });

/**
 * Sort direction. 31 of the 32 `order` parameters are this exact pair and mean
 * the same thing on every one of them.
 */
export const orderSchema = () =>
  z
    .enum(["asc", "desc"])
    .describe(
      "Sort direction for the chosen sort key: `asc` smallest-first, " +
        "`desc` largest-first.",
    )
    .meta({ examples: ["desc"] });

// --- Descriptions for families whose VALUES are per-tool ---------------------
//
// `window`, `sort` and `kind` do not share one enum — 7, 31 and 5 distinct
// value sets respectively — so they cannot share a builder. What they do share
// is the MEANING of the parameter, and that is the part no caller could read
// anywhere. Each wrapper takes the tool's own enum and attaches the sentence;
// the published `enum` still carries the values, so nothing is duplicated or
// able to drift.

/**
 * A trailing aggregation window. Says the two things the enum cannot: that it
 * is trailing and ends now, not a calendar period, and that the option set is
 * per-tool.
 */
export const windowSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Trailing time window to aggregate over, ending at the latest data " +
        "point rather than a calendar boundary. Options are per-tool; see this " +
        "parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/**
 * Which side of a two-sided flow to count. Values are per-route -- the transfer
 * feeds say `all|sent|received` and the stake feeds `all|in|out` -- so, like
 * `window` and `sort`, only the meaning is shared.
 *
 * NOT the stake quote's `direction`, which this used to cover on the strength
 * of the shared name. That one selects an ACTION (`stake|unstake`), omitting it
 * quotes a `stake` rather than "both", and there is no flow to have a side of
 * -- so the sentence below was false on that route. It went unnoticed while the
 * prose lived only in the MCP copy, which said something generic instead;
 * deriving the tool input from the route (#10064) would have published the
 * wrong sentence to every agent. A coincident name, not a shared meaning --
 * the distinction #9799 drew. See `stakeActionSchema`.
 *
 * The sentence carries the part no enum can: that the default is BOTH sides,
 * and that a direction is relative to the account or subnet in the path rather
 * than to the network.
 */
export const directionSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Which side of the flow to count, relative to the account or subnet " +
        "this route is scoped to. Omit to count both. Options are per-route; " +
        "see this parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/**
 * Which side of a stake quote to price.
 *
 * Distinct from `directionSchema` despite the shared parameter name: this is an
 * action, not a side of a flow, and omitting it prices a `stake` rather than
 * returning both. Verified live -- /subnets/1/stake-quote?amount=1 answers
 * `direction: "stake"`.
 */
export const stakeActionSchema = () =>
  z
    .enum(["stake", "unstake"] as const)
    .describe(
      "Which side of the trade to price: `stake` buys alpha with TAO, " +
        "`unstake` sells alpha for TAO. Omit for `stake`.",
    )
    .meta({ examples: ["stake"] });

/** Which column the result is ranked by. Values are per-tool. */
export const sortSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Column to rank the result by; pair with `order` for direction. " +
        "Options are per-tool; see this parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/**
 * A block height bound. Inclusive on both ends, which is the one thing a
 * caller cannot infer from the name and gets wrong by one row.
 */
export const blockBoundSchema = (edge: "first" | "last") =>
  z
    .int()
    .min(0)
    .describe(
      `Inclusive ${edge} block height of the range to read. ` +
        "Omit for an unbounded end.",
    )
    .meta({ examples: [8783000] });

/**
 * Length ceilings for the free-text parameters.
 *
 * An unbounded value drives per-term, per-row scan work in `searchRows` and in
 * filter matching (#5544), so both are capped: `q` is typed search prose and
 * gets a generous 200, while the exact-ish filters (`provider`, `id`,
 * `review_state`, `reason_codes`) are structured tokens and are bounded tighter.
 * `workers/list-query.ts` rejects an over-length value by reading the ceiling
 * off the published schema, so these numbers ARE the enforcement, not a
 * description of it.
 */
export const SEARCH_TEXT_MAX_LENGTH = 200;
export const FILTER_TEXT_MAX_LENGTH = 100;

/**
 * A free-text search query. Substring/keyword, not a query language — worth
 * saying, because an agent that assumes operators will silently get no match.
 *
 * `max` defaults to the list collections' ceiling; a route with its own takes
 * it from `src/route-limits.ts`, the same shape as `limitSchema`. Semantic
 * search embeds the query rather than scanning with it, so it affords far more.
 */
export const querySchema = (max: number = SEARCH_TEXT_MAX_LENGTH) =>
  z
    .string()
    .max(max)
    .describe(
      "Free-text search terms, matched as case-insensitive substrings. " +
        "Not a query language: operators, quotes and wildcards are matched literally.",
    )
    .meta({ examples: ["inference", "text embedding"] });

/**
 * An exact-ish filter token — a slug, an id, a state name. Distinct from
 * `querySchema()` in the bound and in the matching: this is compared against a
 * field, not searched for inside one, so an unknown value yields an empty
 * result rather than an error.
 */
export const filterTokenSchema = () =>
  z
    .string()
    .max(FILTER_TEXT_MAX_LENGTH)
    .describe(
      "Restrict the result to rows whose field equals this value. Matched " +
        "exactly (case-insensitively), not searched for as a substring — an " +
        "unmatched value yields an empty result rather than an error.",
    )
    .meta({ examples: ["opentensor-foundation"] });

/**
 * A page cursor. TWO kinds, and conflating them is the mistake this pair
 * exists to prevent: 32 of the 47 `cursor` parameters are a numeric row
 * offset and 14 are an opaque keyset token. They page differently and only
 * one of them is safe across an inserting table, so they get different
 * sentences rather than one vague shared one.
 */
export const numericCursorSchema = () =>
  z
    .int()
    .min(0)
    .describe(
      "Row offset to resume from — the numeric position of the first row to " +
        "return, not an opaque token. Rows inserted since the previous page " +
        "shift it, so prefer the keyset cursor where a tool offers one.",
    )
    .meta({ examples: [0, 100] });
/**
 * The `block_number.event_index` pagination cursor.
 *
 * A SEPARATE builder from `keysetCursorSchema()` on purpose. That one is a
 * genuinely opaque base64 token with nothing to bound; this one has a shape the
 * route publishes and enforces -- two non-negative integers joined by a dot,
 * at most 33 characters. Declaring it as a bare string, which the two chain
 * feeds did on the MCP side, advertises a value their own route rejects.
 */
export const BLOCK_EVENT_CURSOR_MAX_LENGTH = 33;
export const BLOCK_EVENT_CURSOR_PATTERN = /^\d+\.\d+$/;
export const blockEventCursorSchema = () =>
  z
    .string()
    .max(BLOCK_EVENT_CURSOR_MAX_LENGTH)
    .regex(BLOCK_EVENT_CURSOR_PATTERN)
    .describe(
      "Pagination cursor as `block_number.event_index` -- pass back the " +
        "`next_cursor` from the previous response. Both parts are " +
        "non-negative safe integers.",
    )
    .meta({ examples: ["8783000.4"] });

export const keysetCursorSchema = () =>
  z
    .string()
    .describe(
      "Opaque pagination token: pass back the `next_cursor` from the previous " +
        "response verbatim. Its contents are not stable and must not be parsed " +
        "or constructed. Stable across inserts, unlike a row offset.",
    )
    .meta({ examples: ["eyJiIjo4NzgzMDAwLCJpIjo0fQ"] });

/**
 * The accepted `fields` syntax, which was documented NOWHERE a caller could see it:
 * 27 of 31 `fields` parameters were bare `{"type":"string"}`, 19 of them with no
 * mention in the tool description either. The format is a comma-separated list of bare
 * row-field names — mirrors `FIELD_NAME_PATTERN` in src/field-projection.ts, which is
 * what actually rejects a malformed value.
 *
 * Deliberately as permissive as `parseFieldsParam` actually is, not as tidy as the
 * canonical form looks: that parser trims each segment and drops empty ones, so
 * `"netuid, name"` and `"netuid,,name"` are both accepted. A stricter pattern would
 * make a generated client reject input the server takes — the same defect as an MCP
 * tool declaring a page-size ceiling its own route does not enforce.
 *
 * Both surfaces publish this one. REST used to publish a strictly tighter regex
 * (`^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$`) that nothing enforced and
 * that the route contradicts — confirmed against production, where
 * `?fields=netuid,%20name` and `?fields=netuid,,name` both return 200 with the
 * projection applied.
 */
export const FIELDS_PATTERN =
  "^[\\s,]*[A-Za-z_][A-Za-z0-9_]*(\\s*,[\\s,]*[A-Za-z_][A-Za-z0-9_]*)*[\\s,]*$";
export const fieldsSchema = () =>
  z
    .string()
    .regex(new RegExp(FIELDS_PATTERN))
    .describe(
      "Comma-separated row field names to project, e.g. `netuid,name,slug`. " +
        "Bare identifiers only — not a JSON array, no paths or indices. " +
        "An unknown name is rejected rather than ignored.",
    )
    .meta({ examples: ["netuid,name,slug"] });

/**
 * A YYYY-MM-DD calendar-date bound on a day-partitioned feed.
 *
 * Deliberately NOT `z.iso.date()`. That emits a calendar-correct pattern —
 * rejecting `2026-02-30`, `2027-02-29` and every 31st of a 30-day month — and
 * the routes taking these bounds validate with `DAY_PATTERN`
 * (`workers/request-params.ts`), which is format-only and says so: it does not
 * range-check the month or day fields. Publishing the stricter regex would
 * refuse input the server accepts, which is the defect #10073 fixed on
 * `fields` and is not worth reintroducing for a bound whose only job is to
 * compare lexicographically against a TEXT `day` column.
 *
 * `format: date` rather than a pattern, so a generated client gets a date
 * picker and the shape stays exactly what the handler enforces.
 */
export const daySchema = (edge: "first" | "last") =>
  z
    .string()
    .meta({ format: "date", examples: ["2026-08-01"] })
    .describe(
      `Inclusive ${edge} day of the range to read, as YYYY-MM-DD. ` +
        "Omit for an unbounded end.",
    );

/**
 * The `format=` response-format override.
 *
 * The most repeated parameter on the surface: 85 routes publish it and every
 * one is this exact pair. It belongs here for the same reason `order` does --
 * one constraint, one meaning, everywhere it appears.
 *
 * The per-route PROSE stays per-route (each description names what the rows
 * are), so this carries the part that is genuinely shared: which two values
 * exist and which is the default.
 */
export const formatSchema = () =>
  z
    .enum(["json", "csv"])
    .describe(
      "Response format override. `csv` downloads the route's rows as " +
        "text/csv; `json` is the default and keeps the response envelope.",
    )
    .meta({ examples: ["csv"] });

/**
 * RPC POOL kinds -- what a pool of endpoints is FOR.
 *
 * Deliberately its own vocabulary next to ENDPOINT_LAYER_VALUES, because the
 * two look interchangeable and are not: a layer says where an endpoint sits in
 * the stack (`bittensor-base`, `subnet-app`), a pool kind says which base-layer
 * protocol the pool serves. `list_rpc_pools` published the layer values for
 * this parameter, so all four of the values it advertised were rejected by its
 * route and none of the three that work was advertised (#10118).
 */
export const RPC_POOL_KIND_VALUES = [
  "subtensor-rpc",
  "subtensor-wss",
  "archive",
] as const;
export const RpcPoolKindSchema = z.enum(RPC_POOL_KIND_VALUES);
export type RpcPoolKind = z.infer<typeof RpcPoolKindSchema>;

/**
 * A `kind` filter. Like `window`/`sort`, the value sets are per-tool (surface
 * kinds, pool kinds, feed kinds …), so only the meaning is shared.
 */
export const kindSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Restrict the result to this kind. Options are per-tool; see this " +
        "parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/**
 * A `kind` filter whose accepted values are NOT a closed set — the handler
 * matches against whatever the underlying rows carry, so there is no enum to
 * publish. Says so, because an unmatched value returns an empty result rather
 * than an error, which reads as "no data" instead of "wrong filter".
 */
export const kindStringSchema = () =>
  z
    .string()
    .describe(
      "Restrict the result to this kind, matched exactly against the value " +
        "the rows carry. Open set, so a value nothing matches yields an empty " +
        "result rather than an error. Omit for every kind.",
    )
    .meta({ examples: ["subnet-api"] });

/**
 * A 32-byte chain hash -- a block hash, an extrinsic hash, a call hash.
 *
 * `identifier-resolver.ts` recognises exactly this shape, and the routes that
 * filter on one publish the pattern. `list_extrinsics.call_hash` declared a
 * bare string, so a malformed hash reached the route and came back as an empty
 * result rather than as "that is not a hash" (#10131).
 */
export const HASH_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const hashSchema = (what: string) =>
  z
    .string()
    .regex(HASH_HEX_PATTERN)
    .describe(`The ${what}, 0x-prefixed and 64 hex characters.`)
    .meta({
      examples: [
        "0x9f1e2d3c4b5a69788796a5b4c3d2e1f009182736455463728190abcdef012345",
      ],
    });

/**
 * A Substrate runtime NAME -- a pallet, or a call module.
 *
 * `max` differs by route and is passed in, because the routes genuinely differ:
 * the chain-analytics feeds cap `call_module` at 100 and the event feeds cap
 * `pallet`/`method` at 64. What is shared is the meaning -- a runtime
 * identifier, matched case-sensitively -- and the fact that it is bounded at
 * all, which four tool sites did not say (#10131).
 */
export const runtimeNameSchema = (max: number) =>
  z
    .string()
    .max(max)
    .describe(
      "A Substrate runtime name, matched case-sensitively as the runtime " +
        "spells it (`SubtensorModule`, `set_weights`).",
    )
    .meta({ examples: ["SubtensorModule"] });

/**
 * A `reason_codes` filter -- the codes an item carries, any of which matches.
 *
 * The sentence was written out at 3 tool sites and the bound at none of them.
 * Matched by `validateListQuery`, which reads `maxLength` off the PUBLISHED
 * schema to decide a 400, so an unbounded declaration advertises a value the
 * route rejects.
 */
export const reasonCodesSchema = () =>
  z
    .string()
    .max(FILTER_TEXT_MAX_LENGTH)
    .describe(
      "Comma-separated reason codes to filter by; an item matches if it " +
        "carries any of them.",
    )
    .meta({ examples: ["stale-evidence"] });

/**
 * A `review_state` filter -- where an item sits in maintainer review.
 *
 * The sentence was written out at 4 tool sites and the bound at none of them.
 * `review_state` is matched by `validateListQuery`, which reads `maxLength`
 * off the PUBLISHED schema to decide a 400, so an unbounded declaration
 * advertises a value the route rejects. Open set, like every other
 * exact-match filter here.
 */
export const reviewStateSchema = () =>
  z
    .string()
    .max(FILTER_TEXT_MAX_LENGTH)
    .describe("Where the item sits in maintainer review.")
    .meta({ examples: ["pending"] });

/**
 * An `id` filter -- the record's own stable identifier.
 *
 * The sentence was written out at 7 tool sites, and the bound at none of them:
 * `id` is matched by `validateListQuery`, which reads `maxLength` off the
 * PUBLISHED schema to decide a 400, so a tool declaring it unbounded advertises
 * a value its route rejects. Same ceiling as every other exact-match filter.
 */
export const idFilterSchema = () =>
  z
    .string()
    .max(FILTER_TEXT_MAX_LENGTH)
    .describe(
      "The record's stable identifier, as returned by the corresponding list " +
        "tool. Exact match; an unknown id yields an empty result rather than " +
        "an error.",
    )
    .meta({ examples: ["sn-64-chutes-subnet-api"] });

/**
 * A provider slug. Says it is the slug rather than the display name, which is
 * the mistake the parameter invites — `npm run providers:list` prints them.
 */
export const providerSlugSchema = () =>
  z
    .string()
    // The same ceiling `filterTokenSchema()` carries, because it is the same
    // filter: `validateListQuery` reads `maxLength` off the PUBLISHED schema to
    // decide a 400, so a builder without it advertises a value the route
    // rejects. This one exists for the PROSE -- "by slug, not display name" is
    // the mistake the parameter invites -- not to be looser.
    .max(FILTER_TEXT_MAX_LENGTH)
    .describe(
      "Restrict to one provider, by SLUG (`opentensor-foundation`), not " +
        "display name. Unknown slugs yield an empty result, not an error.",
    )
    .meta({ examples: ["opentensor-foundation"] });

/** A surface id, the stable key a surface keeps across renames. */
export const surfaceIdSchema = () =>
  z
    .string()
    .describe(
      "The surface's stable id (`sn-64-chutes-subnet-api`), as returned by " +
        "the surface-listing tools. Stable across renames, unlike the name.",
    )
    .meta({ examples: ["sn-64-chutes-subnet-api"] });

/**
 * A hotkey or coldkey the caller must pick. Distinct from `ss58Schema()` only
 * in that the tools using it name the ROLE in the parameter, so the sentence
 * says which one rather than deferring to the tool description.
 */
export const accountKeySchema = (role: "hotkey" | "coldkey") =>
  z
    .string()
    .regex(SS58_PATTERN)
    .describe(
      role === "hotkey"
        ? "The neuron/validator SS58 hotkey — the key that holds a UID and " +
            "sets weights, not the coldkey that owns the funds."
        : "The owning SS58 coldkey — the key that holds balances and " +
            "delegations, not the hotkey that serves on a subnet.",
    )
    .meta({
      examples: ["5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV"],
    });

/** A neuron's position within one subnet. */
export const uidSchema = () =>
  z
    .int()
    .min(0)
    .describe(
      "Neuron UID: a slot number within ONE subnet, not a global id. The same " +
        "UID on another netuid is a different neuron, and a UID is reused " +
        "after deregistration.",
    )
    .meta({ examples: [0, 128] });
