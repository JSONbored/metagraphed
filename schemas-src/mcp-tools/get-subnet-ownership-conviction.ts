// MCP tools `get_subnet_ownership_history`, `get_subnet_conviction`
// (types-epic E batch 4, #8067). Mirror GET /api/v1/subnets/{netuid}/
// ownership-history and GET /api/v1/subnets/{netuid}/conviction, neither of
// which is one of schemas-src/routes/'s covered pilot routes -- no existing
// Zod schema to reuse. Modeled fresh, shallow, from the hand-written
// literals they replace.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { FieldSourcesSchema } from "../shared.ts";

export const GetSubnetOwnershipHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetOwnershipHistoryInput = z.infer<
  typeof GetSubnetOwnershipHistoryInputSchema
>;

const OwnershipChangeSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    old_coldkey: z.string().nullable().optional(),
    new_coldkey: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetSubnetOwnershipHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    count: z.int(),
    ownership_changes: z.array(OwnershipChangeSchema),
  })
  .passthrough();
export type GetSubnetOwnershipHistoryOutput = z.infer<
  typeof GetSubnetOwnershipHistoryOutputSchema
>;

export const GetSubnetConvictionInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetConvictionInput = z.infer<
  typeof GetSubnetConvictionInputSchema
>;

const ConvictionLeaderboardEntrySchema = z
  .object({
    hotkey: z.string().optional(),
    is_owner: z.boolean().optional(),
    locked_mass: z.number().optional(),
    conviction: z.number().optional(),
  })
  .passthrough();

export const GetSubnetConvictionOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    queried_at_block: z.int().nullable().optional(),
    unlock_rate: z.int().nullable().optional(),
    maturity_rate: z.int().nullable().optional(),
    king: z.string().nullable().optional(),
    count: z.int(),
    leaderboard: z.array(ConvictionLeaderboardEntrySchema),
    // #9108 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetSubnetConvictionOutput = z.infer<
  typeof GetSubnetConvictionOutputSchema
>;
