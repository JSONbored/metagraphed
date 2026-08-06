// Shared building blocks for schemas-src/mcp-tools/*.ts (types-epic E,
// #7863). Every hand-written MCP output schema this epic has converted so
// far leaves nested objects/arrays shallow (bare `{type:"object"}` /
// `{type:"array", items:{type:"object"}}`, no per-field constraints) even on
// tools whose description says they "mirror" a REST route -- reusing a
// deeper schemas-src/routes/ schema for those fields would silently accept
// LESS than the original wire contract did, a regression per #7863's "hard
// wire-compatibility constraint" (see e.g. get-network-health.ts's header
// for the fuller rationale, first established in the pilot batch). These
// two helpers are the Zod equivalent of that same shallow-on-purpose shape.
import { z } from "zod";
import { NeuronSchema } from "../routes/subnet-metagraph.ts";
import { MAX_OFFSET } from "../../workers/request-params.ts";

// --- Bounded input primitives --------------------------------------
//
// Every tool author wrote `z.int().min(0)` inline, so no parameter declared a real
// upper bound and all of them inherited `z.int()`'s safe-integer sentinel — see
// src/mcp-input-schema.ts for why that made the published schema unreadable. These
// helpers put the bound where the fact lives: `limitSchema` takes the same constant
// from `src/route-limits.ts` that the handler enforces and the OpenAPI `maximum`
// publishes, so an MCP tool can no longer advertise a ceiling its own route rejects.
// `scripts/validate-mcp.ts` asserts the two agree.

