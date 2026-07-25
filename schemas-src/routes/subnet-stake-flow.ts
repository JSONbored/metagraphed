// GET /api/v1/subnets/{netuid}/stake-flow (types-epic B batch 2, #8056).
// Live account_events-tier aggregate -- no static file. Modeled from
// src/stake-flow.ts's buildStakeFlow(), cross-checked against the
// hand-edited SubnetStakeFlowArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SubnetStakeFlowArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["7d", "30d", "90d"]).nullable(),
    total_staked_tao: z.number(),
    total_unstaked_tao: z.number(),
    net_flow_tao: z.number(),
    stake_events: z.int().min(0),
    unstake_events: z.int().min(0),
  })
  .strict();
export type SubnetStakeFlowArtifact = z.infer<
  typeof SubnetStakeFlowArtifactSchema
>;
export const SubnetStakeFlowResponseSchema = successEnvelopeSchema(
  SubnetStakeFlowArtifactSchema,
);

export const SubnetStakeFlowQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
    direction: z.enum(["all", "in", "out"]).optional(),
  })
  .strict();
export type SubnetStakeFlowQuery = z.infer<typeof SubnetStakeFlowQuerySchema>;
