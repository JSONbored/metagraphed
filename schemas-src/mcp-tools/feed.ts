// MCP tool `get_feed` (types-epic E batch 12, #8075). Lives in its own
// src/feed-mcp.ts (its `GET_FEED_MCP_TOOL`/`GET_FEED_OUTPUT_SCHEMA` spread
// into mcp-server.ts's MCP_TOOLS array). Does not mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching the
// hand-written literal field-for-field. FEED_KINDS and FEED_MAX_ITEMS are
// symbolic in the hand-written original (src/feeds.ts's own exports),
// cross-checked against the actual runtime source at the time of writing.
import { z } from "zod";
import { kindSchema, limitSchema, netuidSchema } from "./shared.ts";

// Single source of truth for get_feed kind enums (input + output) and the
// runtime requireKind allow-list in src/feed-mcp.ts.
// #8702: Bittensor runtime upgrade activity -- releases, observed chain
// spec-version changes, and BIT documents.
export const FEED_KINDS = [
  "registry",
  "incidents",
  "gaps",
  "upgrades",
  "subnet",
] as const;
const FEED_MAX_ITEMS = 50;

export const GetFeedInputSchema = z
  .object({
    kind: kindSchema(FEED_KINDS),
    netuid: netuidSchema().optional(),
    tag: z
      .string()
      .optional()
      .describe(
        "Restrict the feed to items carrying this tag. Exact match against the item's own tags.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "ISO-8601 timestamp; only items at or after this instant are returned.",
      ),
    until: z
      .string()
      .optional()
      .describe(
        "ISO-8601 timestamp; only items at or before this instant are returned.",
      ),
    limit: limitSchema(FEED_MAX_ITEMS).optional(),
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
    netuid: netuidSchema().nullable().optional(),
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
