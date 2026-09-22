import { z } from "zod";
import { HistoryHashShardSchema } from "./history-hash-index.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const scope = {
  version: z.literal(1),
  generation: digest,
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(["extrinsics", "blocks"]),
};
export const HistoryObjectSchema = z.strictObject({
  key: z.string().min(1),
  etag: z.string().min(1),
  bytes: count.positive(),
});
/** The publisher writes this last, after qualifying every file and hash shard. */
export const HistoryGenerationSchema = z.strictObject({
  ...scope,
  state: z.literal("complete"),
  sourceSnapshot: z.string().regex(/^[0-9]+$/),
  rows: count,
  files: z
    .array(HistoryObjectSchema.extend({ rows: count.positive() }))
    .max(100000),
  shards: z.array(HistoryHashShardSchema).length(4096),
});
export const HistoryFileSchema = z.strictObject({
  ...scope,
  fileId: count,
  sourceIdentity: digest,
  rows: count.positive(),
  parts: z
    .array(
      z.strictObject({
        ...HistoryObjectSchema.shape,
        rowStart: count,
        rows: count.positive().max(65536),
        index: HistoryObjectSchema,
      }),
    )
    .min(1),
});
export type HistoryObject = z.infer<typeof HistoryObjectSchema>;
export type HistoryGeneration = z.infer<typeof HistoryGenerationSchema>;
