// MCP tool `get_chain_identity_history`.
// Mirrors GET /api/v1/chain/identity-history.
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
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { limitSchema } from "./shared.ts";
import { ChainIdentityHistoryArtifactSchema } from "../routes/chain-identity-history.ts";

export const GetChainIdentityHistoryInputSchema = z
  .object({
    limit: limitSchema(
      CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
      CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetChainIdentityHistoryInput = z.infer<
  typeof GetChainIdentityHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetChainIdentityHistoryOutputSchema =
  ChainIdentityHistoryArtifactSchema;
export type GetChainIdentityHistoryOutput = z.infer<
  typeof GetChainIdentityHistoryOutputSchema
>;
