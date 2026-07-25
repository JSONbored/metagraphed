// GET /api/v1/subnets/{netuid}/stake-moves (types-epic B batch 2, #8056).
// Live account_events-tier aggregate -- no static file. Modeled from
// src/subnet-stake-moves.ts's buildSubnetStakeMoves(), cross-checked
// against the hand-edited SubnetStakeMovesArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SubnetStakeMovesArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.iso.datetime().nullable(),
    distinct_movers: z.int().min(0),
    movements: z.int().min(0),
    movements_per_mover: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetStakeMovesArtifact = z.infer<
  typeof SubnetStakeMovesArtifactSchema
>;
export const SubnetStakeMovesResponseSchema = successEnvelopeSchema(
  SubnetStakeMovesArtifactSchema,
);

export const SubnetStakeMovesQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
  })
  .strict();
export type SubnetStakeMovesQuery = z.infer<typeof SubnetStakeMovesQuerySchema>;
