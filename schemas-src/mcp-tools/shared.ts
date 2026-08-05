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

// --- Bounded input primitives (#9460) --------------------------------------
//
// Every tool author wrote `z.int().min(0)` inline, so no parameter declared a real
// upper bound and all of them inherited `z.int()`'s safe-integer sentinel — see
// src/mcp-input-schema.ts for why that made the published schema unreadable. These
// helpers put the bound where the fact lives: `limitSchema` takes the same constant
// from `src/route-limits.ts` that the handler enforces and the OpenAPI `maximum`
// publishes, so an MCP tool can no longer advertise a ceiling its own route rejects.
// `scripts/validate-mcp.ts` asserts the two agree.

/**
 * A subnet id. Bounded because it genuinely is: `netuid` is a u16 on chain, and
 * `isU16Netuid` is what the REST routes reject against.
 */
export const netuidSchema = () => z.int().min(0).max(65535);

/** A page size, capped at the mirrored route's own ceiling. */
export const limitSchema = (max: number) => z.int().min(1).max(max);

/**
 * A page offset. `MAX_OFFSET` is the deep-paging bound every paginated route already
 * clamps to — previously declared as unbounded here and silently clamped there.
 */
export const offsetSchema = () => z.int().min(0).max(MAX_OFFSET);

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
    );

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
  .optional();
