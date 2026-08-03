// The lakehouse RPC-usage tier.
//
// /api/v1/rpc/usage served a zeroed rollup after the box wipe while 578,682
// verified rows of `rpc_proxy_events` sat in the lakehouse. The risk in fixing
// that is not "no data" -- it is publishing a rollup that LOOKS measured and
// is not: a partial answer that lost its endpoint breakdown reads as "no
// endpoints served traffic", and a synthesized p95 is indistinguishable from a
// real one.
//
// So the assertions here are mostly about what the tier REFUSES to say. Every
// SQL shape it emits was executed against the live engine while writing it
// (`count_if` rejected, `approx_percentile` rejected, CASE/avg/GROUP BY and
// integer-modulo bucketing all fine) -- these tests pin the resulting
// decisions so a regression fails here rather than in a published number.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadRpcUsageColdTier,
  windowCutoffMs,
} from "../src/rpc-usage-cold-tier.ts";
import { RPC_USAGE_BUCKETS } from "../workers/config.ts";

const NOW = 1_785_000_000_000;

/** Records the SQL each rollup emitted, and answers with canned rows. */
function fakeEngine(
  answers: Record<string, Record<string, unknown>[] | null> = {},
) {
  const seen: string[] = [];
  // `??` would turn an EXPLICIT null -- the failure this fake exists to
  // simulate -- back into an empty result, masking the decline path entirely.
  const pick = (
    value: Record<string, unknown>[] | null | undefined,
    fallback: Record<string, unknown>[],
  ) => (value === undefined ? fallback : value);
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (sql.includes("GROUP BY endpoint_id"))
      return pick(answers.endpoints, []);
    if (sql.includes("GROUP BY network")) return pick(answers.networks, []);
    if (sql.includes("% ")) return pick(answers.buckets, []);
    return pick(answers.totals, [{ total: 0 }]);
  };
  return { query, seen };
}

describe("the RPC-usage lakehouse tier", () => {
  test("the window cutoff is a safe integer, never a string", () => {
    // R2 SQL has NO bound parameters, so this value is interpolated straight
    // into SQL. A non-integer reaching the literal is an injection surface.
    const bounds = windowCutoffMs("7d", NOW);
    assert.ok(bounds);
    assert.equal(typeof bounds.cutoff, "number");
    assert.ok(Number.isSafeInteger(bounds.cutoff));
    assert.equal(bounds.cutoff, NOW - 7 * 24 * 60 * 60 * 1000);
  });

  test("the bucket size comes from config, not a literal in the query", () => {
    // 7d buckets hourly and 30d six-hourly. Hardcoding either would silently
    // mis-bucket the other window.
    for (const [label, config] of Object.entries(RPC_USAGE_BUCKETS)) {
      const bounds = windowCutoffMs(label, NOW);
      assert.ok(bounds, `${label} must resolve`);
      assert.equal(bounds.bucketMs, config.bucketMs);
      assert.equal(bounds.granularity, config.granularity);
    }
  });

  test("an unknown window resolves to nothing rather than a default scan", () => {
    // Falling back to a window silently would answer a question the caller
    // did not ask, over a different range than the label says.
    assert.equal(windowCutoffMs("all-time", NOW), null);
    assert.equal(windowCutoffMs("", NOW), null);
  });

  test("a clock before the epoch cannot produce a negative literal", () => {
    assert.equal(windowCutoffMs("7d", 0), null);
  });
});

