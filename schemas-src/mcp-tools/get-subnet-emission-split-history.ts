// get_subnet_emission_split_history (#10928).
//
// The input is DERIVED from the route's own query schema and the output IS the
// route's artifact schema by identity — never re-modelled. A field renamed on
// the route is a compile error here, which is the only thing that keeps the
// MCP mirror from drifting away from what REST serves.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetEmissionSplitHistoryArtifactSchema } from "../routes/emission-split.ts";

const RouteQuery_subnets_netuid_emission_split_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/emission-split/history"];

export const GetSubnetEmissionSplitHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_emission_split_history.shape.window,
  })
  .strict();

export const GetSubnetEmissionSplitHistoryOutputSchema =
  SubnetEmissionSplitHistoryArtifactSchema;
