// get_subnet_miner_fairness (#10931).
//
// Input DERIVED from the route's query schema, output IS the route's artifact
// schema by identity — never re-modelled.
//
// The tool description carries the "no grade" rule explicitly, because this is
// the surface most likely to be turned into one: an agent handed a Gini and a
// zero rate will reach for "unfair" unless told not to.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetMinerFairnessArtifactSchema } from "../routes/miner-fairness.ts";

const RouteQuery_subnets_netuid_miner_fairness =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/miner-fairness"];

export const GetSubnetMinerFairnessInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_miner_fairness.shape.window,
  })
  .strict();

export const GetSubnetMinerFairnessOutputSchema =
  SubnetMinerFairnessArtifactSchema;
