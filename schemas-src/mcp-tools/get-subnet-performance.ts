// MCP tool `get_subnet_performance` (types-epic E batch 2, #8065). Mirrors
// GET /api/v1/subnets/{netuid}/performance.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Same story as its concentration
// sibling in this batch: the header claimed there was "no existing Zod schema
// to reuse", SubnetPerformanceArtifactSchema covers it, and the shallow copy
// published `incentive`, `dividends`, `trust`, `consensus` and
// `validator_trust` as bare open objects -- the five distributions this tool
// exists to report, each declared as {"type":"object"} and nothing more.
//
// Verified against production before the switch, because deriving is a
// tightening: the route schema is stricter than the copy was.
import { z } from "zod";
import { SubnetPerformanceArtifactSchema } from "../routes/subnet-performance.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetPerformanceInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetPerformanceInput = z.infer<
  typeof GetSubnetPerformanceInputSchema
>;

export const GetSubnetPerformanceOutputSchema = SubnetPerformanceArtifactSchema;
export type GetSubnetPerformanceOutput = z.infer<
  typeof GetSubnetPerformanceOutputSchema
>;
