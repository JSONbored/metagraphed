// MCP tools `get_chain_registrations`, `get_chain_deregistrations`.
// Mirror GET /api/v1/chain/registrations, GET /api/v1/chain/deregistrations.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_chain_registrations: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import {
  ChainDeregistrationsArtifactSchema,
  ChainRegistrationsArtifactSchema,
} from "../routes/chain-network-rollups.ts";

const RouteQuery_chain_registrations =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/registrations"];

const RouteQuery_chain_deregistrations =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/deregistrations"];

export const GetChainRegistrationsInputSchema = z
  .object({
    window: RouteQuery_chain_registrations.shape.window,
    limit: RouteQuery_chain_registrations.shape.limit,
  })
  .strict();
export type GetChainRegistrationsInput = z.infer<
  typeof GetChainRegistrationsInputSchema
>;

// Genuinely open (no additionalProperties:false, no required array in the
// hand-written original) -- see file header.
// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- unlike
// get_chain_deregistrations's strict items below.
export const GetChainRegistrationsOutputSchema =
  ChainRegistrationsArtifactSchema;
export type GetChainRegistrationsOutput = z.infer<
  typeof GetChainRegistrationsOutputSchema
>;

export const GetChainDeregistrationsInputSchema = z
  .object({
    window: RouteQuery_chain_deregistrations.shape.window,
    limit: RouteQuery_chain_deregistrations.shape.limit,
  })
  .strict();
export type GetChainDeregistrationsInput = z.infer<
  typeof GetChainDeregistrationsInputSchema
>;

export const GetChainDeregistrationsOutputSchema =
  ChainDeregistrationsArtifactSchema;
export type GetChainDeregistrationsOutput = z.infer<
  typeof GetChainDeregistrationsOutputSchema
>;
