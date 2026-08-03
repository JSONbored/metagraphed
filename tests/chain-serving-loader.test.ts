// The shared chain-serving loader — REST, MCP and GraphQL parity.
//
// #9216 wired the lakehouse rollup into the REST handler alone, so
// `get_chain_serving` and GraphQL's `chain_serving` kept returning the zeroed
// card while `/api/v1/chain/serving` returned real numbers for the identical
// question. A caller could not tell which surface was lying.
//
// The parity claim is what these assert: all three surfaces call ONE loader, so
// the interesting property is not "does it aggregate" (the rollup reader's own
// tests cover that) but "is there exactly one implementation, and does it hand
// back the shape every caller already expects".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadChainServingColdTier } from "../src/chain-serving-loader.ts";

const NOW_ROWS = [{ netuid: 7, announcements: 9, distinct_servers: 4 }];
const NETWORK = [{ distinct_servers: 4, newest_observed: 1_785_000_000_000 }];

/** Answers both halves of the rollup, and records the SQL. */
function fakeEngine(
  overrides: {
    rows?: Record<string, unknown>[] | null;
    network?: Record<string, unknown>[] | null;
  } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    return sql.includes("ORDER BY")
      ? pick(overrides.rows, NOW_ROWS)
      : pick(overrides.network, NETWORK);
  };
  return { query, seen };
}

describe("the shared chain-serving loader", () => {
  test("builds the response shape, not raw rollup rows", async () => {
    // Every caller hands this straight to its own envelope. Returning the
    // rollup would push the build step back into three places.
    const engine = fakeEngine();
    const data = await loadChainServingColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query,
    });
    assert.ok(data);
    assert.equal(data.window, "7d");
    assert.ok(Array.isArray(data.subnets), "callers read data.subnets");
    assert.equal(data.subnets.length, 1);
  });

  test("the network block comes from the ungrouped query, not the rows", async () => {
    // Distinct hotkeys do not sum across subnets. If this ever started
    // deriving the network total from the per-subnet rows it would overstate
    // it, and no caller could tell.
    const engine = fakeEngine({
      rows: [
        { netuid: 1, announcements: 5, distinct_servers: 3 },
        { netuid: 2, announcements: 5, distinct_servers: 3 },
      ],
      network: [{ distinct_servers: 4, newest_observed: 1_785_000_000_000 }],
    });
    const data = (await loadChainServingColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query,
    })) as unknown as { network: { distinct_servers: number } };
    assert.equal(
      data.network.distinct_servers,
      4,
      "the network total must be the queried value, not 3 + 3",
    );
  });

  test("an unknown window falls back to 7d rather than widening the range", async () => {
    // Silently scanning a longer range would answer a different question than
    // the label the caller sees in the response.
    const engine = fakeEngine();
    await loadChainServingColdTier({} as never, {
      window: "all-time",
      limit: 20,
      query: engine.query,
    });
    const rowsSql = engine.seen.find((sql) => sql.includes("ORDER BY"))!;
    const sevenDayCutoff = /observed_at >= (\d+)/.exec(rowsSql)![1];
    const days = (Date.now() - Number(sevenDayCutoff)) / 86_400_000;
    assert.ok(
      days > 6.9 && days < 7.1,
      `expected a 7d window, got ~${days.toFixed(2)}d`,
    );
  });

  test("a lakehouse miss declines so each caller keeps its own fallback", async () => {
    // GraphQL deliberately answers with a schema-stable card rather than an
    // error; REST and MCP have their own empty shapes. That decision belongs
    // at the call site, so the loader returns null rather than choosing one.
    for (const miss of [{ rows: null }, { network: null }, { rows: [] }]) {
      const engine = fakeEngine(miss);
      const data = await loadChainServingColdTier({} as never, {
        window: "7d",
        limit: 20,
        query: engine.query,
      });
      assert.equal(data, null, `${JSON.stringify(miss)} must decline`);
    }
  });
});

describe("all three surfaces go through the one loader", () => {
  // The regression this file exists for is a surface being wired to the
  // lakehouse while its siblings are not. Reading the sources is the only way
  // to assert that property without standing up three runtimes -- and it is
  // exact, because a call site either exists or it does not.
  const sources = {
    REST: "workers/request-handlers/analytics.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadChainServingColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadChainServingColdTier\(/,
        `${surface} (${path}) does not reach the lakehouse, so it will answer ` +
          "the zeroed card while its siblings answer real numbers",
      );
    }
  });

  test("no surface builds the rollup itself", () => {
    // A caller that reached for loadChainEventRollup directly would be a
    // second implementation of the same aggregation, free to drift from this
    // one -- exactly what the shared loader exists to prevent.
    for (const [surface, path] of Object.entries(sources)) {
      assert.doesNotMatch(
        readFileSync(path, "utf8"),
        /loadChainEventRollup\(/,
        `${surface} should call the shared loader, not re-implement the rollup`,
      );
    }
  });
});
