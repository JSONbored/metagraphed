// MCP tools `get_chain_transfers`, `get_chain_transfer_pairs`.
// Mirror GET /api/v1/chain/transfers, GET /api/v1/chain/transfer-pairs.
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
import { limitSchema, sortSchema, windowSchema } from "./shared.ts";
import {
  ChainTransferPairsArtifactSchema,
  ChainTransfersArtifactSchema,
} from "../routes/chain-transfers.ts";

const WINDOWS_2 = ["7d", "30d"] as const;

// Mirrors mcp-server.ts's shared CHAIN_TRANSFER_PARTY_ITEM object literal
// (this batch's last consumer -- get_chain_transfer_pairs.pairs items have
// their own distinct shape, not this one).
export const GetChainTransfersInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(100).optional(),
  })
  .strict();
export type GetChainTransfersInput = z.infer<
  typeof GetChainTransfersInputSchema
>;

export const GetChainTransfersOutputSchema = ChainTransfersArtifactSchema;
export type GetChainTransfersOutput = z.infer<
  typeof GetChainTransfersOutputSchema
>;

export const GetChainTransferPairsInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    sort: sortSchema(["volume", "count"]).optional(),
    limit: limitSchema(100).optional(),
  })
  .strict();
export type GetChainTransferPairsInput = z.infer<
  typeof GetChainTransferPairsInputSchema
>;

export const GetChainTransferPairsOutputSchema =
  ChainTransferPairsArtifactSchema;
export type GetChainTransferPairsOutput = z.infer<
  typeof GetChainTransferPairsOutputSchema
>;
