// GET /api/v1/subnets/{netuid}/conviction (types-epic B batch 2, #8056).
// Live subnet_locks-tier + live-RPC rates -- no static file. Modeled from
// src/subnet-conviction.ts's buildSubnetConviction(), cross-checked against
// the hand-edited SubnetConvictionArtifact/SubnetConvictionEntry components
// it replaces. No query params (verified: the DATA_API route reads only the
// netuid path segment).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetConvictionEntrySchema = z
  .object({
    hotkey: z.string().optional(),
    is_owner: z.boolean().optional(),
    locked_mass: z.number().optional(),
    conviction: z.number().optional(),
  })
  .strict();

export const SubnetConvictionArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    queried_at_block: z.int().nullable().optional(),
    unlock_rate: z.int().nullable().optional(),
    maturity_rate: z.int().nullable().optional(),
    king: z.string().nullable().optional(),
    count: z.int().min(0),
    leaderboard: z.array(SubnetConvictionEntrySchema),
  })
  .passthrough();
export type SubnetConvictionArtifact = z.infer<
  typeof SubnetConvictionArtifactSchema
>;
export const SubnetConvictionResponseSchema = successEnvelopeSchema(
  SubnetConvictionArtifactSchema,
);
export const SubnetConvictionQuerySchema = z.object({}).strict();
export type SubnetConvictionQuery = z.infer<typeof SubnetConvictionQuerySchema>;
