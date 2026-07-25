// GET /api/v1/accounts/{ss58}/extrinsics (types-epic B batch 5, #8059). Live
// extrinsics D1-tier data -- no static file. Modeled from src/extrinsics.ts's
// buildAccountExtrinsics()/formatExtrinsic(), cross-checked against the
// hand-edited AccountExtrinsicsArtifact component it replaces.
//
// ExtrinsicSchema below is a LOCAL, UNREGISTERED copy of the hand-edited
// `Extrinsic` component's shape -- Extrinsic itself is NOT converted or
// deleted in this batch: it has 4 referrers across schemas/components/
// *.schema.json (verified via repo-wide $ref grep) -- AccountExtrinsicsArtifact
// plus 3 block/extrinsic-detail routes that are out of scope for this batch
// (types-epic B batch 7 covers blocks/extrinsics/validators). The hand-edited
// `Extrinsic` component key stays in schemas/components/*.schema.json,
// untouched, for those other routes to keep resolving. This route's own
// `extrinsics[]` is a local inline copy (cosmetic $ref-vs-inline difference
// vs the hand-edited AccountExtrinsicsArtifact, same pattern as batch 4's
// AccountPortfolioArtifact.stake_concentration).
//
// Real finding (bucket a): `limit`/`offset` were initially modeled
// `.nullable()` (matching buildAccountExtrinsics()'s own `limit ?? null` TS
// signature), but handleAccountExtrinsics resolves them via
// workers/request-params.ts's parsePagination(), which always returns real
// numbers -- same finding as account-events-feed.ts's 3 routes. Fixed to
// required non-nullable integers.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ExtrinsicSchema = z
  .object({
    block_number: z.int().nullable(),
    extrinsic_index: z.int().nullable(),
    extrinsic_hash: z.string().nullable().optional(),
    signer: z.string().nullable().optional(),
    call_module: z.string().nullable().optional(),
    call_function: z.string().nullable().optional(),
    call_args: z.unknown().nullable().optional(),
    fee_tao: z.number().nullable().optional(),
    tip_tao: z.number().nullable().optional(),
    success: z.boolean().nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .strict();

export const AccountExtrinsicsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    extrinsic_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicSchema),
  })
  .passthrough();
export type AccountExtrinsicsArtifact = z.infer<
  typeof AccountExtrinsicsArtifactSchema
>;
export const AccountExtrinsicsResponseSchema = successEnvelopeSchema(
  AccountExtrinsicsArtifactSchema,
);
export const AccountExtrinsicsQuerySchema = z
  .object({
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type AccountExtrinsicsQuery = z.infer<
  typeof AccountExtrinsicsQuerySchema
>;
