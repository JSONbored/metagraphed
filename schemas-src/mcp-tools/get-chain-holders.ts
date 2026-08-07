// MCP tool `get_chain_holders`.
// Mirrors GET /api/v1/chain/holders.
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
import { limitSchema, sortSchema } from "./shared.ts";
import {
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { ChainHoldersArtifactSchema } from "../routes/chain-holders.ts";

export const GetChainHoldersInputSchema = z
  .object({
    sort: sortSchema([
      "top1_share",
      "top5_share",
      "top10_share",
      "top20_share",
      "holder_count",
      "total_alpha",
    ]).optional(),
    limit: limitSchema(
      CHAIN_HOLDERS_LIMIT_MAX,
      CHAIN_HOLDERS_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetChainHoldersInput = z.infer<typeof GetChainHoldersInputSchema>;

export const GetChainHoldersOutputSchema = ChainHoldersArtifactSchema;
export type GetChainHoldersOutput = z.infer<typeof GetChainHoldersOutputSchema>;
