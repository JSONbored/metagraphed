// GET /api/v1/blocks + /api/v1/blocks/{ref} (types-epic B batch 7, #8061).
// Live blocks store-tier data -- no static file. Modeled from src/blocks.ts's
// buildBlockFeed()/buildBlock(), cross-checked against the hand-edited
// BlocksFeedArtifact/BlockDetailArtifact components they replace.
//
// Block is intentionally NOT registered as a shared component -- both its
// referrers (BlocksFeedArtifact, BlockDetailArtifact) are converted together
// in this same batch (verified via repo-wide $ref grep), so the hand-edited
// Block component key becomes fully orphaned.
import { z } from "zod";
import { EventStreamDegradedSchema } from "./event-stream-honesty.ts";
import { ALPHA_USD_UNAVAILABLE } from "../../src/alpha-usd.ts";

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
    decode_status: z.enum(["pending", "complete", "unavailable"]),
    native_transfer_tao: z.number().min(0).nullable(),
    stake_flow_tao: z.number().min(0).nullable(),
    economic_activity_tao: z.number().min(0).nullable(),
    fee_tao: z.number().min(0).nullable(),
    tip_tao: z.number().min(0).nullable(),
    issuance_tao: z.number().min(0).nullable(),
    subnet_ids: z.array(z.int().min(0)),
    economic_activity_usd: z.number().min(0).nullable(),
    usd_per_tao: z.number().positive().nullable(),
    tao_usd_block: z.int().min(0).nullable(),
    tao_usd_observed_at: z.string().nullable(),
    tao_usd_basis: z.string().nullable(),
    tao_usd_unavailable: z.enum(ALPHA_USD_UNAVAILABLE).optional(),
  })
  .strict();

export const BlocksFeedArtifactSchema = z
  .object({
    schema_version: z.int(),
    block_count: z.int().min(0),
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
    blocks: z.array(BlockSchema),
  })
  .strict();
export type BlocksFeedArtifact = z.infer<typeof BlocksFeedArtifactSchema>;

export const BlockDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    block: BlockSchema.nullable(),
    prev_block_number: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Nearest STORED lower block height for chain-walk nav (detail only); null at the start of the retained window or when the ref didn't resolve.",
      ),
    next_block_number: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Nearest STORED higher block height for chain-walk nav (detail only); null at the head of the retained window or when the ref didn't resolve.",
      ),
    degraded: EventStreamDegradedSchema.nullable()
      .optional()
      .describe(
        "Present ONLY on a decline. A null `block` WITHOUT this is a CONFIRMED ABSENCE -- the store was read and holds no such block, which is a measurement. With it, the read failed and nothing is known about whether the block exists.",
      ),
  })
  .strict();
export type BlockDetailArtifact = z.infer<typeof BlockDetailArtifactSchema>;
