// #11003. The flat 60 s TTL was discarding answers incapable of changing:
// production showed a `cache_status: STALE` on finalized block 8803453, an
// answer we computed, stored, threw away 60 seconds later, and re-derived with
// another lakehouse scan.
//
// Two conditions earn the long TTL and the second is the easy one to miss — the
// same handler serves the /api/v1/chain-events FEED, which is a window over a
// growing stream and is not immutable at any tier.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { chainEventsCacheTtlSeconds } from "../workers/api.ts";

const SHORT = 60;
const LONG = 3600;

const at = (pathname: string) => new URL(`https://api.metagraph.sh${pathname}`);
const cold = { source: "lakehouse-cold-tier" };
const hot = { source: "chain-detail-hot-tier" };

const BLOCK = "/api/v1/blocks/8803453/chain-events";
const BLOCK_BY_HASH = `/api/v1/blocks/0x${"ab".repeat(32)}/chain-events`;
const FEED = "/api/v1/chain-events";
const STATS = "/api/v1/chain-events/stats";

describe("chain-events edge TTL follows the tier AND the scope (#11003)", () => {
  test("a settled single block earns the long TTL — it cannot change in its own key", () => {
    assert.equal(chainEventsCacheTtlSeconds(at(BLOCK), cold), LONG);
    assert.equal(chainEventsCacheTtlSeconds(at(BLOCK_BY_HASH), cold), LONG);
  });

  test("a hot-window block keeps the short TTL — it may still move", () => {
    assert.equal(chainEventsCacheTtlSeconds(at(BLOCK), hot), SHORT);
  });

  // The regression this file exists to prevent. Keying the TTL on the tier
  // ALONE would pin a feed page — whose correct answer changes as events land —
  // for an hour, which is a correctness bug, not merely a stale cache.
  test("the feed and its stats keep the short TTL even on a cold answer", () => {
    assert.equal(chainEventsCacheTtlSeconds(at(FEED), cold), SHORT);
    assert.equal(chainEventsCacheTtlSeconds(at(STATS), cold), SHORT);
    assert.equal(
      chainEventsCacheTtlSeconds(at(`${FEED}?limit=100&netuid=64`), cold),
      SHORT,
    );
  });

  test("an answer with no source, or none at all, keeps the short TTL", () => {
    assert.equal(chainEventsCacheTtlSeconds(at(BLOCK), {}), SHORT);
    assert.equal(chainEventsCacheTtlSeconds(at(BLOCK), null), SHORT);
  });
});
