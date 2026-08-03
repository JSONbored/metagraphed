// The Analytics Engine hot tier for /api/v1/rpc/usage (#9228).
//
// Two properties carry the weight here.
//
// FIRST, the tier boundary. The hot tier and src/rpc-usage-cold-tier.ts feed
// one formatter and publish one shape, with exactly ONE deliberate
// difference: measured p50/p95 here, null there. These tests pin both halves
// of that -- that the percentiles are real numbers when AE answers, and that
// nothing else about the payload diverges.
//
// SECOND, the sampling correction. Every aggregate must weight by
// `_sample_interval`; a raw COUNT(*) would agree with the corrected form in
// every fixture and every low-traffic deployment, and start silently
// undercounting only once AE decides to sample. So the SQL is asserted, not
// just the numbers it produces.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  bucketInterval,
  hotWindowBounds,
  loadRpcUsageHotTier,
} from "../src/rpc-usage-hot-tier.ts";
import { ANALYTICS_SQL_TOKEN_ENV } from "../src/analytics-engine-sql.ts";
import type { Row } from "./row-type.ts";

const ENV = { [ANALYTICS_SQL_TOKEN_ENV]: "test-token" } as unknown as Env;

/** Seconds, because that is what AE's toUnixTimestamp returns. */
const OBSERVED_AT_S = 1_785_709_179;

/**
 * A query seam handing back one canned result set per call, in the order
 * loadRpcUsageHotTier issues them, and recording the SQL it was asked for.
 */
function cannedQuery(sets: (Row[] | null)[]) {
  const sql: string[] = [];
  const query = (async (_env: unknown, statement: string) => {
    sql.push(statement);
    // `?? []` would be wrong here: null is the client's DECLINE signal and
    // the tier's handling of it is exactly what several of these tests are
    // about, so a null set must survive the lookup.
    const set = sets[sql.length - 1];
    return set === undefined ? [] : set;
  }) as never;
  return { query, sql };
}

const TOTALS = [
  {
    total: 1000,
    ok_count: 950,
    failover_count: 40,
    cache_hits: 250,
    avg_latency_ms: 125.4,
    p50: 87.2,
    p95: 402.8,
    observed_at_s: OBSERVED_AT_S,
  },
];
const ENDPOINTS = [
  {
    endpoint_id: "onfinality-finney-rpc",
    provider: "onfinality",
    network: "finney",
    requests: 700,
    ok_count: 690,
    avg_latency_ms: 83,
  },
  {
    endpoint_id: "",
    provider: "",
    network: "finney",
    requests: 300,
    ok_count: 260,
    avg_latency_ms: 4,
  },
];
const NETWORKS = [
  { network: "finney", requests: 990, ok_count: 945 },
  { network: "test", requests: 10, ok_count: 5 },
];
const BUCKETS = [
  {
    ts: OBSERVED_AT_S - 3600,
    requests: 400,
    ok_count: 390,
    avg_latency_ms: 90,
  },
  { ts: OBSERVED_AT_S, requests: 600, ok_count: 560, avg_latency_ms: 140 },
];

const FULL = [TOTALS, ENDPOINTS, NETWORKS, BUCKETS];

