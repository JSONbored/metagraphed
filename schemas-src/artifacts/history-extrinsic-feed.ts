import { z } from "zod";
import { HistoryAccountFeedSchema } from "./history-account-feed.ts";

export const HistoryExtrinsicFeedSchema = HistoryAccountFeedSchema.extend({
  table: z.literal("extrinsics"),
  // The inherited account marker previously selected the legacy JSONL reader.
  // Keep accepting it without interpreting account binary pages as extrinsics.
  encoding: z.enum([
    "jsonl-gzip-v1",
    "account-mixed-gzip-v2",
    "extrinsic-mixed-gzip-v1",
  ]),
  selection: HistoryAccountFeedSchema.shape.selection.extend({
    table: z.literal("extrinsics"),
  }),
});
export type HistoryExtrinsicFeed = z.infer<typeof HistoryExtrinsicFeedSchema>;
