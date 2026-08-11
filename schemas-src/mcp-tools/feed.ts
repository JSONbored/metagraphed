// MCP tool `get_feed` (types-epic E batch 12, #8075). Lives in its own
// src/feed-mcp.ts (its `GET_FEED_MCP_TOOL`/`GET_FEED_OUTPUT_SCHEMA` spread
// into mcp-server.ts's MCP_TOOLS array). Does not mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching the
// hand-written literal field-for-field. FEED_KINDS and FEED_MAX_ITEMS are
// symbolic in the hand-written original (src/feeds.ts's own exports),
// cross-checked against the actual runtime source at the time of writing.
import { z } from "zod";
import {
  filterTokenSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
} from "./shared.ts";

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
    // The route's own bound (#10218): the feed parameters were the last raw
    // JSON Schema on the surface, so `tag` published no ceiling on either
    // side. It has one now, and a tool looser than its route is what
    // `validate:mcp-input-parity` exists to catch.
    tag: filterTokenSchema()
      .optional()
      .describe(
        "Restrict the feed to items carrying this tag. Exact match against the item's own tags.",
      )
      .meta({ examples: ["incident"] }),
    // TWO ACCEPTED FORMS, and the bare-date one is not shorthand for midnight
    // on both bounds -- `parseSinceParam` (src/feeds.ts) resolves a date to the
    // START of that UTC day for `since` and to its LAST instant for `until`,
    // deliberately, so `?until=DATE` keeps that whole day instead of dropping
    // everything after its midnight tick. That asymmetry is invisible from the
    // parameter name and is the thing a caller gets wrong.
    //
    // Neither gets `format: "date-time"` for the same reason: the parser takes
    // a bare calendar date too, so declaring date-time would advertise a
    // constraint narrower than the handler's and reject input it accepts.
    since: z
      .string()
      .optional()
      .describe(
        "Lower bound, inclusive. Either an ISO calendar date (`2026-08-01`) or " +
          "an ISO date-time with an explicit UTC/offset designator " +
          "(`2026-08-01T12:00:00Z`). A bare date means the START of that UTC day.",
      )
      .meta({ examples: ["2026-08-01T00:00:00Z", "2026-08-01"] }),
    until: z
      .string()
      .optional()
      .describe(
        "Upper bound, inclusive. Either an ISO calendar date (`2026-08-06`) or " +
          "an ISO date-time with an explicit UTC/offset designator. A bare date " +
          "means the END of that UTC day, so the whole day is kept.",
      )
      .meta({ examples: ["2026-08-06T23:59:59Z", "2026-08-06"] }),
    // resolveLimit() in src/feed-mcp.ts returns FEED_MAX_ITEMS when the
    // caller names none, so the ceiling IS the default here -- unusual, and
    // worth publishing precisely because it is (#10101).
    limit: limitSchema(FEED_MAX_ITEMS, FEED_MAX_ITEMS).optional(),
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
  .strict();

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
      .strict()
      .optional(),
    returned: z.int(),
    items: z.array(FeedItemSchema),
  })
  .strict();
export type GetFeedOutput = z.infer<typeof GetFeedOutputSchema>;
