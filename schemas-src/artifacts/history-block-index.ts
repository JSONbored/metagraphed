import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const block = z.number().int().nonnegative().max(0xffffffff);
const scope = {
  version: z.literal(1),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(CHAIN_FIREHOSE_TOPICS),
};
/** Records: block, file, first row, row count (uint32 LE), observation (uint64 LE). */
export const HistoryBlockShardSchema = z.strictObject({
  ...scope,
  prefix: z.string().regex(/^[0-9a-f]{4}$/),
  key: z.string().min(1),
  etag: z.string().min(1),
  bytes: count.positive(),
  rows: count.positive(),
  runs: count.positive(),
  firstBlock: block,
  lastBlock: block,
});
export const HistoryBlockIndexSchema = z.strictObject({
  ...scope,
  state: z.literal("complete"),
  rows: count,
  runs: count,
  shards: z.array(HistoryBlockShardSchema).max(65536),
});
export type HistoryBlockIndex = z.infer<typeof HistoryBlockIndexSchema>;
