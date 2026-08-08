// GET /api/v1/compare (types-epic B batch 8, #8062). Composed live
// (composeCompareData) from the registry + economics + health tiers for
// several subnets side by side -- no static file. Modeled from the
// hand-edited CompareArtifact/CompareSubnetEntry components it replaces.
// Distinct from GET /api/v1/compare/validators (types-epic B batch 7,
// #8061's CompareValidatorsArtifact).
import { z } from "zod";

const CompareSubnetStructureSchema = z
  .object({
    completeness_score: z.number().nullable().optional(),
    surface_count: z.int().min(0).optional(),
    operational_interface_count: z.int().min(0).optional(),
  })
  .strict()
  .nullable();

const CompareSubnetEconomicsSchema = z
  .object({
    registration_cost_tao: z.number().nullable().optional(),
    registration_allowed: z.boolean().optional(),
    open_slots: z.int().nullable().optional(),
    emission_share: z.number().nullable().optional(),
    alpha_price_tao: z.number().nullable().optional(),
    validator_count: z.int().min(0).optional(),
    miner_count: z.int().min(0).optional(),
    total_stake_alpha: z.number().nullable().optional(),
    miner_readiness: z.number().nullable().optional(),
  })
  .strict()
  .nullable();

const CompareSubnetHealthSchema = z
  .object({
    surface_count: z.int().min(0).optional(),
    ok_count: z.int().min(0).optional(),
    avg_latency_ms: z.number().nullable().optional(),
  })
  .strict()
  .nullable();

export const CompareSubnetEntrySchema = z
  .object({
    netuid: z.int().min(0),
    name: z.string().nullable(),
    slug: z.string().nullable(),
    found: z.boolean(),
    structure: CompareSubnetStructureSchema.optional(),
    economics: CompareSubnetEconomicsSchema.optional(),
    health: CompareSubnetHealthSchema.optional(),
  })
  .strict();

export const CompareArtifactSchema = z
  .object({
    schema_version: z.int(),
    source: z.string(),
    observed_at: z.string().nullable().optional(),
    dimensions: z.array(z.string()).optional(),
    requested_netuids: z.array(z.int()).optional(),
    subnets: z.array(CompareSubnetEntrySchema),
  })
  .passthrough();
export type CompareArtifact = z.infer<typeof CompareArtifactSchema>;
