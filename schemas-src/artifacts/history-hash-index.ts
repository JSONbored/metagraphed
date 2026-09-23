import { z } from "zod";

/** A complete generation binds the sorted hash shard to physical source rows.
 * Records are 32 raw hash bytes, uint32 LE file id, uint32 LE row position. */
export const HistoryHashShardSchema = z.strictObject({
  version: z.literal(1),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(["extrinsics", "blocks"]),
  prefix: z.string().regex(/^[0-9a-f]{3}$/),
  key: z.string().min(1),
  etag: z.string().min(1),
  rows: z.number().int().min(0).max(0xffffffff),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Byte range of this logical prefix in one immutable packed hash object. */
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
export type HistoryHashShard = z.infer<typeof HistoryHashShardSchema>;
