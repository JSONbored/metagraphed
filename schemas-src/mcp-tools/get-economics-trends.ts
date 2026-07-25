// MCP tool `get_economics_trends` (types-epic E batch 3, #8066). Mirrors
// GET /api/v1/economics/trends, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces. Window enum
// hardcoded from src/neuron-history.ts's HISTORY_WINDOWS at the time of
// writing (mirrors get-subnet-turnover.ts's same precedent this batch).
import { z } from "zod";

const HISTORY_WINDOWS = ["7d", "30d", "90d", "1y", "all"] as const;

export const GetEconomicsTrendsInputSchema = z
  .object({
    window: z.enum(HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetEconomicsTrendsInput = z.infer<
  typeof GetEconomicsTrendsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const EconomicsTrendsDaySchema = z
  .object({
    snapshot_date: z.string().nullable().optional(),
    subnet_count: z.int().nullable().optional(),
    total_stake_tao: z.number().nullable().optional(),
    alpha_price_tao_weighted: z.number().nullable().optional(),
    alpha_price_tao_median: z.number().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    miner_count: z.int().nullable().optional(),
    mean_emission_share: z.number().nullable().optional(),
  })
  .passthrough();

export const GetEconomicsTrendsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    day_count: z.int(),
    days: z.array(EconomicsTrendsDaySchema),
  })
  .passthrough();
export type GetEconomicsTrendsOutput = z.infer<
  typeof GetEconomicsTrendsOutputSchema
>;
