import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8526: the "Subscribe to this watchlist" affordance lives inside
// HomeWatchedModule, which can only render inside the full app shell + router
// (localStorage watchlist state, chain-stream hooks, route-level imports). This
// repo asserts that class of wiring on source — matching api-source-context.test.tsx
// — while the falsifiable URL/encoding logic is unit-tested directly in
// lib/metagraphed/watch-feed.test.ts (encode order, empty→"", per-format URLs).

const source = readFileSync(
  fileURLToPath(new URL("./home-watched-module.tsx", import.meta.url)),
  "utf8",
);

describe("HomeWatchedModule wires the watchlist subscribe affordance (#8526)", () => {
  it("builds the feed URL from the runtime API base hook, not a hardcoded origin", () => {
    expect(source).toContain("useApiBase");
    expect(source).not.toMatch(/https:\/\/api\.metagraph\.sh/);
  });

  it("re-encodes the local watchlist into the URL via the shared helper", () => {
    expect(source).toContain("encodeWatchFeedIds");
    expect(source).toContain("buildWatchFeedUrl");
  });

  it("offers all three formats the endpoint serves", () => {
    expect(source).toContain("WATCH_FEED_FORMATS");
  });

  it("reuses the existing clipboard hook rather than a new helper", () => {
    expect(source).toContain("useCopy");
  });

  it("guards the empty watchlist (never emits an empty ids= URL)", () => {
    // The affordance returns null when the encoded id set is empty, and it is
    // only rendered from the non-empty branch of HomeWatchedModule.
    expect(source).toMatch(/if\s*\(!encoded\)\s*return null/);
    expect(source).toContain("<WatchFeedSubscribe");
  });
});
