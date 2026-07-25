// GET /api/v1/subnets/{netuid}/stake-transfers (types-epic B batch 2,
// #8056). Live account_events-tier aggregate -- no static file. Modeled
// from src/subnet-stake-transfers.ts's buildSubnetStakeTransfers(),
// cross-checked against the hand-edited SubnetStakeTransfersArtifact
// component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SubnetStakeTransfersArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.iso.datetime().nullable(),
    distinct_senders: z.int().min(0),
    transfers: z.int().min(0),
    transfers_per_sender: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetStakeTransfersArtifact = z.infer<
  typeof SubnetStakeTransfersArtifactSchema
>;
export const SubnetStakeTransfersResponseSchema = successEnvelopeSchema(
  SubnetStakeTransfersArtifactSchema,
);

export const SubnetStakeTransfersQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
  })
  .strict();
export type SubnetStakeTransfersQuery = z.infer<
  typeof SubnetStakeTransfersQuerySchema
>;
