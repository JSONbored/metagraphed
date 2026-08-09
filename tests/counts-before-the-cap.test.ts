// A published count must not move with `?limit=` (#10249).
//
// `subnet_count` reads as a population and was the page length on every route
// whose loader caps in SQL, because the builder never sees the rows past the
// cap. Measured live before the fix:
//
//   /api/v1/chain/serving ?limit=20    subnet_count 20     window covered 38
//   /api/v1/chain/serving ?limit=100   subnet_count 38
//   /api/v1/chain/weights ?limit=20    subnet_count 19     window covered 129
//   /api/v1/chain/weights ?limit=100   subnet_count 99
//
// Wrong at BOTH limits on /chain/weights, which is what makes it a bug rather
// than a truncation a caller could notice: nothing in the payload says the
// number is a page, and it changes under a parameter nobody set.
//
// DERIVED OVER THE FAMILY, one entry per loader, so a sixth route added to the
// rollup is covered the day it lands rather than the day someone remembers this
// file. The check is the cheapest one that can tell the two apart: ask twice at
// different limits and require the count to hold still.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadChainServingColdTier } from "../src/chain-serving-loader.ts";
import { loadChainWeightsColdTier } from "../src/chain-weights-loader.ts";

type Row = Record<string, unknown>;

/** The window covers more subnets than any page below will ask for. */
const SUBNETS_IN_WINDOW = 129;

/**
 * A lakehouse that answers the three rollup queries, capping the page in SQL
 * exactly as the real engine does -- which is the condition the bug needs.
 */
function cappingEngine(distinctField: string, countField: string) {
  const everySubnet = Array.from({ length: SUBNETS_IN_WINDOW }, (_, i) => ({
    netuid: i,
    [countField]: SUBNETS_IN_WINDOW - i,
    [distinctField]: 3,
  }));
  return async (_env: unknown, sql: string): Promise<Row[]> => {
    if (sql.includes("AS subnet_count")) {
      return [{ subnet_count: SUBNETS_IN_WINDOW }];
    }
    if (sql.includes("ORDER BY")) {
      const cap = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? SUBNETS_IN_WINDOW);
      return everySubnet.slice(0, cap);
    }
    return [{ [distinctField]: 400, newest_observed: 1_785_000_000_000 }];
  };
}

const FAMILY = [
  {
    route: "/api/v1/chain/serving",
    load: (
      limit: number,
      query: Parameters<typeof loadChainServingColdTier>[1]["query"],
    ) => loadChainServingColdTier({} as never, { window: "7d", limit, query }),
    query: cappingEngine("distinct_servers", "announcements"),
  },
  {
    route: "/api/v1/chain/weights",
    load: (
      limit: number,
      query: Parameters<typeof loadChainWeightsColdTier>[1]["query"],
    ) => loadChainWeightsColdTier({} as never, { window: "7d", limit, query }),
    query: cappingEngine("distinct_setters", "weight_sets"),
  },
] as const;

describe("a published count is the window's, not the page's (#10249)", () => {
  for (const { route, load, query } of FAMILY) {
    test(`${route} reports the same subnet_count at two limits`, async () => {
      const small = await load(20, query);
      const large = await load(100, query);
      assert.ok(small && large, "the loader must answer");
      assert.equal(
        small.subnet_count,
        SUBNETS_IN_WINDOW,
        "the small page must still report the whole window",
      );
      assert.equal(small.subnet_count, large.subnet_count);
      // And the page really is capped -- otherwise the assertion above passes
      // for the uninteresting reason that nothing was truncated.
      assert.equal(small.subnets.length, 20);
      assert.equal(large.subnets.length, 100);
    });
  }

  test("the count falls back to the page only when the loader cannot answer", async () => {
    // The builders are also called in-memory with EVERY row, where the page IS
    // the population. That path must keep working, and it is the reason
    // `subnetCount` is optional rather than required.
    const noSubnetCount = async (_env: unknown, sql: string): Promise<Row[]> =>
      sql.includes("AS subnet_count")
        ? []
        : sql.includes("ORDER BY")
          ? [{ netuid: 7, announcements: 9, distinct_servers: 4 }]
          : [{ distinct_servers: 4, newest_observed: 1_785_000_000_000 }];
    const data = await loadChainServingColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: noSubnetCount,
    });
    assert.ok(data);
    assert.equal(data.subnet_count, 1, "the page length, honestly");
  });
});