// DESCRIPTIONS BELONG ON THE PRIMITIVE, NOT IN THE TOOL PARAGRAPH (#9645).
// Measured before writing these: of 773 published tool parameters, exactly ONE
// carried a `description` — `fields`, below, the only one of these primitives
// that had one. The guidance was not missing, it was in prose inside each
// tool's own description, where a client cannot render it per field, a model
// filling one argument does not attend to it, and nothing checks it against
// the schema. Put on the shared primitive rather than at ~260 call sites, so
// one sentence covers every tool and the wording cannot drift between them.

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
 * A page size, capped at the mirrored route's own ceiling.
 *
 * `fallback` is the value the handler uses when the argument is omitted, and
 * passing it is what puts the documented default INTO the contract rather than
 * only in the tool's prose. Deliberately NOT a Zod `.default()`: that would
 * substitute the value during parse, and these handlers own that decision —
 * they clamp an out-of-range limit and fall back on a missing or malformed
 * one, forgiving behaviour tests/mcp-schema-enforcement.test.ts pins on
 * purpose (#8942). Declaring the default without applying it keeps the
 * published contract honest and the runtime behaviour untouched.
 */
export const limitSchema = (max: number, fallback?: number) => {
  const schema = z.int().min(1).max(max);
  return fallback === undefined
    ? schema
        .describe(`Maximum rows to return (1-${max}).`)
        .meta({ examples: [Math.min(20, max)] })
    : schema
        .describe(
          `Maximum rows to return (1-${max}). Defaults to ${fallback} when omitted; ` +
            "a larger value is clamped to the ceiling rather than rejected.",
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
 * A free-text search query. Substring/keyword, not a query language — worth
 * saying, because an agent that assumes operators will silently get no match.
 */
export const querySchema = () =>
  z
    .string()
    .describe(
      "Free-text search terms, matched as case-insensitive substrings. " +
        "Not a query language: operators, quotes and wildcards are matched literally.",
    )
    .meta({ examples: ["inference", "text embedding"] });

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
 * The `fields=` projection as a bare string. Same syntax as `fieldsSchema()`
 * but without the regex, for the tools whose handler accepts a looser form —
 * the sentence is what was missing on all 26 of them.
 */
export const fieldsStringSchema = () =>
  z
    .string()
    .describe(
      "Comma-separated row field names to project, e.g. `netuid,name,slug`. " +
        "Bare identifiers only — not a JSON array, no paths or indices. " +
        "Omit for the full row.",
    )
    .meta({ examples: ["netuid,name,slug"] });

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
 * A provider slug. Says it is the slug rather than the display name, which is
 * the mistake the parameter invites — `npm run providers:list` prints them.
 */
export const providerSlugSchema = () =>
  z
    .string()
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

// Bare `{type:"object"}` (hand-written, no `properties`/`additionalProperties`
// declared -- JSON Schema's own default for an omitted additionalProperties
// is `true`, i.e. "any object, any keys").
export const OpenObjectSchema = z.object({}).passthrough();

// Bare `{type:"array"}` or `{type:"array", items:{type:"object"}}` (no
// items-shape constraint beyond "each item is some object", or none at all).
export const OpenArraySchema = z.array(z.unknown());
export const OpenObjectArraySchema = z.array(OpenObjectSchema);

// Mirrors mcp-server.ts's shared EXTRINSIC_ITEM / ACCOUNT_EVENT_ITEM object
// literals (types-epic E batch 8, #8071): each used across 3+ tools spanning
// multiple schemas-src/mcp-tools/*.ts files in that batch (list_extrinsics,
// list_block_extrinsics, get_sudo, get_governance_config_changes for the
// former; get_block_events, get_extrinsic for the latter), unlike every
// other item shape converted so far which stayed tool-local -- hoisted here
// rather than tripled. objectItems(...) properties, none required at the
// item level (see search-subnets.ts's same note from the pilot batch).
export const ExtrinsicItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
    extrinsic_hash: z.string().nullable().optional(),
    signer: z.string().nullable().optional(),
    call_module: z.string().nullable().optional(),
    call_function: z.string().nullable().optional(),
    call_args: z.unknown().optional(),
    success: z.boolean().nullable().optional(),
    fee_tao: z.unknown().optional(),
    tip_tao: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    // #8525: deterministic human-readable action sentence for this
    // extrinsic's call, or null when no template matches
    // call_module.call_function -- never a guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .passthrough();

export const AccountEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable().optional(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
  })
  .passthrough();

// The 8-field distribution-stats shape (count/mean/min/p25/median/p75/p90/
// max) 10 of types-epic E batch 9's (#8072) "chain leaderboard" tools use
// identically for their `*_distribution` field (get_chain_turnover's
// stability_distribution, get_chain_stake_flow's net_flow_distribution,
// get_chain_alpha_volume's volume_distribution, and the intensity_distribution
// on get_chain_weights/stake_moves/stake_transfers/axon_removals/serving/
// prometheus/deregistrations) -- hoisted here rather than defined 10 times,
// unlike every other nested shape in this epic which stayed tool-local
// (those never repeated verbatim across more than 2 tools).
export const DistributionStatsSchema = z
  .object({
    count: z.int(),
    mean: z.number(),
    min: z.number(),
    p25: z.number(),
    median: z.number(),
    p75: z.number(),
    p90: z.number(),
    max: z.number(),
  })
  .strict();

// `notes: {type:["array","string","null"], items:{type:"string"}}` -- 10 of
// types-epic E batch 10's (#8074) list_* tools declare this exact shape for
// their output `notes` field (list_search_index, list_search,
// list_enrichment_queue, list_adapter_candidates, list_enrichment_evidence,
// list_review_gaps, list_review_enrichment_targets, list_endpoint_pools,
// list_endpoint_incidents, list_provider_endpoints), well past the
// established "reused 3+ times within a batch" hoisting threshold this
// epic's shared item shapes above already follow.
export const NotesFieldSchema = z
  .union([z.array(z.string()), z.string()])
  .nullable()
  .optional();

// --- `fields=` projection over the Neuron row (#9082) -----------------------
//
// Read off the published NeuronSchema rather than listed here, so the enum the
// tools advertise and the fields the routes can actually project cannot drift
// apart -- the same reason MCP_NETWORK_VALUES reads McpNetworkSchema.options
// instead of carrying a hand-copied list (#8804, src/mcp-server.ts).
//
// Published as an enum rather than a free string because an agent reading
// tools/list should be able to see which fields exist without a round trip. It
// is enforced at dispatch too: the schema alone is decorative at runtime
// (#8942), so src/mcp-server.ts validates every element against this same
// array before it reaches the projector.
export const NEURON_FIELD_NAMES = Object.keys(NeuronSchema.shape) as [
  string,
  ...string[],
];

export const NeuronFieldsInputSchema = z
  .array(z.enum(NEURON_FIELD_NAMES))
  .min(1)
  .describe(
    "Narrow each returned neuron row to these fields. An ARRAY of names, " +
      "unlike the comma-separated string `fields` takes elsewhere. Omit for " +
      "the full row; the enum lists every projectable field.",
  )
  .optional();
