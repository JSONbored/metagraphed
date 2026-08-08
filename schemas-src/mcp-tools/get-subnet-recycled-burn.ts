// MCP tools `get_subnet_recycled`, `get_subnet_burn`,
// `get_subnet_burn_history`, `get_chain_burn`.
// Mirror GET /api/v1/subnets/{netuid}/recycled, GET
// /api/v1/subnets/{netuid}/burn, GET /api/v1/subnets/{netuid}/burn/history, GET
// /api/v1/chain/burn.
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
import { McpNetworkSchema } from "../shared.ts";
import {
  ChainBurnArtifactSchema,
  SubnetBurnArtifactSchema,
  SubnetBurnHistoryArtifactSchema,
  SubnetRecycledArtifactSchema,
} from "../routes/subnet-registration-cost.ts";

const RouteQuery_subnets_netuid_burn_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/burn/history"];

export const GetSubnetRecycledInputSchema = z
  .object({
    netuid: netuidSchema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSubnetRecycledInput = z.infer<
  typeof GetSubnetRecycledInputSchema
>;

export const GetSubnetRecycledOutputSchema = SubnetRecycledArtifactSchema;
export type GetSubnetRecycledOutput = z.infer<
  typeof GetSubnetRecycledOutputSchema
>;

export const GetSubnetBurnInputSchema = z
  .object({
    netuid: netuidSchema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSubnetBurnInput = z.infer<typeof GetSubnetBurnInputSchema>;

export const GetSubnetBurnOutputSchema = SubnetBurnArtifactSchema;
export type GetSubnetBurnOutput = z.infer<typeof GetSubnetBurnOutputSchema>;

// #9399: the cross-subnet ranking. No netuid -- that is the point of it.
export const GetChainBurnInputSchema = z
  .object({
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetChainBurnInput = z.infer<typeof GetChainBurnInputSchema>;

export const GetChainBurnOutputSchema = ChainBurnArtifactSchema;
export type GetChainBurnOutput = z.infer<typeof GetChainBurnOutputSchema>;

// #9402: one subnet's registration-cost series.
export const GetSubnetBurnHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_burn_history.shape.window,
  })
  .strict();
export type GetSubnetBurnHistoryInput = z.infer<
  typeof GetSubnetBurnHistoryInputSchema
>;

export const GetSubnetBurnHistoryOutputSchema = SubnetBurnHistoryArtifactSchema;
export type GetSubnetBurnHistoryOutput = z.infer<
  typeof GetSubnetBurnHistoryOutputSchema
>;