describe("what the tier refuses to publish", () => {
  test("a window the frozen table no longer reaches declines", async () => {
    // The proxy that wrote these rows died with the box, so the newest row is
    // fixed. Once a window passes it entirely, publishing a zeroed rollup
    // would read as "measured silence" -- real traffic of zero -- rather than
    // "we have no data for this range".
    const engine = fakeEngine({ totals: [{ total: 0 }] });
    const result = await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    );
    assert.equal(result, null);
  });

  test("a failed rollup declines rather than half-answering", async () => {
    // r2SqlQuery returns null on ANY failure. If the endpoint breakdown is
    // the one that failed, serving the rest would claim no endpoint served
    // traffic -- a different and wrong statement from "the query failed".
    for (const failing of ["endpoints", "networks", "buckets"] as const) {
      const engine = fakeEngine({
        totals: [{ total: 10, ok_count: 10 }],
        endpoints: failing === "endpoints" ? null : [],
        networks: failing === "networks" ? null : [],
        buckets: failing === "buckets" ? null : [],
      });
      const result = await loadRpcUsageColdTier(
        {} as never,
        {
          window: "7d",
          now: NOW,
          query: engine.query,
        } as never,
      );
      assert.equal(result, null, `a failed ${failing} rollup must decline`);
    }
  });

  test("percentiles are null, never derived from the average", async () => {
    // R2 SQL rejects approx_percentile and the window is too large to compute
    // them in JS. A p95 inferred from the mean is a number no percentile of
    // the data supports, and a caller cannot tell it from a real one.
    const engine = fakeEngine({
      totals: [{ total: 100, ok_count: 99, avg_latency_ms: 125.3 }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    const result = (await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    )) as Record<string, Record<string, Record<string, unknown>>>;
    assert.ok(result);
    const latency = result.summary?.latency_ms;
    assert.equal(latency?.p50, null);
    assert.equal(latency?.p95, null);
    // The average IS measured, so it is reported.
    assert.equal(latency?.avg, 125);
  });
});

describe("the SQL it emits", () => {
  test("no rollup uses a function the engine rejects", async () => {
    // Measured against the live engine 2026-08-03: count_if and
    // approx_percentile are both rejected outright. A refactor reaching for
    // either would fail every query at runtime, not at build.
    const engine = fakeEngine({
      totals: [{ total: 1, ok_count: 1 }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    );
    assert.ok(engine.seen.length >= 4, "expected all four rollups");
    for (const sql of engine.seen) {
      assert.doesNotMatch(sql, /count_if/i, "count_if is rejected by R2 SQL");
      assert.doesNotMatch(sql, /percentile/i, "no percentile function exists");
    }
  });

  test("every rollup is bounded by the same window predicate", async () => {
    // Four separate scans, one window. A rollup that lost the predicate would
    // aggregate the whole frozen table and silently disagree with its peers.
    const engine = fakeEngine({
      totals: [{ total: 1, ok_count: 1 }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    );
    const cutoff = windowCutoffMs("7d", NOW)!.cutoff;
    for (const sql of engine.seen) {
      assert.ok(
        sql.includes(`observed_at >= ${cutoff}`),
        `a rollup dropped the window predicate: ${sql.slice(0, 80)}`,
      );
    }
  });

  test("the bucket literal follows the window, not one hardcoded size", async () => {
    // 7d buckets hourly and 30d six-hourly. Testing only 7d would let a
    // hardcoded 3600000 pass while silently mis-bucketing every 30d request
    // into six times too many points.
    for (const [label, config] of Object.entries(RPC_USAGE_BUCKETS)) {
      const engine = fakeEngine({
        totals: [{ total: 1, ok_count: 1 }],
        endpoints: [],
        networks: [],
        buckets: [],
      });
      await loadRpcUsageColdTier(
        {} as never,
        { window: label, now: NOW, query: engine.query } as never,
      );
      const bucketSql = engine.seen.find((sql) => sql.includes("% "));
      assert.ok(bucketSql, `${label} emitted no bucket rollup`);
      assert.ok(
        bucketSql.includes(`% ${config.bucketMs}`),
        `${label} must bucket by ${config.bucketMs}, got: ${bucketSql.slice(0, 70)}`,
      );
    }
  });

  test("every rollup is row-capped", async () => {
    // R2 SQL is second-scale with no indexes. An uncapped GROUP BY over this
    // table is the one read here that could pin a request open.
    const engine = fakeEngine({
      totals: [{ total: 1, ok_count: 1 }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    );
    for (const sql of engine.seen.filter((s) => s.includes("GROUP BY"))) {
      assert.match(
        sql,
        /LIMIT \d+/,
        `an uncapped GROUP BY: ${sql.slice(0, 80)}`,
      );
    }
  });
});

describe("the rows it hands the shared formatter", () => {
  test("bucket errors are derived from requests minus ok, never negative", async () => {
    // Only the bucket mapping reads a literal `errors` -- endpoints and
    // networks derive their own rate inside the formatter, so deriving it for
    // them would be an unused field pretending to be data.
    const engine = fakeEngine({
      totals: [{ total: 12, ok_count: 9 }],
      endpoints: [],
      networks: [],
      buckets: [
        { ts: NOW, requests: 10, ok_count: 7 },
        // ok exceeding requests cannot happen, but clamping beats publishing
        // a negative error count if a rollup ever disagrees with itself.
        { ts: NOW + 3_600_000, requests: 2, ok_count: 5 },
      ],
    });
    const result = (await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    )) as Record<string, unknown>;
    const buckets = result.buckets as Record<string, unknown>[];
    assert.equal(buckets[0].errors, 3);
    assert.equal(buckets[1].errors, 0);
  });

  test("observed_at is the data's own newest reading, not the clock", async () => {
    // The table is frozen. Reporting `now` would present stale traffic as
    // current; reporting max(observed_at) keeps the staleness visible.
    const newest = 1_784_900_000_000;
    const engine = fakeEngine({
      totals: [{ total: 5, ok_count: 5, observed_at: newest }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    const result = (await loadRpcUsageColdTier(
      {} as never,
      {
        window: "7d",
        now: NOW,
        query: engine.query,
      } as never,
    )) as Record<string, unknown>;
    assert.equal(result.observed_at, newest);
  });

  test("an unrecognised window label falls back to 7d rather than declining", async () => {
    // The route already normalises its label, but this loader is also reached
    // from MCP and GraphQL. Declining on an unfamiliar label would turn a
    // caller's typo into "no data" instead of the default window they get
    // everywhere else in the API.
    const engine = fakeEngine({
      totals: [{ total: 4, ok_count: 4 }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    const result = (await loadRpcUsageColdTier(
      {} as never,
      { window: "90d", now: NOW, query: engine.query } as never,
    )) as Record<string, unknown>;
    assert.ok(result, "an unknown label must still answer");
    assert.equal(result.window, "7d");
    const cutoff = windowCutoffMs("7d", NOW)!.cutoff;
    assert.ok(engine.seen[0].includes(`observed_at >= ${cutoff}`));
  });

  test("a clock that cannot produce a valid cutoff declines", async () => {
    // windowCutoffMs refuses a negative literal; the loader must carry that
    // refusal through rather than interpolating something malformed into SQL.
    const engine = fakeEngine({ totals: [{ total: 9, ok_count: 9 }] });
    const result = await loadRpcUsageColdTier(
      {} as never,
      { window: "7d", now: 0, query: engine.query } as never,
    );
    assert.equal(result, null);
    assert.deepEqual(
      engine.seen,
      [],
      "no query may be issued without a cutoff",
    );
  });

  // #9293: the composer sums this tier with the Analytics Engine one, and
  // that is only sound while the two describe strictly disjoint ranges.
  test("an `until` ceiling bounds every rollup above as well as below", async () => {
    const engine = fakeEngine({
      totals: [{ total: 3, ok_count: 3 }],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    const until = NOW - 3_600_000;
    await loadRpcUsageColdTier(
      {} as never,
      { window: "7d", now: NOW, until, query: engine.query } as never,
    );
    const cutoff = windowCutoffMs("7d", NOW)!.cutoff;
    assert.ok(engine.seen.length >= 4);
    for (const sql of engine.seen) {
      assert.ok(
        sql.includes(`observed_at >= ${cutoff} AND observed_at < ${until}`),
        `a rollup dropped the ceiling: ${sql.slice(0, 100)}`,
      );
    }
  });

  test("an unusable ceiling is dropped, never interpolated", async () => {
    // R2 SQL has no bound parameters. A non-integer ceiling must not reach the
    // literal -- and dropping it leaves the window's own cutoff in force,
    // which is a narrower answer than an injected one, never a wider one.
    for (const until of [1.5, -1, 0, Number.NaN, null]) {
      const engine = fakeEngine({
        totals: [{ total: 3, ok_count: 3 }],
        endpoints: [],
        networks: [],
        buckets: [],
      });
      await loadRpcUsageColdTier(
        {} as never,
        { window: "7d", now: NOW, until, query: engine.query } as never,
      );
      for (const sql of engine.seen) {
        assert.doesNotMatch(
          sql,
          /observed_at </,
          `an unusable ceiling (${String(until)}) reached the SQL`,
        );
      }
    }
  });

  test("publishes the span it measured, with no percentile range to scope", async () => {
    const oldest = 1_784_000_000_000;
    const newest = 1_784_900_000_000;
    const engine = fakeEngine({
      totals: [
        { total: 5, ok_count: 5, observed_from: oldest, observed_at: newest },
      ],
      endpoints: [],
      networks: [],
      buckets: [],
    });
    const result = (await loadRpcUsageColdTier(
      {} as never,
      { window: "7d", now: NOW, query: engine.query } as never,
    )) as Record<string, unknown>;
    const coverage = result.coverage as Record<string, unknown>;
    assert.equal(coverage.start, oldest);
    assert.equal(coverage.end, newest);
    assert.deepEqual(coverage.segments, [
      { source: "lakehouse", start: oldest, end: newest },
    ]);
    // Nothing measured a percentile here, and the payload says exactly that.
    assert.equal(coverage.latency_percentiles, null);
    assert.ok(engine.seen[0].includes("min(observed_at) AS observed_from"));
  });

  test("a bucket row missing its counts reads as zero, not NaN", async () => {
    // avg/count aggregates can come back absent for a bucket the engine
    // produced but could not summarise. NaN would serialise as null and read
    // as "unmeasured" rather than "nothing happened".
    const engine = fakeEngine({
      totals: [{ total: 1, ok_count: 1 }],
      endpoints: [],
      networks: [],
      buckets: [{ ts: NOW }],
    });
    const result = (await loadRpcUsageColdTier(
      {} as never,
      { window: "7d", now: NOW, query: engine.query } as never,
    )) as Record<string, unknown>;
    const buckets = result.buckets as Record<string, unknown>[];
    assert.equal(buckets[0].errors, 0);
    assert.equal(buckets[0].requests, 0);
  });
});
