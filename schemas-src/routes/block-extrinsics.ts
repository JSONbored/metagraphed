// GET /api/v1/blocks/{ref}/extrinsics (types-epic B batch 7, #8061). Live
// extrinsics D1-tier data -- no static file. Modeled from src/extrinsics.ts's
// buildBlockExtrinsics(), cross-checked against the hand-edited
// BlockExtrinsicsArtifact component it replaces. Reuses ExtrinsicSchema from
// extrinsics.ts (the same batch's own conversion of that route).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { ExtrinsicSchema } from "./extrinsics.ts";

export const BlockExtrinsicsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    extrinsic_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    extrinsics: z.array(ExtrinsicSchema),
  })
  .passthrough();
export type BlockExtrinsicsArtifact = z.infer<
  typeof BlockExtrinsicsArtifactSchema
>;
export const BlockExtrinsicsResponseSchema = successEnvelopeSchema(
  BlockExtrinsicsArtifactSchema,
);
export const BlockExtrinsicsQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type BlockExtrinsicsQuery = z.infer<typeof BlockExtrinsicsQuerySchema>;
