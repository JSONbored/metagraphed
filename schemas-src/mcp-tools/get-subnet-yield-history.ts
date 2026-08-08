// MCP tool `get_subnet_yield_history`.
// Mirrors GET /api/v1/subnets/{netuid}/yield/history.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_yield_history: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetYieldHistoryArtifactSchema } from "../routes/subnet-yield.ts";

const RouteQuery_subnets_netuid_yield_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/yield/history"];

export const GetSubnetYieldHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_yield_history.shape.window,
  })
  .strict();
export type GetSubnetYieldHistoryInput = z.infer<
  typeof GetSubnetYieldHistoryInputSchema
>;

export const GetSubnetYieldHistoryOutputSchema =
  SubnetYieldHistoryArtifactSchema;
export type GetSubnetYieldHistoryOutput = z.infer<
  typeof GetSubnetYieldHistoryOutputSchema
>;
