// GET /api/v1/chain/indexer-lag (#9620): how long after a block is produced it
// becomes queryable here. Modeled from src/indexer-lag.ts's buildIndexerLag().
//
// The latency numbers are deliberately UNBOUNDED BELOW. They are the difference
// between two clocks -- the block author's and Cloudflare's -- so a `.min(0)`
// here would make author clock skew a schema violation on the one route whose
// whole subject is that difference, turning evidence into an error.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

/** What was actually measured. Published because chain-detail-prune keeps a
 * rolling window, so a distribution without its bounds reads as a lifetime one. */
export const IndexerLagWindowSchema = z
  .object({
    oldest_block: z.int().min(0).nullable(),
    newest_block: z.int().min(0).nullable(),
    oldest_observed_at: z.iso.datetime().nullable(),
    newest_observed_at: z.iso.datetime().nullable(),
  })
  .strict();

/** How long each block took to become queryable, in ms. Nearest-rank
 * percentiles over the retained window. */
export const IndexerLagLatencySchema = z
  .object({
    min: z.number().nullable(),
    p50: z.number().nullable(),
    p95: z.number().nullable(),
    p99: z.number().nullable(),
    max: z.number().nullable(),
    mean: z.number().nullable(),
  })
  .strict();

export const IndexerLagArtifactSchema = z
  .object({
    schema_version: z.int(),
    /** Blocks the distribution was computed over. Null only on a decline. */
    block_count: z.int().min(0).nullable(),
    window: IndexerLagWindowSchema.nullable(),
    write_latency_ms: IndexerLagLatencySchema.nullable(),
    /**
     * now - the newest observed_at: how far behind the lane is RIGHT NOW.
     *
     * A DIFFERENT number from write_latency_ms, and the one that moves when the
     * lane stalls -- a stalled lane keeps a perfect latency distribution while
     * this climbs without bound.
     */
    head_age_ms: z.number().nullable(),
    measured_at: z.iso.datetime(),
    /** Present ONLY on a decline; its absence says the measurement is real. */
    degraded: z
      .object({
        reason: z.enum(["no_retained_blocks", "unavailable"]),
        detail: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type IndexerLagArtifact = z.infer<typeof IndexerLagArtifactSchema>;
export const IndexerLagResponseSchema = successEnvelopeSchema(
  IndexerLagArtifactSchema,
);
