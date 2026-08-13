// The head-poller's wire schemas (#11008).
//
// LIVES HERE, not in src/head-poller.ts, because this repo keeps schemas in one
// source. `HeadBlockSchema` is the firehose `blocks` payload this repo
// PRODUCES; `BlockBodySchema` is the Substrate RPC response it CONSUMES. Both
// are declared vocabularies, and a declared vocabulary outside schemas-src is
// outside every gate that keeps schemas honest -- `no-passthrough`,
// `schema-shape-duplicates`, `schema-opacity`.
//
// The poller keeps its logic; only the shapes moved.
import { z } from "zod";

/**
 * The firehose `blocks` payload this module produces.
 *
 * A SCHEMA, with the type inferred from it (`z.infer`), so the shape is stated
 * once. A hand-written `interface` beside a validator is two things to keep in
 * step, and the one that drifts is always the validator.
 *
 * Scalar fields only, per the ingest validator's rules
 * (validateSingleChainFirehoseIngestPayload) -- nested JSON is rejected there,
 * so it must not be constructible here.
 */
export const HeadBlockSchema = z.object({
  table: z.literal("blocks"),
  block_number: z.int().min(0),
  block_hash: z.string(),
  parent_hash: z.string(),
  extrinsic_count: z.int().min(0),
  /**
   * The block's event count, or null when it could not be read.
   *
   * Nullable, never defaulted: a count we do not have is not a count of none.
   * See tests/fixtures/sqlite-schema/0016_blocks_head_event_count.sql.
   */
  event_count: z.int().min(0).nullable(),
  /**
   * The SS58 address that produced this block, or null when it could not be
   * derived.
   *
   * Nullable, never defaulted: an author we do not have is not a placeholder
   * address. See tests/fixtures/sqlite-schema/0017_blocks_head_author.sql.
   */
  author: z.string().nullable(),
  observed_at: z.int(),
});
export type HeadBlock = z.infer<typeof HeadBlockSchema>;

/**
 * What `chain_getBlock` must return for us to trust it.
 *
 * The RPC is untrusted external input reached over the network, and it was
 * previously read through a bare `as` cast -- which types the access without
 * checking a byte of it, so a malformed or truncated response produced a block
 * row with a silently wrong extrinsic count rather than an error. Deliberately
 * loose about fields we do not read; strict about the two we do.
 */
export const BlockBodySchema = z.object({
  block: z.object({
    header: z.object({
      parentHash: z.string(),
      /**
       * The header's digest logs, where Aura records the slot this block was
       * produced in. Optional and loose on purpose, per this schema's rule: a
       * header without decodable logs must still yield a block row (with a
       * null author), not a refusal.
       */
      digest: z.object({ logs: z.array(z.unknown()) }).optional(),
    }),
    extrinsics: z.array(z.unknown()),
  }),
});
