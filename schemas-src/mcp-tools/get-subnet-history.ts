// MCP tool `get_subnet_history` (types-epic E batch 4, #8067). Mirrors GET
// /api/v1/subnets/{netuid}/history, covered by schemas-src/routes/
// subnet-history.ts (#8055) -- NOT reused: that REST schema's `window`
// field is required (bare nullable string, no enum); this tool's own
// hand-written original leaves `window` optional and constrains it to a
// 5-value enum. Reusing would both loosen (drop the enum) and tighten
// (require the key) the existing contract in different ways -- modeled
// fresh instead, matching the original exactly.
import { z } from "zod";

const HISTORY_WINDOWS = ["7d", "30d", "90d", "1y", "all"] as const;

export const GetSubnetHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetHistoryInput = z.infer<typeof GetSubnetHistoryInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const SubnetHistoryPointSchema = z
  .object({
    snapshot_date: z.string().nullable().optional(),
    neuron_count: z.int().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    total_stake_alpha: z.unknown().optional(),
    total_emission_alpha: z.unknown().optional(),
  })
  .passthrough();

export const GetSubnetHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable().optional(),
    point_count: z.int(),
    points: z.array(SubnetHistoryPointSchema),
  })
  .passthrough();
export type GetSubnetHistoryOutput = z.infer<
  typeof GetSubnetHistoryOutputSchema
>;
