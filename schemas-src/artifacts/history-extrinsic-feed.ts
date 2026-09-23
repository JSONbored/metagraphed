import { z } from "zod";
import { HistoryAccountFeedSchema } from "./history-account-feed.ts";

export const HistoryExtrinsicFeedSchema = HistoryAccountFeedSchema.extend({
  table: z.literal("extrinsics"),
  selection: HistoryAccountFeedSchema.shape.selection.extend({
    table: z.literal("extrinsics"),
  }),
});
export type HistoryExtrinsicFeed = z.infer<typeof HistoryExtrinsicFeedSchema>;
