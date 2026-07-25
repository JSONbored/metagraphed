// MCP tools `get_chain_transfers`, `get_chain_transfer_pairs` (types-epic E
// batch 9, #8072). Each mirrors a GET /api/v1/chain/transfer{s,-pairs} route
// that is not one of schemas-src/routes/'s covered pilot routes -- no
// existing Zod schema to reuse. Both hand-written originals are
// additionalProperties:false (strict) at the top level, unlike the
// additionalProperties:true posture most tools in this epic use -- modeled
// here with the same strictness. Their `window` fields are a REQUIRED but
// NULLABLE enum (`type:["string","null"], enum:[...windows, null]`) --
// `z.enum(...).nullable()`, not `.optional()`.
import { z } from "zod";

const WINDOWS_2 = ["7d", "30d"] as const;

// Mirrors mcp-server.ts's shared CHAIN_TRANSFER_PARTY_ITEM object literal
// (this batch's last consumer -- get_chain_transfer_pairs.pairs items have
// their own distinct shape, not this one).
const ChainTransferPartySchema = z
  .object({
    address: z.string(),
    volume_tao: z.number(),
    transfer_count: z.int().min(0),
  })
  .strict();

export const GetChainTransfersInputSchema = z
  .object({
    window: z.enum(WINDOWS_2).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type GetChainTransfersInput = z.infer<
  typeof GetChainTransfersInputSchema
>;

export const GetChainTransfersOutputSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(WINDOWS_2).nullable(),
    observed_at: z.string().nullable(),
    total_volume_tao: z.number(),
    transfer_count: z.int().min(0),
    unique_senders: z.int().min(0),
    unique_receivers: z.int().min(0),
    top_sender_share: z.number().nullable(),
    top_senders: z.array(ChainTransferPartySchema),
    top_receivers: z.array(ChainTransferPartySchema),
  })
  .strict();
export type GetChainTransfersOutput = z.infer<
  typeof GetChainTransfersOutputSchema
>;

export const GetChainTransferPairsInputSchema = z
  .object({
    window: z.enum(WINDOWS_2).optional(),
    sort: z.enum(["volume", "count"]).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type GetChainTransferPairsInput = z.infer<
  typeof GetChainTransferPairsInputSchema
>;

const ChainTransferPairSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    volume_tao: z.number(),
    transfer_count: z.int().min(0),
    last_block: z.int().nullable(),
    last_observed_at: z.string().nullable(),
  })
  .strict();

export const GetChainTransferPairsOutputSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(WINDOWS_2).nullable(),
    sort: z.enum(["volume", "count"]),
    observed_at: z.string().nullable(),
    total_volume_tao: z.number(),
    transfer_count: z.int().min(0),
    unique_pairs: z.int().min(0),
    pair_count: z.int().min(0),
    top_pair_share: z.number().nullable(),
    pairs: z.array(ChainTransferPairSchema),
  })
  .strict();
export type GetChainTransferPairsOutput = z.infer<
  typeof GetChainTransferPairsOutputSchema
>;
