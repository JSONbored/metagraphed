// GET /api/v1/chain/transfer-pairs + .../transfers (types-epic B batch 6,
// #8060). Live account_events Transfer-stream data -- no static file.
// Modeled from src/chain-transfer-pairs.ts's buildChainTransferPairs() and
// src/chain-transfers.ts's buildChainTransfers(), cross-checked against the
// hand-edited ChainTransferPairsArtifact/ChainTransfersArtifact components
// they replace.
//
// ChainTransferPair/ChainTransferParty are intentionally NOT registered as
// shared components -- each is referenced only by the one hand-edited
// component this batch replaces (verified via repo-wide $ref grep; note
// ChainTransferParty is reused for BOTH top_senders[] and top_receivers[]
// within ChainTransfersArtifact itself, but that's an intra-batch reuse, not
// a cross-component one), so both hand-edited component keys become fully
// orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ChainTransferPairSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    volume_tao: z.number().min(0),
    transfer_count: z.int().min(0),
    last_block: z.int().min(0).nullable(),
    last_observed_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One directed sender -> receiver corridor on the transfer-pairs leaderboard.",
  );

export const ChainTransferPairsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    sort: z
      .enum(["volume", "count"])
      .describe("The rank order actually applied: volume or count."),
    observed_at: z.string().nullable(),
    total_volume_tao: z.number().min(0),
    transfer_count: z.int().min(0),
    unique_pairs: z.int().min(0),
    pair_count: z.int().min(0),
    top_pair_share: z
      .number()
      .nullable()
      .describe(
        "Highest-volume corridor's share of total pairable volume; null when the window has no pairable volume.",
      ),
    pairs: z.array(ChainTransferPairSchema),
  })
  .strict()
  .describe(
    "Network-wide directed native-TAO transfer-corridor leaderboard over a lookback window. Mirrors GET /api/v1/chain/transfer-pairs's data envelope.",
  );
export type ChainTransferPairsArtifact = z.infer<
  typeof ChainTransferPairsArtifactSchema
>;
export const ChainTransferPairsResponseSchema = successEnvelopeSchema(
  ChainTransferPairsArtifactSchema,
);

const ChainTransferPartySchema = z
  .object({
    address: z.string(),
    volume_tao: z.number(),
    transfer_count: z.int().min(0),
  })
  .strict()
  .describe("One account on a chain-transfers sender/receiver leaderboard.");

export const ChainTransfersArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    observed_at: z.string().nullable(),
    total_volume_tao: z.number(),
    transfer_count: z.int().min(0),
    unique_senders: z.int().min(0),
    unique_receivers: z.int().min(0),
    top_sender_share: z
      .number()
      .nullable()
      .describe(
        "Top senders' combined share of total volume; null when total volume is 0.",
      ),
    top_senders: z.array(ChainTransferPartySchema),
    top_receivers: z.array(ChainTransferPartySchema),
  })
  .strict()
  .describe(
    "Network-wide native-TAO transfer analytics over a lookback window. Mirrors GET /api/v1/chain/transfers's data envelope.",
  );
export type ChainTransfersArtifact = z.infer<
  typeof ChainTransfersArtifactSchema
>;
export const ChainTransfersResponseSchema = successEnvelopeSchema(
  ChainTransfersArtifactSchema,
);
