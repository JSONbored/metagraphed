// MCP tools `get_network_parameters`, `get_randomness_status`.
// Mirror GET /api/v1/network/parameters, GET /api/v1/network/randomness.
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
import { McpNetworkSchema } from "../shared.ts";
import {
  NetworkParametersArtifactSchema,
  RandomnessArtifactSchema,
} from "../routes/network-singletons.ts";

export const GetNetworkParametersInputSchema = z
  .object({
    // #8700: which chain to read. Absent means finney, so every existing
    // caller is unchanged. These routes answer from live storage whose keys
    // are chain-agnostic twox128 hashes — only the endpoint varies.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetNetworkParametersInput = z.infer<
  typeof GetNetworkParametersInputSchema
>;

export const GetNetworkParametersOutputSchema = NetworkParametersArtifactSchema;
export type GetNetworkParametersOutput = z.infer<
  typeof GetNetworkParametersOutputSchema
>;

export const GetRandomnessStatusInputSchema = z
  .object({
    // #8700: which chain to read. Absent means finney, so every existing
    // caller is unchanged. These routes answer from live storage whose keys
    // are chain-agnostic twox128 hashes — only the endpoint varies.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetRandomnessStatusInput = z.infer<
  typeof GetRandomnessStatusInputSchema
>;

export const GetRandomnessStatusOutputSchema = RandomnessArtifactSchema;
export type GetRandomnessStatusOutput = z.infer<
  typeof GetRandomnessStatusOutputSchema
>;
