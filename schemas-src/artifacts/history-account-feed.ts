import { z } from "zod";
import { HistoryObjectSchema } from "./history-generation.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const block = count.max(0xffffffff);
const token = z.string().regex(/^[0-9a-f]{166}$/);
const fields = {
  first: token,
  last: token,
  rows: count.positive(),
  minBlock: block,
  maxBlock: block,
  object: HistoryObjectSchema,
};
export const HistoryFeedNodeSchema = z.union([
  z.strictObject({
    ...fields,
    height: z.literal(0),
    offset: count,
    length: count.positive().max(16 * 1024 * 1024),
    decodedBytes: count.positive().max(256 * 1024),
  }),
  z.strictObject({ ...fields, height: count.positive().max(16) }),
]);
export const HistoryFeedDirectorySchema = z.strictObject({
  version: z.literal(1),
  children: z.array(HistoryFeedNodeSchema).min(1).max(64),
});
const selection = z.strictObject({
  network: z.enum(["mainnet", "testnet"]),
  table: z.literal("account_events"),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  firstBlock: block,
  lastBlock: block,
  blockManifest: HistoryObjectSchema,
  hashManifest: HistoryObjectSchema.optional(),
});
export const HistoryAccountFeedSchema = z.strictObject({
  version: z.literal(1),
  network: z.enum(["mainnet", "testnet"]),
  table: z.literal("account_events"),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  sourceSnapshot: z.string().regex(/^[0-9]+$/),
  rows: count,
  entries: count,
  state: z.literal("complete"),
  encoding: z.literal("jsonl-gzip-v1"),
  plan: HistoryObjectSchema,
  selection,
  root: HistoryFeedNodeSchema.nullable(),
});
export type HistoryFeedNode = z.infer<typeof HistoryFeedNodeSchema>;
export type HistoryAccountFeed = z.infer<typeof HistoryAccountFeedSchema>;
