// The ONE composer behind /api/v1/rpc/usage (#9269 + #9293).
//
// Two failures live here, and they are the same failure seen from two sides.
//
// FROM THE SURFACE SIDE (#9269): three call sites each ran their own cascade,
// two of them stale, so GraphQL answered `total_requests: 0` at the same
// instant REST answered 118,309. These tests pin the cascade itself -- the
// order, and what each arm returns -- in the one place all three surfaces now
// share.
//
// FROM THE DATA SIDE (#9293): the hot tier DISPLACED the cold one, so a `7d`
// window over two captured hours published 3,990 requests where seven days
// served 578,506 -- a 99.3% under-report with a confident label on it. These
// tests pin the sum, and pin what the sum refuses to do: merge percentiles,
// or claim a range it did not measure.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  answerRpcUsage,
  coverageStart,
  hotTierCoversWindow,
  mergeRpcUsage,
} from "../src/rpc-usage-answer.ts";
import { formatRpcUsage } from "../src/health-serving.ts";
import type { Row } from "./row-type.ts";

const NOW = 1_785_000_000_000;
const HOUR = 3_600_000;

/** The real shape both tiers publish, built through the real formatter so a
 * change to it cannot leave these fixtures describing a payload that no
 * longer exists. */
function coldPayload(overrides: Row = {}): Row {
  return formatRpcUsage({
    window: "7d",
    bucketGranularity: "1h",
    observedAt: NOW - 12 * HOUR,
    totals: {
      total: 578_506,
      ok_count: 578_000,
      failover_count: 400,
      cache_hits: 120_000,
      avg_latency_ms: 100,
    },
    endpointRows: [
      {
        endpoint_id: "onfinality-finney-rpc",
        provider: "onfinality",
        requests: 578_000,
        ok_count: 577_600,
        avg_latency_ms: 100,
      },
      {
        endpoint_id: "lakehouse-only",
        provider: "legacy",
        requests: 506,
        ok_count: 400,
        avg_latency_ms: 250,
      },
    ],
    networkRows: [
      {
        network: "finney",
        requests: 578_506,
        ok_count: 578_000,
        avg_latency_ms: 100,
      },
    ],
    bucketRows: [
      {
        ts: NOW - 13 * HOUR,
        requests: 300,
        errors: 3,
        avg_latency_ms: 100,
      },
      { ts: NOW - 12 * HOUR, requests: 200, errors: 2, avg_latency_ms: 110 },
    ],
    coverage: {
      segments: [
        {
          source: "lakehouse",
          start: NOW - 7 * 24 * HOUR,
          end: NOW - 12 * HOUR,
        },
      ],
    },
    ...overrides,
  });
}

function hotPayload(overrides: Row = {}): Row {
  return formatRpcUsage({
    window: "7d",
    bucketGranularity: "1h",
    observedAt: NOW,
    totals: {
      total: 3_990,
      ok_count: 3_900,
      failover_count: 10,
      cache_hits: 1_000,
      avg_latency_ms: 50,
    },
    latency: { p50: 41, p95: 190 },
    endpointRows: [
      {
        endpoint_id: "onfinality-finney-rpc",
        provider: "onfinality",
        requests: 3_990,
        ok_count: 3_900,
        avg_latency_ms: 50,
      },
    ],
    networkRows: [
      { network: "finney", requests: 3_890, ok_count: 3_800 },
      { network: "test", requests: 100, ok_count: 100 },
    ],
    bucketRows: [
      { ts: NOW - HOUR, requests: 1_990, errors: 50, avg_latency_ms: 50 },
      { ts: NOW, requests: 2_000, errors: 40, avg_latency_ms: 50 },
    ],
    coverage: {
      segments: [
        { source: "analytics-engine", start: NOW - 2 * HOUR, end: NOW },
      ],
      latency: { start: NOW - 2 * HOUR, end: NOW },
    },
    ...overrides,
  });
}

/** A cascade whose every arm is a stub, so the ORDER is what is under test
 * rather than any engine's behaviour. Records what each arm was asked for. */
