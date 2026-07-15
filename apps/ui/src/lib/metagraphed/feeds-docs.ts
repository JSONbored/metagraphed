/**
 * Static reference copy for the `/feeds` docs page (#3512).
 *
 * Kinds, formats, params, and limits mirror `src/feeds.mjs` — keep them in sync
 * when the Worker feed contract changes. The UI cannot import Worker `.mjs`
 * modules, so these are intentional literals.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3512
 */

/** Keep aligned with FEED_MAX_ITEMS in src/feeds.mjs */
export const FEEDS_DOCS_MAX_ITEMS = 50;

/** Keep aligned with FEED_CACHE_SECONDS in src/feeds.mjs */
export const FEEDS_DOCS_CACHE_SECONDS = 600;

export const FEEDS_BASE_PATH = "/api/v1/feeds";

/** Serializer suffixes, in the order the docs table lists them. */
export const FEEDS_DOCS_FORMATS = ["json", "rss", "atom"] as const;

export type FeedsDocsFormat = (typeof FEEDS_DOCS_FORMATS)[number];

/** Keep aligned with FEED_CONTENT_TYPES in src/feeds.mjs */
export const FEEDS_DOCS_CONTENT_TYPES: Record<FeedsDocsFormat, string> = {
  json: "application/feed+json; charset=utf-8",
  rss: "application/rss+xml; charset=utf-8",
  atom: "application/atom+xml; charset=utf-8",
};

export type FeedKindDoc = {
  /** Path segment under /api/v1/feeds (may carry a `{netuid}` template). */
  slug: string;
  summary: string;
  /** Tags each item in this feed carries, for `?tag=` narrowing. */
  tags: string;
};

/** Keep aligned with the route list in src/feeds.mjs. */
export const FEED_KINDS: readonly FeedKindDoc[] = [
  {
    slug: "registry",
    summary: "Registry changes from the 6h changelog deltas — subnets, artifacts, and coverage.",
    tags: "registry + one of subnet/artifact/coverage + the change verb (added/removed/renamed/modified)",
  },
  {
    slug: "incidents",
    summary: "Reconstructed incident history — one item per incident, opened and resolved.",
    tags: "incident, sn<netuid>, and ongoing or resolved",
  },
  {
    slug: "gaps",
    summary: "Open coverage gaps — what each subnet is still missing, by queue lane.",
    tags: "gaps, the queue lane, sn<netuid>, and each missing/direct-submission kind",
  },
  {
    slug: "subnets/{netuid}",
    summary: "Everything above, narrowed to a single subnet.",
    tags: "the same tags as the feed each item came from",
  },
] as const;

export type FeedParamDoc = {
  param: string;
  value: string;
  detail: string;
};

/** Keep aligned with the query-param handling in src/feeds.mjs. */
export const FEED_PARAMS: readonly FeedParamDoc[] = [
  {
    param: "tag",
    value: "<tag>",
    detail:
      "Narrow a feed to items carrying that tag, so one URL serves a focused subscription. An unknown tag yields an empty (but valid) feed.",
  },
  {
    param: "since",
    value: "<ISO-8601>",
    detail:
      "Only items at or after that instant, for incremental polling. A bare calendar date resolves to the inclusive start of that UTC day. Malformed input is a 400.",
  },
  {
    param: "until",
    value: "<ISO-8601>",
    detail:
      "Only items at or before that instant. A bare calendar date is inclusive of the whole UTC day (end-of-day), symmetric with `since`. Malformed input is a 400.",
  },
  {
    param: "limit",
    value: `1..${FEEDS_DOCS_MAX_ITEMS}`,
    detail: `Cap the number of returned items (default and hard cap ${FEEDS_DOCS_MAX_ITEMS}). A larger value clamps; a non-integer or < 1 is a 400.`,
  },
] as const;

/**
 * Path for a feed kind, optionally with an explicit serializer suffix.
 * `feedPath("registry", "rss")` → `/api/v1/feeds/registry.rss`.
 */
export function feedPath(slug: string, format?: FeedsDocsFormat): string {
  return `${FEEDS_BASE_PATH}/${slug}${format ? `.${format}` : ""}`;
}

export function buildFeedCurlExample(
  apiBase: string,
  slug = "registry",
  format: FeedsDocsFormat = "json",
): string {
  const base = apiBase.replace(/\/$/, "");
  return `curl -s '${base}${feedPath(slug, format)}?limit=10'`;
}

/** Expected feed-kind count — guards accidental drift. */
export const FEED_KIND_COUNT = 4;
