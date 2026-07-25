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