function stubs({
  hot = null,
  cold = null,
  postgres = null,
}: { hot?: Row | null; cold?: Row | null; postgres?: Row | null } = {}) {
  const calls: string[] = [];
  const coldArgs: Row[] = [];
  return {
    calls,
    coldArgs,
    hotTier: (async () => {
      calls.push("hot");
      return hot;
    }) as never,
    coldTier: (async (_env: unknown, options: Row) => {
      calls.push("cold");
      coldArgs.push(options);
      return cold;
    }) as never,
    postgresTier: (async () => {
      calls.push("postgres");
      return postgres;
    }) as never,
    floor: (async (options: Row) => {
      calls.push("floor");
      return { floor: true, ...options } as Row;
    }) as never,
  };
}

const ENV = {} as unknown as Env;
const PG_REQUEST = new Request("https://example.invalid/api/v1/rpc/usage");

describe("summing two disjoint stores", () => {
  test("counts are additive, so the merged window reports the real magnitude", async () => {
    const merged = mergeRpcUsage(coldPayload(), hotPayload());
    const summary = merged.summary as Row;
    // 578,506 + 3,990 -- not the 3,990 the hot tier published on its own.
    assert.equal(summary.total_requests, 582_496);
    assert.equal(summary.ok_requests, 581_900);
    assert.equal(summary.error_requests, 596);
    assert.equal(summary.failover_requests, 410);
    assert.equal(summary.cache_hits, 121_000);
  });

  test("rates are recomputed from the sums, not averaged", async () => {
    const summary = mergeRpcUsage(coldPayload(), hotPayload()).summary as Row;
    assert.equal(summary.error_rate, Number((596 / 582_496).toFixed(4)));
    assert.equal(
      summary.cache_hit_rate,
      Number((121_000 / 582_496).toFixed(4)),
    );
  });

  test("the average latency is weighted by request count", async () => {
    // (100 x 578,506 + 50 x 3,990) / 582,496 == 99.65..., not (100+50)/2.
    const summary = mergeRpcUsage(coldPayload(), hotPayload()).summary as Row;
    assert.equal((summary.latency_ms as Row).avg, 100);
  });

  test("PERCENTILES ARE NOT MERGED -- they stay AE's, and say what they cover", async () => {
    // quantileExactWeighted cannot be combined with a store that has no
    // percentile function at all. Reporting AE's p50 as the whole window's p50
    // would be a claim about a sub-range, so the sub-range is published.
    const merged = mergeRpcUsage(coldPayload(), hotPayload());
    const latency = (merged.summary as Row).latency_ms as Row;
    assert.equal(latency.p50, 41);
    assert.equal(latency.p95, 190);
    assert.deepEqual((merged.coverage as Row).latency_percentiles, {
      start: NOW - 2 * HOUR,
      end: NOW,
    });
  });

  test("the payload publishes both spans AND the hole between them", async () => {
    // The lakehouse froze before AE capture began, so there is a real gap no
    // store covers. A single start/end pair would paper over it; the segment
    // list is what makes it visible.
    const coverage = mergeRpcUsage(coldPayload(), hotPayload()).coverage as Row;
    assert.equal(coverage.start, NOW - 7 * 24 * HOUR);
    assert.equal(coverage.end, NOW);
    assert.deepEqual(coverage.segments, [
      { source: "lakehouse", start: NOW - 7 * 24 * HOUR, end: NOW - 12 * HOUR },
      { source: "analytics-engine", start: NOW - 2 * HOUR, end: NOW },
    ]);
  });

  test("an endpoint in both stores is one row, summed", async () => {
    const endpoints = mergeRpcUsage(coldPayload(), hotPayload())
      .endpoints as Row[];
    assert.equal(endpoints.length, 2);
    assert.equal(endpoints[0]!.endpoint_id, "onfinality-finney-rpc");
    assert.equal(endpoints[0]!.requests, 581_990);
    assert.equal(endpoints[0]!.ok_requests, 581_500);
    // Ranked by the MERGED volume, and re-ranked from 1.
    assert.equal(endpoints[0]!.rank, 1);
    assert.equal(endpoints[1]!.endpoint_id, "lakehouse-only");
    assert.equal(endpoints[1]!.rank, 2);
  });

  test("a network only one store saw survives the merge", async () => {
    const networks = mergeRpcUsage(coldPayload(), hotPayload())
      .networks as Row[];
    assert.equal(networks.length, 2);
    assert.equal(networks[0]!.network, "finney");
    assert.equal(networks[0]!.requests, 582_396);
    assert.equal(networks[1]!.network, "test");
    assert.equal(networks[1]!.requests, 100);
  });

  test("buckets concatenate in time order and keep their own error counts", async () => {
    const buckets = mergeRpcUsage(coldPayload(), hotPayload()).buckets as Row[];
    assert.deepEqual(
      buckets.map((bucket) => bucket.ts),
      [NOW - 13 * HOUR, NOW - 12 * HOUR, NOW - HOUR, NOW],
    );
    assert.deepEqual(
      buckets.map((bucket) => bucket.errors),
      [3, 2, 50, 40],
    );
  });

  test("a bucket both stores reported is folded, not duplicated", async () => {
    // The two stores are disjoint in practice; folding on `ts` makes that a
    // property of the code rather than of today's data.
    const cold = coldPayload({
      bucketRows: [{ ts: NOW, requests: 5, errors: 1, avg_latency_ms: 200 }],
    });
    const buckets = mergeRpcUsage(cold, hotPayload()).buckets as Row[];
    const atNow = buckets.filter((bucket) => bucket.ts === NOW);
    assert.equal(atNow.length, 1);
    assert.equal(atNow[0]!.requests, 2_005);
    assert.equal(atNow[0]!.errors, 41);
  });

  test("observed_at is the newest reading of either store", async () => {
    assert.equal(mergeRpcUsage(coldPayload(), hotPayload()).observed_at, NOW);
  });

  test("a store with nothing to add cannot corrupt the merge", async () => {
    // Not a shape either tier produces today -- both decline an empty window --
    // but a merge that turned an absent series into NaN would publish
    // `avg_latency_ms: null` as though nothing had been measured.
    const empty = formatRpcUsage({ window: "7d" });
    const merged = mergeRpcUsage(empty, hotPayload());
    assert.equal((merged.summary as Row).total_requests, 3_990);
    assert.equal(((merged.summary as Row).latency_ms as Row).avg, 50);
    assert.equal(merged.bucket_granularity, "1h");
    assert.equal((merged.coverage as Row).end, NOW);
  });

  test("a merge with no measured average reports null, not zero", async () => {
    const cold = coldPayload({ totals: { total: 0 } });
    const hot = hotPayload({ totals: { total: 0 }, latency: {} });
    const summary = mergeRpcUsage(cold, hot).summary as Row;
    assert.equal((summary.latency_ms as Row).avg, null);
    assert.equal(summary.total_requests, 0);
  });

  test("two stores with no reading report an unmeasured observed_at", async () => {
    // Math.max over two absent readings is 0, and epoch 0 published as
    // `observed_at` would date the answer to 1970 while still looking like a
    // timestamp -- the same 1970 hazard the hot tier's second/ms conversion has.
    const empty = formatRpcUsage({ window: "7d" });
    assert.equal(mergeRpcUsage(empty, empty).observed_at, null);
  });

  test("the unlabelled endpoint and network groups survive the merge", async () => {
    // Both engines have a "no endpoint" group -- a real NULL in the lakehouse,
    // the "" sentinel mapped back to NULL in Analytics Engine. Keying on the
    // raw value would make those two groups collide with each other or split
    // into two rows for the same traffic.
    const cold = coldPayload({
      endpointRows: [
        { endpoint_id: null, requests: 40, ok_count: 39, avg_latency_ms: 90 },
      ],
      networkRows: [{ requests: 40, ok_count: 39 }],
    });
    const hot = hotPayload({
      endpointRows: [
        { endpoint_id: null, provider: null, requests: 10, ok_count: 9 },
      ],
      networkRows: [{ requests: 10, ok_count: 9 }],
    });
    const merged = mergeRpcUsage(cold, hot);
    const endpoints = merged.endpoints as Row[];
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0]!.endpoint_id, null);
    assert.equal(endpoints[0]!.provider, null);
    assert.equal(endpoints[0]!.requests, 50);
    const networks = merged.networks as Row[];
    assert.equal(networks.length, 1);
    assert.equal(networks[0]!.requests, 50);
  });

  test("a store that measured no start still sorts into the segment list", async () => {
    // The lakehouse rollup can come back without a min(observed_at). Its
    // segment is still real -- it contributed rows -- so it belongs in the
    // list, with an unmeasured start rather than a fabricated one.
    const cold = coldPayload({
      coverage: {
        segments: [{ source: "lakehouse", start: null, end: NOW - 12 * HOUR }],
      },
    });
    const coverage = mergeRpcUsage(cold, hotPayload()).coverage as Row;
    assert.deepEqual(coverage.segments, [
      { source: "lakehouse", start: null, end: NOW - 12 * HOUR },
      { source: "analytics-engine", start: NOW - 2 * HOUR, end: NOW },
    ]);
    // `start` is the oldest MEASURED event, so it comes from the segment that
    // has one rather than reading as epoch 0.
    assert.equal(coverage.start, NOW - 2 * HOUR);
  });
});

