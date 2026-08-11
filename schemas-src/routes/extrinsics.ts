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
    // #8525: deterministic human-readable action sentence for this
    // extrinsic's call, or null when no template matches
    // call_module.call_function -- never a guessed/partial sentence.
    summary: z.string().nullable(),
  })
  .strict();

export const ExtrinsicsFeedArtifactSchema = z
  .object({
    schema_version: z.int(),
    extrinsic_count: z.int().min(0),
    // NULLABLE, and this is not defensive (#9796). The REST layer defaults
    // `limit`/`offset` before the loader runs, so a live route response always
    // carries integers -- which is why validate:api never saw this. The same
    // loader also serves the MCP tool, which passes the caller's arguments
    // straight through, and an omitted limit reaches it as undefined:
    // `limit: limit ?? null` then emits null. The contract said that was
    // impossible.
    limit: z.int().nullable(),
    offset: z.int().nullable(),
    next_cursor: z.string().nullable(),
    extrinsics: z.array(ExtrinsicSchema),
  })
  .strict();
export type ExtrinsicsFeedArtifact = z.infer<
  typeof ExtrinsicsFeedArtifactSchema
>;

export const ExtrinsicDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    extrinsic: ExtrinsicSchema.nullable(),
    events: z.array(AccountEventSchema),
  })
  .strict();
export type ExtrinsicDetailArtifact = z.infer<
  typeof ExtrinsicDetailArtifactSchema
>;
