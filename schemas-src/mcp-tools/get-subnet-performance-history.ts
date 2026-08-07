// MCP tool `get_subnet_performance_history` (types-epic E batch 3, #8066).
// Mirrors GET /api/v1/subnets/{netuid}/performance/history, which is not
// one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, shallow, from the hand-written literal it
// replaces.
import { z } from "zod";
import { SubnetPerformanceHistoryArtifactSchema } from "../routes/subnet-performance.ts";
import { netuidSchema, windowSchema } from "./shared.ts";

const PERFORMANCE_HISTORY_WINDOWS = ["7d", "30d", "90d"] as const;

export const GetSubnetPerformanceHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(PERFORMANCE_HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetPerformanceHistoryInput = z.infer<
  typeof GetSubnetPerformanceHistoryInputSchema
>;

// DERIVED, NOT COPIED (#9796). The copy published `points` as a bare open
// array -- the whole time series, with nothing said about a point.
export const GetSubnetPerformanceHistoryOutputSchema =
  SubnetPerformanceHistoryArtifactSchema;
export type GetSubnetPerformanceHistoryOutput = z.infer<
  typeof GetSubnetPerformanceHistoryOutputSchema
>;