describe("loadRpcUsageHotTier", () => {
  test("serves a full payload with MEASURED percentiles", async () => {
    const { query } = cannedQuery(FULL);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;

    assert.equal(out.window, "7d");
    assert.equal(out.bucket_granularity, "1h");
    assert.equal(out.source, "rpc-proxy");
    assert.equal(out.summary.total_requests, 1000);
    assert.equal(out.summary.error_requests, 50);
    assert.equal(out.summary.error_rate, 0.05);
    assert.equal(out.summary.failover_rate, 0.04);
    assert.equal(out.summary.cache_hit_rate, 0.25);
    assert.equal(out.summary.latency_ms.avg, 125);
    // THE DIVERGENCE, asserted rather than described: AE has weighted
    // quantiles, so these are real measurements. The lakehouse tier reports
    // null here because R2 SQL has no percentile function and it refuses to
    // synthesise one from an average.
    assert.equal(out.summary.latency_ms.p50, 87);
    assert.equal(out.summary.latency_ms.p95, 403);
  });

  test("converts AE's second-resolution timestamps to the published ms", async () => {
    // Every timestamp this route publishes is epoch ms (the lakehouse tier's
    // are); AE's toUnixTimestamp returns seconds. A missed conversion would
    // date every bucket to 1970 while still looking like a number.
    const { query } = cannedQuery(FULL);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;
    assert.equal(out.observed_at, OBSERVED_AT_S * 1000);
    assert.deepEqual(
      (out.buckets as Row[]).map((bucket) => bucket.ts),
      [(OBSERVED_AT_S - 3600) * 1000, OBSERVED_AT_S * 1000],
    );
  });

  test("maps the empty-endpoint sentinel back to the cold tier's null", async () => {
    // The writer stores "" (a GROUP BY needs a value); the lakehouse tier's
    // equivalent group carries a real NULL. Two tiers must not serve visibly
    // different endpoint rows for the same traffic.
    const { query } = cannedQuery(FULL);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;
    const endpoints = out.endpoints as Row[];
    assert.equal(endpoints[0]!.endpoint_id, "onfinality-finney-rpc");
    assert.equal(endpoints[1]!.endpoint_id, null);
    assert.equal(endpoints[1]!.provider, null);
    assert.equal(endpoints[1]!.error_rate, 0.1333);
  });

  test("derives bucket errors from requests minus ok", async () => {
    const { query } = cannedQuery(FULL);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;
    assert.deepEqual(
      (out.buckets as Row[]).map((bucket) => bucket.errors),
      [10, 40],
    );
  });

  test("clamps a nonsensical bucket to a non-negative error count", async () => {
    const { query } = cannedQuery([
      TOTALS,
      ENDPOINTS,
      NETWORKS,
      [{ ts: OBSERVED_AT_S, requests: 5, ok_count: 9 }],
    ]);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;
    assert.equal((out.buckets as Row[])[0]!.errors, 0);
  });

  test("a bucket row with no counters reads as zero, not NaN", async () => {
    const { query } = cannedQuery([
      TOTALS,
      ENDPOINTS,
      NETWORKS,
      [{ ts: OBSERVED_AT_S }],
    ]);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;
    assert.deepEqual((out.buckets as Row[])[0], {
      ts: OBSERVED_AT_S * 1000,
      requests: 0,
      errors: 0,
      avg_latency_ms: null,
    });
  });

  test("a totals row with no observed_at reports null rather than 1970", async () => {
    const { query } = cannedQuery([[{ total: 5, ok_count: 5 }], [], [], []]);
    const out = (await loadRpcUsageHotTier(ENV, { query })) as Row;
    assert.equal(out.observed_at, null);
  });
});

describe("the SQL the hot tier issues", () => {
  test("every aggregate is sampling-corrected", async () => {
    const { query, sql } = cannedQuery(FULL);
    await loadRpcUsageHotTier(ENV, { query });
    assert.equal(sql.length, 4, "totals, endpoints, networks, buckets");
    for (const statement of sql) {
      assert.ok(
        !/\bCOUNT\(\*\)/i.test(statement),
        `a raw COUNT(*) undercounts a sampled dataset: ${statement}`,
      );
      assert.match(statement, /SUM\(_sample_interval\)/);
    }
    // Sums and averages are weighted too, not just counts.
    assert.match(sql[0]!, /SUM\(_sample_interval \* double1\)/);
    assert.match(
      sql[0]!,
      /SUM\(_sample_interval \* double3\) \/ nullif\(SUM\(_sample_interval\), 0\)/,
    );
  });

  test("percentiles are weighted quantiles over the latency slot", async () => {
    const { query, sql } = cannedQuery(FULL);
    await loadRpcUsageHotTier(ENV, { query });
    assert.match(
      sql[0]!,
      /quantileExactWeighted\(0\.5\)\(double3, _sample_interval\) AS p50/,
    );
    assert.match(
      sql[0]!,
      /quantileExactWeighted\(0\.95\)\(double3, _sample_interval\) AS p95/,
    );
  });

  test("every query is scoped to the PUBLIC pool", async () => {
    // The gated fullnode gate writes into the same dataset so it finally has
    // telemetry of its own, but /api/v1/rpc/usage has published the public
    // pool's distribution since B3. Dropping this filter would silently
    // redefine a live route and violate ADR 0021's isolation requirement in
    // the data model.
    const { query, sql } = cannedQuery(FULL);
    await loadRpcUsageHotTier(ENV, { query });
    for (const statement of sql) {
      assert.match(statement, /WHERE blob1 = 'public'/);
    }
  });

  test("the window and bucket width follow the requested label", async () => {
    const seven = cannedQuery(FULL);
    await loadRpcUsageHotTier(ENV, { query: seven.query });
    assert.match(seven.sql[0]!, /INTERVAL '7' DAY/);
    assert.match(
      seven.sql[3]!,
      /toStartOfInterval\(timestamp, INTERVAL '1' HOUR\)/,
    );

    const thirty = cannedQuery(FULL);
    const out = (await loadRpcUsageHotTier(ENV, {
      window: "30d",
      query: thirty.query,
    })) as Row;
    assert.match(thirty.sql[0]!, /INTERVAL '30' DAY/);
    assert.match(
      thirty.sql[3]!,
      /toStartOfInterval\(timestamp, INTERVAL '6' HOUR\)/,
    );
    assert.equal(out.bucket_granularity, "6h");
  });

  test("groups endpoints by the declared blob slots", async () => {
    const { query, sql } = cannedQuery(FULL);
    await loadRpcUsageHotTier(ENV, { query });
    assert.match(sql[1]!, /GROUP BY blob3, blob4, blob2/);
    assert.match(sql[2]!, /GROUP BY blob2/);
  });
});

