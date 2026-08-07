// MCP tools `get_subnet_lease`, `get_subnet_lease_history`.
// Mirror GET /api/v1/subnets/{netuid}/lease, GET
// /api/v1/subnets/{netuid}/lease/history.
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
import { netuidSchema } from "./shared.ts";
import { McpNetworkSchema } from "../shared.ts";
import {
  SubnetLeaseArtifactSchema,
  SubnetLeaseHistoryArtifactSchema,
} from "../routes/subnet-lease.ts";

export const GetSubnetLeaseInputSchema = z
  .object({
    netuid: netuidSchema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSubnetLeaseInput = z.infer<typeof GetSubnetLeaseInputSchema>;

export const GetSubnetLeaseOutputSchema = SubnetLeaseArtifactSchema;
export type GetSubnetLeaseOutput = z.infer<typeof GetSubnetLeaseOutputSchema>;

export const GetSubnetLeaseHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetLeaseHistoryInput = z.infer<
  typeof GetSubnetLeaseHistoryInputSchema
>;

export const GetSubnetLeaseHistoryOutputSchema =
  SubnetLeaseHistoryArtifactSchema;
export type GetSubnetLeaseHistoryOutput = z.infer<
  typeof GetSubnetLeaseHistoryOutputSchema
>;
