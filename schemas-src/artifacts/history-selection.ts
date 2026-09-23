import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";
import { HistoryObjectSchema } from "./history-generation.ts";

const block = z.number().int().nonnegative().max(0xffffffff);
/** A serving selection is separate from immutable generation publication.
 * Its closed range describes the pinned snapshot, never unindexed new rows. */
export const HistorySelectionSchema = z.strictObject({
  version: z.literal(1),
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(CHAIN_FIREHOSE_TOPICS),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  firstBlock: block,
  lastBlock: block,
  blockManifest: HistoryObjectSchema,
  hashManifest: HistoryObjectSchema.optional(),
});
export type HistorySelection = z.infer<typeof HistorySelectionSchema>;
