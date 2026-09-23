import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";
import { HistoryObjectSchema } from "./history-generation.ts";

const block = z.number().int().nonnegative().max(0xffffffff);
const scope = {
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(CHAIN_FIREHOSE_TOPICS),
};
const segment = z.strictObject({
  ...scope,
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  firstBlock: block,
  lastBlock: block,
  blockManifest: HistoryObjectSchema,
  hashManifest: HistoryObjectSchema.optional(),
});
/** A serving selection is separate from immutable generation publication.
 * Closed ranges describe pinned snapshots, never unindexed new rows. Four
 * segments bound metadata and hash-search fanout; compact deltas before adding
 * another segment instead of rebuilding the retained base. */
export const HistorySelectionSchema = z.discriminatedUnion("version", [
  segment.extend({ version: z.literal(1) }),
  z.strictObject({
    version: z.literal(2),
    ...scope,
    segments: z.array(segment).min(1).max(4),
  }),
]);
export type HistorySelection = z.infer<typeof HistorySelectionSchema>;
