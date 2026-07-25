// MCP tools `get_chain_registrations`, `get_chain_deregistrations`
// (types-epic E batch 9, #8072). Each mirrors a GET /api/v1/chain/
// {de,}registrations route that is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, matching
// each hand-written literal field-for-field.
//
// The two are NOT siblings despite the name: get_chain_deregistrations
// follows the same STRICT network/intensity_distribution/subnets[] shape as
// chain-leaderboards.ts's nine tools (additionalProperties:false + full
// required arrays), but get_chain_registrations's hand-written original is
// genuinely looser -- its `network` sub-object has no additionalProperties/
// required declared (structurally open, JSON Schema's own default),
// `intensity_distribution` is a completely untyped `{type:["object","null"]}`
// (no properties at all, unlike its sibling's typed DistributionStatsSchema),
// and `subnets` uses the usual objectItems() item-level looseness instead of
// strict items. Modeled as-is, not "fixed" to match its sibling -- the epic's
// wire-compatibility mandate preserves what shipped, not what's consistent.
import { z } from "zod";
import { DistributionStatsSchema, OpenObjectSchema } from "./shared.ts";

const WINDOWS_2 = ["7d", "30d"] as const;
const LIMIT_MAX_100 = 100;

export const GetChainRegistrationsInputSchema = z
  .object({
    window: z.enum(WINDOWS_2).optional(),
    limit: z.int().min(1).max(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainRegistrationsInput = z.infer<
  typeof GetChainRegistrationsInputSchema
>;

// Genuinely open (no additionalProperties:false, no required array in the
// hand-written original) -- see file header.
const ChainRegistrationsNetworkSchema = z
  .object({
    distinct_registrants: z.int().nullable().optional(),
    registrations: z.int().nullable().optional(),
    registrations_per_registrant: z.number().nullable().optional(),
  })
  .passthrough();

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- unlike
// get_chain_deregistrations's strict items below.
const ChainRegistrationsSubnetSchema = z
  .object({
    netuid: z.int().nullable().optional(),
    distinct_registrants: z.int().nullable().optional(),
    registrations: z.int().nullable().optional(),
    registrations_per_registrant: z.number().nullable().optional(),
  })
  .passthrough();

export const GetChainRegistrationsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainRegistrationsNetworkSchema,
    // Untyped in the hand-written original (bare `{type:["object","null"]}`,
    // no properties) -- NOT DistributionStatsSchema despite the field name
    // matching its sibling tools' typed *_distribution fields.
    intensity_distribution: OpenObjectSchema.nullable().optional(),
    subnets: z.array(ChainRegistrationsSubnetSchema),
  })
  .passthrough();
export type GetChainRegistrationsOutput = z.infer<
  typeof GetChainRegistrationsOutputSchema
>;

export const GetChainDeregistrationsInputSchema = z
  .object({
    window: z.enum(WINDOWS_2).optional(),
    limit: z.int().min(1).max(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainDeregistrationsInput = z.infer<
  typeof GetChainDeregistrationsInputSchema
>;

const ChainDeregistrationsNetworkSchema = z
  .object({
    distinct_deregistered_hotkeys: z.int(),
    deregistrations: z.int(),
    deregistrations_per_hotkey: z.number().nullable(),
  })
  .strict();

const ChainDeregistrationsSubnetSchema = z
  .object({
    netuid: z.int(),
    distinct_deregistered_hotkeys: z.int(),
    deregistrations: z.int(),
    deregistrations_per_hotkey: z.number(),
  })
  .strict();

export const GetChainDeregistrationsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainDeregistrationsNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainDeregistrationsSubnetSchema),
  })
  .passthrough();
export type GetChainDeregistrationsOutput = z.infer<
  typeof GetChainDeregistrationsOutputSchema
>;
