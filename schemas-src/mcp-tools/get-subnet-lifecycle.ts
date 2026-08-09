// MCP tools `get_subnet_lifecycle`, `get_chain_subnet_lifecycle`.
// Mirror GET /api/v1/subnets/{netuid}/lifecycle, GET
// /api/v1/chain/subnet-lifecycle.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796, #10263). The inputs are built from
// the same ROUTE_QUERY_SCHEMAS entries the REST routes publish, and each output
// schema IS the route's own ArtifactSchema -- so a field rename is a compile
// error here rather than silent drift between the two surfaces.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import {
  ChainSubnetLifecycleArtifactSchema,
  SubnetLifecycleArtifactSchema,
} from "../routes/subnet-lifecycle.ts";

const RouteQuery_subnets_netuid_lifecycle =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/lifecycle"];
const RouteQuery_chain_subnet_lifecycle =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/subnet-lifecycle"];

export const GetSubnetLifecycleInputSchema = z
  .object({
    netuid: netuidSchema(),
    // The MCP narrowing of the route's ceiling, declared rather than silently
    // different: an agent paying per token wants a page it can read, and this
    // table is small enough that 100 is almost always the whole history.
    limit: RouteQuery_subnets_netuid_lifecycle.shape.limit.meta({
      default: 100,
    }),
    offset: RouteQuery_subnets_netuid_lifecycle.shape.offset,
  })
  .strict();
export type GetSubnetLifecycleInput = z.infer<
  typeof GetSubnetLifecycleInputSchema
>;

export const GetSubnetLifecycleOutputSchema = SubnetLifecycleArtifactSchema;
export type GetSubnetLifecycleOutput = z.infer<
  typeof GetSubnetLifecycleOutputSchema
>;

export const GetChainSubnetLifecycleInputSchema = z
  .object({
    window: RouteQuery_chain_subnet_lifecycle.shape.window,
    limit: RouteQuery_chain_subnet_lifecycle.shape.limit.meta({ default: 100 }),
  })
  .strict();
export type GetChainSubnetLifecycleInput = z.infer<
  typeof GetChainSubnetLifecycleInputSchema
>;

export const GetChainSubnetLifecycleOutputSchema =
  ChainSubnetLifecycleArtifactSchema;
export type GetChainSubnetLifecycleOutput = z.infer<
  typeof GetChainSubnetLifecycleOutputSchema
>;
