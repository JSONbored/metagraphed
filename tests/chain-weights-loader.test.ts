// The shared chain-weights loader — REST + MCP + GraphQL parity.
//
// This route was briefly written off as underivable. `account_events.hotkey` is
// NULL on all 50,890,747 WeightsSet rows, so a distinct-hotkey count returns 0
// and the data looked absent. It is not: the chain event emits [netuid, uid]
// and carries no hotkey at all, so `uid` is the identity the event records.
// Within a subnet a uid is one neuron, which makes a distinct-uid count the
// distinct-setter count.
//
// That is the assertion that matters here — a regression back to `hotkey` would
// return a well-formed card of zeros for every subnet, which reads as "no
// validator set weights anywhere" rather than as a bug.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadChainWeightsColdTier } from "../src/chain-weights-loader.ts";
import { CHAIN_WEIGHTS_ROLLUP } from "../src/chain-event-rollup-cold-tier.ts";

const ROWS = [{ netuid: 8, weight_sets: 4389, distinct_setters: 14 }];
const NETWORK = [{ distinct_setters: 74, newest_observed: 1_785_000_000_000 }];

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
    return sql.includes("GROUP BY netuid")
      ? pick(overrides.rows, ROWS)
      : pick(overrides.network, NETWORK);
  };
  return {
    query,
    seen,
    // Both halves run under Promise.all, so push order is not guaranteed:
    // select by content rather than asserting on scheduling.
    rowsSql: () => seen.find((sql) => sql.includes("GROUP BY netuid")),
    networkSql: () => seen.find((sql) => !sql.includes("GROUP BY netuid")),
  };
}

describe("the WeightsSet identity", () => {
  test("distinct setters are counted over uid, never hotkey", async () => {
    // The whole reason this route is servable. Counting hotkey returns 0 on
    // every row and publishes a card of zeros that looks measured.
    const engine = fakeEngine();
    await loadChainWeightsColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query,
    });
    for (const sql of engine.seen) {
      assert.match(sql, /count\(DISTINCT uid\)/, "must count uid");
      assert.doesNotMatch(
        sql,
        /count\(DISTINCT hotkey\)/,
        "hotkey is NULL on every WeightsSet row -- counting it yields zeros",
      );
    }
  });

  test("the spec declares uid as its distinct column", () => {
    assert.equal(CHAIN_WEIGHTS_ROLLUP.distinctColumn, "uid");
    assert.equal(CHAIN_WEIGHTS_ROLLUP.eventKind, "WeightsSet");
  });

  test("the column names match what the builder reads", async () => {
    // buildChainWeights reads row.distinct_setters and row.weight_sets. A
    // mismatch leaves it reading undefined and skipping every subnet, which
    // renders as an empty leaderboard rather than an error.
    const engine = fakeEngine();
    await loadChainWeightsColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query,
    });
    assert.match(engine.rowsSql()!, /AS weight_sets/);
    assert.match(engine.rowsSql()!, /AS distinct_setters/);
  });
});

describe("the loader's contract", () => {
  test("builds the response shape callers hand straight to their envelope", async () => {
    const engine = fakeEngine();
    const data = await loadChainWeightsColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query,
    });
    assert.ok(data);
    assert.equal(data.window, "7d");
    assert.ok(Array.isArray(data.subnets));
    assert.equal(data.subnets.length, 1);
  });

  test("the network total is the queried value, not a sum of the rows", async () => {
    // A uid is unique per subnet, so uids DO repeat across subnets: summing
    // per-subnet counts would double-count the same validator on every subnet
    // it operates on.
    const engine = fakeEngine({
      rows: [
        { netuid: 1, weight_sets: 10, distinct_setters: 5 },
        { netuid: 2, weight_sets: 10, distinct_setters: 5 },
      ],
      network: [{ distinct_setters: 6, newest_observed: 1_785_000_000_000 }],
    });
    const data = (await loadChainWeightsColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query,
    })) as unknown as { network: { distinct_setters: number } };
    assert.equal(
      data.network.distinct_setters,
      6,
      "must be the queried total, not 5 + 5",
    );
  });

  test("an unknown window falls back to 7d rather than widening the range", async () => {
    // Silently scanning longer would answer a different question than the
    // label the caller sees echoed back in the response.
    const engine = fakeEngine();
    await loadChainWeightsColdTier({} as never, {
      window: "all-time",
      limit: 20,
      query: engine.query,
    });
    const cutoff = Number(/observed_at >= (\d+)/.exec(engine.rowsSql()!)![1]);
    const days = (Date.now() - cutoff) / 86_400_000;
    assert.ok(
      days > 6.9 && days < 7.1,
      `expected 7d, got ~${days.toFixed(2)}d`,
    );
  });

  test("a lakehouse miss declines so each caller keeps its own fallback", async () => {
    for (const miss of [{ rows: null }, { network: null }, { rows: [] }]) {
      const engine = fakeEngine(miss);
      assert.equal(
        await loadChainWeightsColdTier({} as never, {
          window: "7d",
          limit: 20,
          query: engine.query,
        }),
        null,
        `${JSON.stringify(miss)} must decline`,
      );
    }
  });
});

describe("all three surfaces go through the one loader", () => {
  const sources = {
    REST: "workers/request-handlers/analytics.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadChainWeightsColdTier", () => {
    // The regression this guards: a surface wired to the lakehouse while its
    // siblings answer zeros, with no way for a caller to tell which is right.
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadChainWeightsColdTier\(/,
        `${surface} (${path}) would answer the zeroed card while its siblings answer real numbers`,
      );
    }
  });
});
