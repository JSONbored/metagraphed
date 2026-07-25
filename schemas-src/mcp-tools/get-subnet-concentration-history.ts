// MCP tool `get_subnet_concentration_history` (types-epic E batch 3,
// #8066). Mirrors GET /api/v1/subnets/{netuid}/concentration/history, which
// is not one of schemas-src/routes/'s covered pilot routes -- no existing
// Zod schema to reuse. Modeled fresh, shallow, from the hand-written
// literal it replaces.
import { z } from "zod";

const CONCENTRATION_HISTORY_WINDOWS = ["7d", "30d", "90d"] as const;

export const GetSubnetConcentrationHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(CONCENTRATION_HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetConcentrationHistoryInput = z.infer<
  typeof GetSubnetConcentrationHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const ConcentrationHistoryPointSchema = z
  .object({
    snapshot_date: z.string().nullable().optional(),
    neuron_count: z.int().nullable().optional(),
    stake_gini: z.unknown().optional(),
    stake_nakamoto_coefficient: z.unknown().optional(),
    stake_top_10pct_share: z.unknown().optional(),
    emission_gini: z.unknown().optional(),
    emission_nakamoto_coefficient: z.unknown().optional(),
    emission_top_10pct_share: z.unknown().optional(),
  })
  .passthrough();

export const GetSubnetConcentrationHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable().optional(),
    point_count: z.int(),
    points: z.array(ConcentrationHistoryPointSchema),
  })
  .passthrough();
export type GetSubnetConcentrationHistoryOutput = z.infer<
  typeof GetSubnetConcentrationHistoryOutputSchema
>;
