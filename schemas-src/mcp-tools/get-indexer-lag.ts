// MCP tool `get_indexer_lag`.
// Mirrors GET /api/v1/chain/indexer-lag.
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
import { IndexerLagArtifactSchema } from "../routes/indexer-lag.ts";

/** No inputs: the route measures one window and has nothing to filter. */
export const GetIndexerLagInputSchema = z.object({}).strict();
export type GetIndexerLagInput = z.infer<typeof GetIndexerLagInputSchema>;

export const GetIndexerLagOutputSchema = IndexerLagArtifactSchema;
export type GetIndexerLagOutput = z.infer<typeof GetIndexerLagOutputSchema>;