describe("declining rather than half-answering", () => {
  test("no read token declines without issuing a query", async () => {
    // The state this ships in: capture starts on deploy, the read token is
    // provisioned separately, and until it exists the route answers from the
    // lakehouse exactly as it does today.
    let asked = false;
    const query = (async () => {
      asked = true;
      return [];
    }) as never;
    assert.equal(await loadRpcUsageHotTier(null, { query }), null);
    assert.equal(
      await loadRpcUsageHotTier({} as unknown as Env, { query }),
      null,
    );
    assert.equal(asked, false);
  });

  test("an untouched window declines so the lakehouse can answer it", async () => {
    assert.equal(
      await loadRpcUsageHotTier(ENV, {
        query: cannedQuery([[], [], [], []]).query,
      }),
      null,
    );
    assert.equal(
      await loadRpcUsageHotTier(ENV, {
        query: cannedQuery([[{ total: 0 }], [], [], []]).query,
      }),
      null,
    );
    assert.equal(
      await loadRpcUsageHotTier(ENV, {
        query: cannedQuery([[{ total: null }], [], [], []]).query,
      }),
      null,
    );
  });

  test("any failed rollup declines — never a partial answer", async () => {
    // A rollup that silently lost its endpoint breakdown would read as "no
    // endpoints served traffic", which is a different and wrong claim.
    for (let failing = 0; failing < 4; failing += 1) {
      const sets = FULL.map((set, index) => (index === failing ? null : set));
      assert.equal(
        await loadRpcUsageHotTier(ENV, { query: cannedQuery(sets).query }),
        null,
        `rollup ${failing} failing must decline the whole answer`,
      );
    }
  });

  test("a window the config cannot express declines before querying", async () => {
    // Reached through the same seam hotWindowBounds documents: a bucket width
    // that is not a whole number of hours has no AE INTERVAL, and bucketing
    // the series wrongly would be worse than declining it.
    let asked = false;
    const query = (async () => {
      asked = true;
      return [];
    }) as never;
    assert.equal(
      await loadRpcUsageHotTier(ENV, { query, bucketMs: 90_000 }),
      null,
    );
    assert.equal(asked, false);
  });

  test("an unknown window label normalizes to 7d rather than erroring", async () => {
    const { query, sql } = cannedQuery(FULL);
    const out = (await loadRpcUsageHotTier(ENV, {
      window: "90d",
      query,
    })) as Row;
    assert.equal(out.window, "7d");
    assert.match(sql[0]!, /INTERVAL '7' DAY/);
  });

  test("query deps are threaded through to the client", async () => {
    // The route needs to be able to hand the client a shorter ceiling or a
    // test double; a dep that silently stopped propagating would only show
    // up as a hung request.
    const seen: unknown[] = [];
    const query = (async (_env: unknown, _sql: string, deps: unknown) => {
      seen.push(deps);
      return [];
    }) as never;
    const deps = { timeoutMs: 1 };
    await loadRpcUsageHotTier(ENV, { query, deps });
    assert.equal(seen.length, 4);
    for (const passed of seen) assert.equal(passed, deps);
  });
});

describe("window bounds", () => {
  test("resolve the configured windows", () => {
    assert.deepEqual(hotWindowBounds("7d"), {
      days: 7,
      interval: "INTERVAL '1' HOUR",
      granularity: "1h",
    });
    assert.deepEqual(hotWindowBounds("30d"), {
      days: 30,
      interval: "INTERVAL '6' HOUR",
      granularity: "6h",
    });
  });

  test("reject a window the config does not define", () => {
    // `days` is inlined into an INTERVAL literal -- AE has no bound
    // parameters, so anything that is not a validated integer is refused
    // rather than interpolated.
    assert.equal(hotWindowBounds("90d"), null);
    assert.equal(hotWindowBounds(""), null);
  });

  test("reject a bucket width that is not a whole number of hours", () => {
    // AE's toStartOfInterval takes a unit, and RPC_USAGE_BUCKETS is declared
    // in ms; a width that does not divide into hours has no valid INTERVAL.
    assert.equal(hotWindowBounds("7d", 0), null);
    assert.equal(hotWindowBounds("7d", 90_000), null);
    assert.equal(
      hotWindowBounds("7d", 7_200_000)?.interval,
      "INTERVAL '2' HOUR",
    );
    assert.equal(bucketInterval(7_200_000), "INTERVAL '2' HOUR");
    assert.equal(bucketInterval(90_000), null);
    assert.equal(bucketInterval(0), null);
    assert.equal(bucketInterval(-3_600_000), null);
  });
});
