import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const point = z.strictObject({ spec_version: count, block_number: count });
export const HistoryRuntimeSummarySchema = z.strictObject({
  version: z.literal(1),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  network: z.enum(["mainnet", "testnet"]),
  table: z.literal("blocks"),
  sourceSnapshot: z.string().regex(/^[0-9]+$/),
  rows: count,
  versionedRows: count,
  transitions: z
    .array(point.extend({ observed_at: count.nullable() }))
    .max(4096),
  latest: point.nullable(),
});
