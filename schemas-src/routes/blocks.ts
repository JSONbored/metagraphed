// GET /api/v1/blocks + /api/v1/blocks/{ref} (types-epic B batch 7, #8061).
// Live blocks D1-tier data -- no static file. Modeled from src/blocks.ts's
// buildBlockFeed()/buildBlock(), cross-checked against the hand-edited
// BlocksFeedArtifact/BlockDetailArtifact components they replace.
//
// Block is intentionally NOT registered as a shared component -- both its
// referrers (BlocksFeedArtifact, BlockDetailArtifact) are converted together
// in this same batch (verified via repo-wide $ref grep), so the hand-edited
// Block component key becomes fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const BlockSchema = z
  .object({
    block_number: z.int().min(0).nullable(),
    block_hash: z.string().nullable(),
    parent_hash: z.string().nullable(),
    author: z.string().nullable(),
    extrinsic_count: z.int().min(0).nullable(),
    event_count: z.int().min(0).nullable(),
    spec_version: z.int().min(0).nullable(),
    observed_at: z.string().nullable(),
  })
  .strict();

export const BlocksFeedArtifactSchema = z
  .object({
    schema_version: z.int(),
    block_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    next_cursor: z.string().nullable(),
    blocks: z.array(BlockSchema),
  })
  .passthrough();
export type BlocksFeedArtifact = z.infer<typeof BlocksFeedArtifactSchema>;
export const BlocksFeedResponseSchema = successEnvelopeSchema(
  BlocksFeedArtifactSchema,
);
export const BlocksFeedQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    author: z.string().optional(),
    spec_version: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    min_extrinsics: z.int().min(0).optional(),
    min_events: z.int().min(0).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type BlocksFeedQuery = z.infer<typeof BlocksFeedQuerySchema>;

export const BlockDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    block: BlockSchema.nullable(),
    prev_block_number: z.int().min(0).nullable(),
    next_block_number: z.int().min(0).nullable(),
  })
  .passthrough();
export type BlockDetailArtifact = z.infer<typeof BlockDetailArtifactSchema>;
export const BlockDetailResponseSchema = successEnvelopeSchema(
  BlockDetailArtifactSchema,
);
export const BlockDetailQuerySchema = z.object({}).strict();
export type BlockDetailQuery = z.infer<typeof BlockDetailQuerySchema>;