describe("when the lakehouse is consulted at all", () => {
  test("a hot tier that already spans the window skips the cold read", async () => {
    // The transitional cost has to end by itself. Once AE's retention reaches
    // back to the window's cutoff there is nothing left for the lakehouse to
    // contribute, and issuing the scan forever would be a permanent cost for a
    // permanently empty answer.
    const covering = hotPayload({
      coverage: {
        segments: [
          {
            source: "analytics-engine",
            start: NOW - 7 * 24 * HOUR + 1_000,
            end: NOW,
          },
        ],
        latency: { start: NOW - 7 * 24 * HOUR + 1_000, end: NOW },
      },
    });
    const s = stubs({ hot: covering, cold: coldPayload() });
    const out = await answerRpcUsage(ENV, { ...s, now: NOW });
    assert.deepEqual(s.calls, ["hot"]);
    assert.equal((out.summary as Row).total_requests, 3_990);
  });

  test("a partial hot tier bounds the cold read at its own oldest event", async () => {
    const s = stubs({ hot: hotPayload(), cold: coldPayload() });
    const out = await answerRpcUsage(ENV, { ...s, now: NOW });
    assert.deepEqual(s.calls, ["hot", "cold"]);
    assert.equal(s.coldArgs[0]!.until, NOW - 2 * HOUR);
    assert.equal((out.summary as Row).total_requests, 582_496);
  });

  test("a declining hot tier leaves the cold read unbounded above", async () => {
    const s = stubs({ cold: coldPayload() });
    const out = await answerRpcUsage(ENV, { ...s, now: NOW });
    assert.equal(s.coldArgs[0]!.until, null);
    assert.equal((out.summary as Row).total_requests, 578_506);
  });

  test("the window label is normalised before either store is asked", async () => {
    const s = stubs({ cold: coldPayload() });
    await answerRpcUsage(ENV, { ...s, window: "90d", now: NOW });
    assert.equal(s.coldArgs[0]!.window, "7d");
  });
});

