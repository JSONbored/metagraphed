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
import { ROLLUP_POPULATION_CAP } from "../src/chain-event-rollup-cold-tier.ts";

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

// #9239: the window and the limit are each resolved ONCE, and the resolved
// value is what reaches both the scan and the builder. Both defects were latent
// -- every caller validates first -- but each is the kind that publishes a
// confident, wrong number rather than failing.
describe("the loader resolves its window and limit exactly once", () => {
  test("an unrecognised window narrows the scan AND the published label", () => {
    // The half-applied fallback is the trap: windowDays fell back to 7 while
    // the caller's original string still reached the builder, so the card
    // scanned seven days and claimed to be something else. A response that
    // misdescribes correct data is worse than one that is merely narrow.
    const engine = fakeEngine();
    return loadChainServingColdTier({} as never, {
      window: "90d",
      limit: 20,
      query: engine.query,
    }).then((data) => {
      assert.equal(data?.window, "7d", "the label must narrow with the scan");
      const rowsSql = engine.seen.find((sql) =>
        sql.includes("GROUP BY netuid"),
      )!;
      const cutoff = Number(/observed_at >= (\d+)/.exec(rowsSql)![1]);
      const days = (Date.now() - cutoff) / 86_400_000;
      assert.ok(
        days > 6.9 && days < 7.1,
        `expected ~7d, got ${days.toFixed(2)}d`,
      );
    });
  });

  test("the page size never reaches the scan, whatever the caller asks for", async () => {
    // WAS "an omitted limit caps the scan at what the response can carry",
    // asserting `LIMIT 20` -- the builder's page default -- in the row SQL. That
    // is the defect, not the contract: buildChainServing sums these rows for
    // `network.announcements` and takes `intensity_distribution` over them, so a
    // page-sized scan makes both describe the page. Measured live on
    // 2026-08-11, /api/v1/chain/serving?window=30d over 59 subnets:
    //
    //   limit=1   network.announcements  6,292
    //   limit=20  network.announcements 25,624
    //   limit=59  network.announcements 27,359   <- the window's real total
    //
    // A network-wide figure that quadruples with a query parameter. The scan
    // takes the population cap now and the builder pages, so no caller's limit
    // can move it.
    for (const limit of [undefined, 1, 20, 100]) {
      const engine = fakeEngine();
      const data = await loadChainServingColdTier({} as never, {
        window: "7d",
        ...(limit === undefined ? {} : { limit }),
        query: engine.query,
      });
      assert.ok(data);
      const rowsSql = engine.seen.find((sql) =>
        sql.includes("GROUP BY netuid"),
      )!;
      assert.match(
        rowsSql,
        new RegExp(`LIMIT ${ROLLUP_POPULATION_CAP}\\b`),
        `limit=${String(limit)} must not reach the scan: ${rowsSql}`,
      );
    }
  });

  test("the network total is the window's, not the page's", async () => {
    // The end-to-end form of the same regression: three subnets in the window,
    // a page of one, and a network block that still counts all three. This is
    // what the live measurements above were reading, and it fails if the page
    // slice ever moves back ahead of the rollup.
    const engine = fakeEngine({
      rows: [
        { netuid: 1, announcements: 60, distinct_servers: 3 },
        { netuid: 2, announcements: 30, distinct_servers: 2 },
        { netuid: 3, announcements: 10, distinct_servers: 1 },
      ],
      network: [{ distinct_servers: 4, newest_observed: 1_785_000_000_000 }],
    });
    const data = await loadChainServingColdTier({} as never, {
      window: "7d",
      limit: 1,
      query: engine.query,
    });
    assert.ok(data);
    assert.equal(data.subnets.length, 1, "the page is what the caller asked");
    assert.equal(data.network.announcements, 100, "60 + 30 + 10, not 60");
    assert.equal(data.subnet_count, 3);
    assert.equal(
      data.intensity_distribution?.count,
      3,
      "the spread covers every subnet in the window",
    );
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
