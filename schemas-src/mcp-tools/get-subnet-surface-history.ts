// MCP tool `get_subnet_surface_history`.
// Mirrors GET /api/v1/subnets/{netuid}/surface-history.
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
import { limitSchema, netuidSchema } from "./shared.ts";
import {
  SURFACE_HISTORY_LIMIT_DEFAULT,
  SURFACE_HISTORY_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { SubnetSurfaceHistoryArtifactSchema } from "../routes/subnet-surface-history.ts";

export const GetSubnetSurfaceHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    limit: limitSchema(
      SURFACE_HISTORY_LIMIT_MAX,
      SURFACE_HISTORY_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetSubnetSurfaceHistoryInput = z.infer<
  typeof GetSubnetSurfaceHistoryInputSchema
>;

export const GetSubnetSurfaceHistoryOutputSchema =
  SubnetSurfaceHistoryArtifactSchema;
export type GetSubnetSurfaceHistoryOutput = z.infer<
  typeof GetSubnetSurfaceHistoryOutputSchema
>;
