// MCP tool `get_subnet_identity_history`.
// Mirrors GET /api/v1/subnets/{netuid}/identity-history.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetIdentityHistoryArtifactSchema } from "../routes/subnet-identity-history.ts";

const RouteQuery_subnets_netuid_identity_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/identity-history"];

export const GetSubnetIdentityHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    limit: RouteQuery_subnets_netuid_identity_history.shape.limit,
    offset: RouteQuery_subnets_netuid_identity_history.shape.offset,
    cursor: RouteQuery_subnets_netuid_identity_history.shape.cursor,
  })
  .strict();
export type GetSubnetIdentityHistoryInput = z.infer<
  typeof GetSubnetIdentityHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- except
// identity_hash, which the original also required (see header).
export const GetSubnetIdentityHistoryOutputSchema =
  SubnetIdentityHistoryArtifactSchema;
export type GetSubnetIdentityHistoryOutput = z.infer<
  typeof GetSubnetIdentityHistoryOutputSchema
>;
