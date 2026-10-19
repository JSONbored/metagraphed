import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";
import { HistoryHashShardSchema } from "./history-hash-index.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const scope = {
  version: z.literal(1),
  generation: digest,
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(CHAIN_FIREHOSE_TOPICS),
};
export const HistoryObjectSchema = z.strictObject({
  key: z.string().min(1),
  etag: z.string().min(1),
  bytes: count.positive(),
});
export const HistoryEconomicsSubnetIdsSchema = z
  .array(count)
  .max(4096)
  .refine((ids) => ids.every((id, i) => i === 0 || ids[i - 1] < id), {
    message: "Economics subnet IDs must be unique and sorted",
  });
/** One unchanged physical source part, shared by preparation and serving. */
export const HistoryEconomicsSourceSchema = HistoryObjectSchema.extend({
  rows: count.positive().max(65536),
});
export const HistoryEconomicsAttributionSchema = z.strictObject({
  version: z.literal(1),
  source: HistoryEconomicsSourceSchema,
  subnetIds: z.array(HistoryEconomicsSubnetIdsSchema).min(1).max(65536),
});
export type HistoryEconomicsSource = z.infer<
  typeof HistoryEconomicsSourceSchema
>;
/** The publisher writes this last, after qualifying every file and hash shard. */
const generationFields = {
  ...scope,
  state: z.literal("complete"),
  sourceSnapshot: z.string().regex(/^[0-9]+$/),
  rows: count,
  files: z
    .array(HistoryObjectSchema.extend({ rows: count.positive() }))
    .max(100000),
};
export const HistoryGenerationSchema = z.strictObject({
  ...generationFields,
  table: z.enum(["extrinsics", "blocks"]),
  shards: z.array(HistoryHashShardSchema).length(4096),
});
/** Event tables have no unique hash key. Complete block indexes instead prove
 * their full physical row census without weakening hash absence guarantees. */
export const HistoryBlockGenerationSchema = z.strictObject({
  ...generationFields,
  blockIndex: HistoryObjectSchema,
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
        economics: HistoryObjectSchema.optional(),
      }),
    )
    .min(1),
});
export type HistoryObject = z.infer<typeof HistoryObjectSchema>;
export type HistoryGeneration = z.infer<typeof HistoryGenerationSchema>;
export type HistoryBlockGeneration = z.infer<
  typeof HistoryBlockGenerationSchema
>;
