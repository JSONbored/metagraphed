// MCP tools `get_subnet_hyperparams`, `get_subnet_hyperparams_history`.
// Mirror GET /api/v1/subnets/{netuid}/hyperparameters, GET
// /api/v1/subnets/{netuid}/hyperparameters/history.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_hyperparams: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  keysetCursorSchema,
  limitSchema,
  netuidSchema,
  offsetSchema,
} from "./shared.ts";
import {
  SubnetHyperparametersArtifactSchema,
  SubnetHyperparamsHistoryArtifactSchema,
} from "../routes/subnet-hyperparameters.ts";

export const GetSubnetHyperparamsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetHyperparamsInput = z.infer<
  typeof GetSubnetHyperparamsInputSchema
>;

export const GetSubnetHyperparamsOutputSchema =
  SubnetHyperparametersArtifactSchema;
export type GetSubnetHyperparamsOutput = z.infer<
  typeof GetSubnetHyperparamsOutputSchema
>;

export const GetSubnetHyperparamsHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetSubnetHyperparamsHistoryInput = z.infer<
  typeof GetSubnetHyperparamsHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetHyperparamsHistoryOutputSchema =
  SubnetHyperparamsHistoryArtifactSchema;
export type GetSubnetHyperparamsHistoryOutput = z.infer<
  typeof GetSubnetHyperparamsHistoryOutputSchema
>;
