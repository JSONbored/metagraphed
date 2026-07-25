// MCP tools `get_subnet_recycled`, `get_subnet_burn` (types-epic E batch 4,
// #8067). Backed by the SAME src/subnet-recycled.ts loadSubnetRecycled() /
// src/subnet-burn.ts loadSubnetBurn() the REST routes (schemas-src/routes/
// subnet-registration-cost.ts, #8055) use -- NOT reused as schema imports:
// that REST schema leaves recycled_tao/burn_tao/queried_at all optional
// (`.passthrough()`, matching the KV-cache-hit code path that may return a
// smaller cached shape), but these MCP tools' own hand-written originals
// require queried_at (nullable, but always present). Reusing would loosen
// this tool's existing required set. Modeled fresh instead, matching each
// hand-written literal exactly.
import { z } from "zod";

export const GetSubnetRecycledInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetRecycledInput = z.infer<
  typeof GetSubnetRecycledInputSchema
>;

export const GetSubnetRecycledOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    recycled_tao: z.number().nullable().optional(),
    queried_at: z.string().nullable(),
  })
  .passthrough();
export type GetSubnetRecycledOutput = z.infer<
  typeof GetSubnetRecycledOutputSchema
>;

export const GetSubnetBurnInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetBurnInput = z.infer<typeof GetSubnetBurnInputSchema>;

export const GetSubnetBurnOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    burn_tao: z.number().nullable().optional(),
    queried_at: z.string().nullable(),
  })
  .passthrough();
export type GetSubnetBurnOutput = z.infer<typeof GetSubnetBurnOutputSchema>;
