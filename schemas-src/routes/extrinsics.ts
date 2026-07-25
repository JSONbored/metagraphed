// GET /api/v1/extrinsics + /api/v1/extrinsics/{hash} (types-epic B batch 7,
// #8061). Live extrinsics D1-tier data -- no static file. Modeled from
// src/extrinsics.ts's buildExtrinsicFeed()/buildExtrinsic(), cross-checked
// against the hand-edited ExtrinsicsFeedArtifact/ExtrinsicDetailArtifact
// components they replace.
//
// ExtrinsicSchema is exported (not just registered) so block-extrinsics.ts,
// sudo.ts, and governance-config-changes.ts can reuse it directly.
// ExtrinsicsFeedArtifactSchema is likewise exported for sudo.ts/
// governance-config-changes.ts, which serve the IDENTICAL shape
// (buildExtrinsicFeed hardcoded to call_module='Sudo'/'AdminUtils' -- the
// hand-edited OpenAPI document itself $refs the same ExtrinsicsFeedArtifact
// component from all three paths, verified via repo-wide $ref grep).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { AccountEventSchema } from "./subnet-events.ts";

export const ExtrinsicSchema = z
  .object({
    block_number: z.int().min(0).nullable(),
    extrinsic_index: z.int().min(0).nullable(),
    extrinsic_hash: z.string().nullable(),
    signer: z.string().nullable(),
    call_module: z.string().nullable(),
    call_function: z.string().nullable(),
    call_args: z
      .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
      .nullable(),
    success: z.boolean().nullable(),
    fee_tao: z.number().nullable(),
    tip_tao: z.number().nullable(),
    observed_at: z.string().nullable(),
  })
  .strict();

export const ExtrinsicsFeedArtifactSchema = z
  .object({
    schema_version: z.int(),
    extrinsic_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    next_cursor: z.string().nullable(),
    extrinsics: z.array(ExtrinsicSchema),
  })
  .passthrough();
export type ExtrinsicsFeedArtifact = z.infer<
  typeof ExtrinsicsFeedArtifactSchema
>;
export const ExtrinsicsFeedResponseSchema = successEnvelopeSchema(
  ExtrinsicsFeedArtifactSchema,
);
export const ExtrinsicsFeedQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    signer: z.string().optional(),
    call_module: z.string().optional(),
    call_function: z.string().optional(),
    call_hash: z.string().optional(),
    block: z.int().min(0).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    success: z.enum(["true", "false"]).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ExtrinsicsFeedQuery = z.infer<typeof ExtrinsicsFeedQuerySchema>;

export const ExtrinsicDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    extrinsic: ExtrinsicSchema.nullable(),
    events: z.array(AccountEventSchema),
  })
  .passthrough();
export type ExtrinsicDetailArtifact = z.infer<
  typeof ExtrinsicDetailArtifactSchema
>;
export const ExtrinsicDetailResponseSchema = successEnvelopeSchema(
  ExtrinsicDetailArtifactSchema,
);
export const ExtrinsicDetailQuerySchema = z.object({}).strict();
export type ExtrinsicDetailQuery = z.infer<typeof ExtrinsicDetailQuerySchema>;
