// MCP tools `get_subnet_revenue` and `list_revenue_coverage` (#10475).
// Mirror GET /api/v1/subnets/{netuid}/revenue and
// GET /api/v1/chain/revenue-coverage.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796): each output schema IS the route's
// own ArtifactSchema, so a field rename is a compile error here rather than
// silent production drift.
//
// The reason these tools matter more than most: an agent asked "how much does
// SN64 earn" will quote whatever number it is handed. The output carries
// `provenance` as a required field on every figure and nulls the ratios
// whenever revenue is not observed, so there is no shape in which a caller
// receives a revenue number without its evidence class, and none in which
// "not observed" can be mistaken for zero.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import {
  ChainRevenueCoverageArtifactSchema,
  SubnetRevenueArtifactSchema,
} from "../routes/revenue-coverage.ts";

// #10925: `window` is pulled off the ROUTE's own query schema rather than
// restated, so the three surfaces cannot disagree about which windows exist.
const RouteQuery_subnets_netuid_revenue =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/revenue"];
const RouteQuery_chain_revenue_coverage =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/revenue-coverage"];

export const GetSubnetRevenueInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_revenue.shape.window,
  })
  .strict();
export type GetSubnetRevenueInput = z.infer<typeof GetSubnetRevenueInputSchema>;

export const GetSubnetRevenueOutputSchema = SubnetRevenueArtifactSchema;
export type GetSubnetRevenueOutput = z.infer<
  typeof GetSubnetRevenueOutputSchema
>;

export const ListRevenueCoverageInputSchema = z
  .object({ window: RouteQuery_chain_revenue_coverage.shape.window })
  .strict();
export type ListRevenueCoverageInput = z.infer<
  typeof ListRevenueCoverageInputSchema
>;

export const ListRevenueCoverageOutputSchema =
  ChainRevenueCoverageArtifactSchema;
export type ListRevenueCoverageOutput = z.infer<
  typeof ListRevenueCoverageOutputSchema
>;
