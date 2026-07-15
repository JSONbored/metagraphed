import { describe, expect, it } from "vitest";
import {
  FEEDS_BASE_PATH,
  FEEDS_DOCS_CACHE_SECONDS,
  FEEDS_DOCS_CONTENT_TYPES,
  FEEDS_DOCS_FORMATS,
  FEEDS_DOCS_MAX_ITEMS,
  FEED_KINDS,
  FEED_KIND_COUNT,
  FEED_PARAMS,
  buildFeedCurlExample,
  feedPath,
} from "./feeds-docs";

describe("feeds docs reference (#3512)", () => {
  it("keeps Worker-aligned limit constants", () => {
    expect(FEEDS_DOCS_MAX_ITEMS).toBe(50);
    expect(FEEDS_DOCS_CACHE_SECONDS).toBe(600);
  });

  it("documents every feed kind exactly once", () => {
    expect(FEED_KINDS).toHaveLength(FEED_KIND_COUNT);
    const slugs = FEED_KINDS.map((k) => k.slug);
    expect(slugs).toEqual(["registry", "incidents", "gaps", "subnets/{netuid}"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("maps each serializer to its Worker content-type", () => {
    expect([...FEEDS_DOCS_FORMATS]).toEqual(["json", "rss", "atom"]);
    expect(FEEDS_DOCS_CONTENT_TYPES.json).toBe("application/feed+json; charset=utf-8");
    expect(FEEDS_DOCS_CONTENT_TYPES.rss).toBe("application/rss+xml; charset=utf-8");
    expect(FEEDS_DOCS_CONTENT_TYPES.atom).toBe("application/atom+xml; charset=utf-8");
    for (const f of FEEDS_DOCS_FORMATS)
      expect(FEEDS_DOCS_CONTENT_TYPES[f]).toContain("charset=utf-8");
  });

  it("documents the tag/since/until/limit params", () => {
    expect(FEED_PARAMS.map((p) => p.param)).toEqual(["tag", "since", "until", "limit"]);
    const limit = FEED_PARAMS.find((p) => p.param === "limit");
    expect(limit?.value).toBe(`1..${FEEDS_DOCS_MAX_ITEMS}`);
    expect(limit?.detail).toContain(String(FEEDS_DOCS_MAX_ITEMS));
  });

  it("builds feed paths with and without an explicit serializer suffix", () => {
    expect(FEEDS_BASE_PATH).toBe("/api/v1/feeds");
    expect(feedPath("registry")).toBe("/api/v1/feeds/registry");
    expect(feedPath("registry", "rss")).toBe("/api/v1/feeds/registry.rss");
    expect(feedPath("incidents", "atom")).toBe("/api/v1/feeds/incidents.atom");
    expect(feedPath("subnets/{netuid}", "json")).toBe("/api/v1/feeds/subnets/{netuid}.json");
  });

  it("builds a curl example against a real feed path", () => {
    const curl = buildFeedCurlExample("https://api.metagraph.sh/", "registry", "json");
    expect(curl).toContain("https://api.metagraph.sh/api/v1/feeds/registry.json");
    expect(curl).toContain("limit=10");
    expect(curl).not.toContain("//api/v1");
  });
});
