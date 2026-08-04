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
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetSubnetRecycledInputSchema = z
  .object({
    netuid: z.int().min(0),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
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
    // #9104 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetSubnetRecycledOutput = z.infer<
  typeof GetSubnetRecycledOutputSchema
>;

export const GetSubnetBurnInputSchema = z
  .object({
    netuid: z.int().min(0),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSubnetBurnInput = z.infer<typeof GetSubnetBurnInputSchema>;

export const GetSubnetBurnOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    burn_tao: z.number().nullable().optional(),
    queried_at: z.string().nullable(),
    // #9104 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetSubnetBurnOutput = z.infer<typeof GetSubnetBurnOutputSchema>;

// #9399: the cross-subnet ranking. No netuid -- that is the point of it.
export const GetChainBurnInputSchema = z
  .object({
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetChainBurnInput = z.infer<typeof GetChainBurnInputSchema>;

export const GetChainBurnOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    queried_at: z.string().nullable(),
    subnet_count: z.int().nullable(),
    read_count: z.int(),
    cheapest_burn_tao: z.number().nullable(),
    dearest_burn_tao: z.number().nullable(),
    median_burn_tao: z.number().nullable(),
    subnets: z.array(
      z.object({ netuid: z.int(), burn_tao: z.number() }).passthrough(),
    ),
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetChainBurnOutput = z.infer<typeof GetChainBurnOutputSchema>;