describe("the cascade order, in one place instead of three", () => {
  test("the hot tier alone answers when the lakehouse declines", async () => {
    const s = stubs({ hot: hotPayload() });
    const out = await answerRpcUsage(ENV, {
      ...s,
      now: NOW,
      postgresRequest: PG_REQUEST,
    });
    assert.deepEqual(s.calls, ["hot", "cold"]);
    assert.equal((out.summary as Row).total_requests, 3_990);
  });

  test("the Postgres tier is only reached when Analytics Engine had nothing", async () => {
    const s = stubs({ hot: hotPayload(), cold: coldPayload() });
    await answerRpcUsage(ENV, {
      ...s,
      now: NOW,
      postgresRequest: PG_REQUEST,
    });
    assert.equal(s.calls.includes("postgres"), false);
  });

  test("the Postgres tier keeps its historical place ahead of the lakehouse", async () => {
    const s = stubs({
      cold: coldPayload(),
      postgres: { summary: { total_requests: 42 } } as Row,
    });
    const out = await answerRpcUsage(ENV, {
      ...s,
      now: NOW,
      postgresRequest: PG_REQUEST,
    });
    assert.deepEqual(s.calls, ["hot", "cold", "postgres"]);
    assert.equal((out.summary as Row).total_requests, 42);
  });

  test("a surface with no upstream request skips the Postgres tier entirely", async () => {
    const s = stubs({ cold: coldPayload() });
    await answerRpcUsage(ENV, { ...s, now: NOW });
    assert.equal(s.calls.includes("postgres"), false);
  });

  test("the zeroed floor is reached ONLY when every store declined", async () => {
    // The bug in #9269, stated as a test: this shape is correct when nothing
    // was measured and wrong whenever something was.
    const s = stubs();
    const out = await answerRpcUsage(ENV, {
      ...s,
      now: NOW,
      observedAt: "2026-08-03T00:00:00.000Z",
      postgresRequest: PG_REQUEST,
    });
    assert.deepEqual(s.calls, ["hot", "cold", "postgres", "floor"]);
    assert.equal(out.floor, true);
    assert.equal(out.observedAt, "2026-08-03T00:00:00.000Z");
  });

  test("the real tiers are wired by default, and decline without credentials", async () => {
    // No AE token, no lakehouse token, no DATA_API binding: every real tier
    // declines without a subrequest and the floor answers, which is exactly
    // what a local/CI deployment must do.
    const out = await answerRpcUsage(ENV, { window: "30d", now: NOW });
    assert.equal(out.window, "30d");
    assert.equal((out.summary as Row).total_requests, 0);
    assert.deepEqual((out.coverage as Row).segments, []);
    assert.equal((out.coverage as Row).latency_percentiles, null);
  });
});

