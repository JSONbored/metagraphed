// MCP tool `get_feed` (types-epic E batch 12, #8075). Lives in its own
// src/feed-mcp.ts (its `GET_FEED_MCP_TOOL`/`GET_FEED_OUTPUT_SCHEMA` spread
// into mcp-server.ts's MCP_TOOLS array). Does not mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching the
// hand-written literal field-for-field. FEED_KINDS and FEED_MAX_ITEMS are
// symbolic in the hand-written original (src/feeds.ts's own exports),
// cross-checked against the actual runtime source at the time of writing.
import { z } from "zod";

const FEED_KINDS = ["registry", "incidents", "gaps", "subnet"] as const;
const FEED_MAX_ITEMS = 50;

export const GetFeedInputSchema = z
  .object({
    kind: z.enum(FEED_KINDS),
    netuid: z.int().min(0).optional(),
    tag: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.int().min(1).max(FEED_MAX_ITEMS).optional(),
  })
  .strict();
export type GetFeedInput = z.infer<typeof GetFeedInputSchema>;

const FeedItemSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    summary: z.string(),
    timestamp: z.string(),
    tags: z.array(z.string()),
  })
  .passthrough();

export const GetFeedOutputSchema = z
  .object({
    kind: z.enum(FEED_KINDS),
    netuid: z.int().nullable().optional(),
    filters: z
      .object({
        tag: z.string().nullable().optional(),
        since: z.string().nullable().optional(),
        until: z.string().nullable().optional(),
        limit: z.int().optional(),
      })
      .passthrough()
      .optional(),
    returned: z.int(),
    items: z.array(FeedItemSchema),
  })
  .passthrough();
export type GetFeedOutput = z.infer<typeof GetFeedOutputSchema>;
