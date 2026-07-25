// MCP tool `get_subnet_yield_history` (types-epic E batch 3, #8066). Mirrors
// GET /api/v1/subnets/{netuid}/yield/history, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

const YIELD_HISTORY_WINDOWS = ["7d", "30d", "90d"] as const;

export const GetSubnetYieldHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(YIELD_HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetYieldHistoryInput = z.infer<
  typeof GetSubnetYieldHistoryInputSchema
>;

export const GetSubnetYieldHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable(),
    point_count: z.int(),
    points: OpenObjectArraySchema,
  })
  .passthrough();
export type GetSubnetYieldHistoryOutput = z.infer<
  typeof GetSubnetYieldHistoryOutputSchema
>;
