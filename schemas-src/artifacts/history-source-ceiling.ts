import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";

/** Published before catalog append; a failed append retains the offered bound. */
export const HistorySourceCeilingSchema = z.strictObject({
  version: z.literal(1),
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(CHAIN_FIREHOSE_TOPICS),
  through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revision: z.string().regex(/^[0-9a-f]{32}$/),
});
