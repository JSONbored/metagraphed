// MCP tool `get_subnet_performance_history` (types-epic E batch 3, #8066).
// Mirrors GET /api/v1/subnets/{netuid}/performance/history, which is not
// one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, shallow, from the hand-written literal it
// replaces.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

const PERFORMANCE_HISTORY_WINDOWS = ["7d", "30d", "90d"] as const;

export const GetSubnetPerformanceHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(PERFORMANCE_HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetPerformanceHistoryInput = z.infer<
  typeof GetSubnetPerformanceHistoryInputSchema
>;

export const GetSubnetPerformanceHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable(),
    point_count: z.int(),
    points: OpenObjectArraySchema,
  })
  .passthrough();
export type GetSubnetPerformanceHistoryOutput = z.infer<
  typeof GetSubnetPerformanceHistoryOutputSchema
>;
