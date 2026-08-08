// MCP tool `get_subnet_performance_history` (types-epic E batch 3, #8066).
// Mirrors GET /api/v1/subnets/{netuid}/performance/history, which is not
// one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, shallow, from the hand-written literal it
// replaces.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { SubnetPerformanceHistoryArtifactSchema } from "../routes/subnet-performance.ts";
import { netuidSchema } from "./shared.ts";

const RouteQuery_subnets_netuid_performance_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/performance/history"];

export const GetSubnetPerformanceHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_performance_history.shape.window,
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