describe("reading a payload's own coverage", () => {
  test("coverageStart reports the oldest measured event, or null", () => {
    assert.equal(coverageStart(hotPayload()), NOW - 2 * HOUR);
    assert.equal(coverageStart(null), null);
    assert.equal(coverageStart(undefined), null);
    assert.equal(coverageStart({} as Row), null);
    assert.equal(coverageStart(formatRpcUsage({ window: "7d" })), null);
  });

  test("hotTierCoversWindow needs a start, a known window, and a real one", () => {
    assert.equal(hotTierCoversWindow(null, "7d", NOW), false);
    // Measured start two hours ago against a 7d cutoff: nowhere near covering.
    assert.equal(hotTierCoversWindow(hotPayload(), "7d", NOW), false);
    // An unknown window has no cutoff to compare against, so it cannot claim
    // coverage -- the lakehouse gets asked rather than silently skipped.
    assert.equal(hotTierCoversWindow(hotPayload(), "90d", NOW), false);
  });

  test("coverage is judged with one bucket of tolerance, not exact equality", () => {
    // AE's own predicate is `timestamp > now() - N DAY`, so its oldest event is
    // always a moment AFTER the cutoff. An exact comparison would keep issuing
    // a lakehouse read forever, long after AE covered the whole window.
    const cutoff = NOW - 7 * 24 * HOUR;
    const within = hotPayload({
      coverage: {
        segments: [
          { source: "analytics-engine", start: cutoff + HOUR, end: NOW },
        ],
      },
    });
    const beyond = hotPayload({
      coverage: {
        segments: [
          { source: "analytics-engine", start: cutoff + HOUR + 1, end: NOW },
        ],
      },
    });
    assert.equal(hotTierCoversWindow(within, "7d", NOW), true);
    assert.equal(hotTierCoversWindow(beyond, "7d", NOW), false);
  });
});
