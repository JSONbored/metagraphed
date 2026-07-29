import { describe, expect, it } from "vitest";
import { encodeWatchFeedIds, buildWatchFeedUrl, WATCH_FEED_FORMATS } from "./watch-feed";

describe("encodeWatchFeedIds", () => {
  it("returns '' when nothing is watched", () => {
    expect(encodeWatchFeedIds({})).toBe("");
    expect(encodeWatchFeedIds({ subnet: [], validator: [], account: [] })).toBe("");
  });

  it("prefixes each kind and comma-joins in stable order (subnet, validator, account)", () => {
    expect(
      encodeWatchFeedIds({
        validator: ["5FHn"],
        subnet: ["7", "12"],
        account: ["5Grw"],
      }),
    ).toBe("s7,s12,v5FHn,a5Grw");
  });

  it("matches the backend WATCH_ID_PREFIX contract (single-letter s/v/a)", () => {
    expect(encodeWatchFeedIds({ subnet: ["1"] })).toBe("s1");
    expect(encodeWatchFeedIds({ validator: ["5X"] })).toBe("v5X");
    expect(encodeWatchFeedIds({ account: ["5Y"] })).toBe("a5Y");
  });

  it("skips empty ids", () => {
    expect(encodeWatchFeedIds({ subnet: ["7", ""] })).toBe("s7");
  });
});

describe("buildWatchFeedUrl", () => {
  it("returns null for an empty id set (no dangling ids=)", () => {
    expect(buildWatchFeedUrl("https://api.metagraph.sh", "", ".rss")).toBeNull();
  });

  it("builds a percent-encoded feed URL per format", () => {
    expect(buildWatchFeedUrl("https://api.metagraph.sh", "s7,v5FHn", ".rss")).toBe(
      "https://api.metagraph.sh/api/v1/feeds/watch.rss?ids=s7%2Cv5FHn",
    );
    expect(buildWatchFeedUrl("https://api.metagraph.sh", "s7", ".json")).toBe(
      "https://api.metagraph.sh/api/v1/feeds/watch.json?ids=s7",
    );
  });

  it("strips a trailing slash from the runtime base rather than doubling it", () => {
    expect(buildWatchFeedUrl("https://api.metagraph.sh/", "s7", ".atom")).toBe(
      "https://api.metagraph.sh/api/v1/feeds/watch.atom?ids=s7",
    );
  });

  it("offers exactly the three formats the endpoint serves", () => {
    expect(WATCH_FEED_FORMATS.map((f) => f.suffix)).toEqual([".rss", ".atom", ".json"]);
  });
});
