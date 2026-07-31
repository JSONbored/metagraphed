// #8597: the all-traffic usage + cost rollup that unblocks ADR 0022's pricing
// decision.
//
// The properties under test are chosen for what would silently corrupt the
// answer rather than crash: cardinality must stay bounded (a per-path rollup is
// a cardinality bomb, not a rollup), cost shape must be the BILL axis rather
// than the quota's charge axis, and keyless traffic must be counted -- it is
// the majority by design and the entire subject of the question.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  UNMATCHED_FAMILY,
  COST_SHAPE_BY_FAMILY,
  costShapeForPath,
  foldObservations,
  observeRequest,
  routeFamily,
  type RouteMatcher,
} from "../src/usage-rollup.ts";
import { API_ROUTES, compileRoutePattern } from "../src/contracts.ts";
import { ROUTE_COST_WEIGHTS } from "../src/route-cost-weights.ts";
import type { Row } from "./row-type.ts";

const MATCHERS: RouteMatcher[] = API_ROUTES.map((entry) => ({
  path: entry.path,
  pattern: compileRoutePattern(entry.path),
}));

describe("route family is the route TEMPLATE, so cardinality is bounded", () => {
  test("concrete paths collapse to their template", () => {
    // The whole reason this exists: two different netuids are ONE family.
    const a = routeFamily("/api/v1/subnets/64", MATCHERS);
    const b = routeFamily("/api/v1/subnets/7", MATCHERS);
    assert.equal(a, b);
    assert.match(a, /\{netuid\}/);
  });

  test("many distinct paths produce a family set bounded by the route table", () => {
    // A per-path rollup would produce 300 families here. The bound is what
    // makes this a rollup rather than a log.
    const families = new Set<string>();
    for (let netuid = 0; netuid < 150; netuid += 1) {
      families.add(routeFamily(`/api/v1/subnets/${netuid}`, MATCHERS));
      families.add(routeFamily(`/api/v1/subnets/${netuid}/events`, MATCHERS));
    }
    assert.ok(
      families.size <= 4,
      `expected a handful of families, got ${families.size}`,
    );
    assert.ok(families.size < API_ROUTES.length);
  });

  test("every family it can emit is a real route template or the unmatched bucket", () => {
    // Guards against the normalizer inventing a label that no route serves --
    // which would make the readout un-joinable against the route table.
    const known = new Set(API_ROUTES.map((entry) => entry.path));
    for (const path of [
      "/api/v1/subnets",
      "/api/v1/subnets/64",
      "/api/v1/accounts/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      "/api/v1/coverage",
      "/api/v1/nonsense/deeply/nested",
    ]) {
      const family = routeFamily(path, MATCHERS);
      assert.ok(
        known.has(family) || family === UNMATCHED_FAMILY,
        `${path} → ${family}`,
      );
    }
  });

  test("unknown paths land in ONE bucket, not one bucket each", () => {
    // 404s and scanner traffic are unbounded in shape; bucketing them by path
    // is precisely the cardinality bomb being avoided.
    const families = new Set(
      [
        "/api/v1/wp-login.php",
        "/api/v1/../etc/passwd",
        "/api/v1/zzz/1/2/3",
      ].map((p) => routeFamily(p, MATCHERS)),
    );
    assert.deepEqual([...families], [UNMATCHED_FAMILY]);
  });

  test("degenerate input yields the unmatched bucket rather than throwing", () => {
    // This runs on the request path. It must never be able to fail a response.
    for (const bad of ["", null, undefined, 42, {}]) {
      assert.equal(routeFamily(bad as never, MATCHERS), UNMATCHED_FAMILY);
    }
    assert.equal(routeFamily("/api/v1/subnets", []), UNMATCHED_FAMILY);
  });

  test("a global regex cannot desync repeated matches", () => {
    // A global pattern's lastIndex makes .test() alternate true/false, which
    // would drop every other request for that family — a silent, halving bug.
    const sticky: RouteMatcher[] = [
      { path: "/api/v1/x", pattern: /\/api\/v1\/x/g },
    ];
    for (let i = 0; i < 4; i += 1) {
      assert.equal(routeFamily("/api/v1/x", sticky), "/api/v1/x");
    }
  });
});

describe("cost shape is the BILL axis, not the charge axis", () => {
  test("maps ADR 0022's four shapes", () => {
    assert.equal(costShapeForPath("/api/v1/ask"), "ai");
    assert.equal(costShapeForPath("/datasets/subnets.parquet"), "r2-bulk");
    assert.equal(costShapeForPath("/api/v1/chain-events"), "postgres");
    assert.equal(costShapeForPath("/api/v1/subnets"), "edge");
  });

  test("deep-history is POSTGRES, not edge — the memo's central claim", () => {
    // ADR 0022 turns on these consuming the indexer box's FIXED capacity
    // rather than metered edge. Collapsing them to "edge" would make the
    // rollup silently agree with a flat-multiplier model regardless of reality.
    assert.equal(costShapeForPath("/api/v1/accounts/5Abc/events"), "postgres");
    assert.notEqual(costShapeForPath("/api/v1/chain-events"), "edge");
  });

  test("EVERY cost family has a shape — adding one without a shape must fail here", () => {
    // This replaces a runtime guard that could never fire. The property that
    // actually matters is exhaustiveness: a new family in ROUTE_COST_WEIGHTS
    // with no entry here would otherwise be silently bucketed as "edge",
    // quietly understating exactly the expensive traffic ADR 0022 is about.
    for (const entry of ROUTE_COST_WEIGHTS) {
      assert.ok(
        Object.hasOwn(COST_SHAPE_BY_FAMILY, entry.family),
        `cost family "${entry.family}" has no cost shape`,
      );
    }
  });

  test("an unknown family degrades to edge rather than throwing", () => {
    assert.equal(costShapeForPath(""), "edge");
    assert.equal(costShapeForPath("not-a-path"), "edge");
  });
});

describe("observations and folding", () => {
  const AT = Date.UTC(2026, 6, 29, 12);

  test("an observation carries day, family, shape and keyed-ness", () => {
    const o = observeRequest("/api/v1/subnets/64", MATCHERS, {
      keyed: true,
      nowMs: AT,
    });
    assert.equal(o.day, "2026-07-29");
    assert.match(o.family, /\{netuid\}/);
    assert.equal(o.costShape, "edge");
    assert.equal(o.keyed, true);
  });

  test("keyed defaults to FALSE, so keyless is never miscounted as keyed", () => {
    // The keyless share is the number the pricing decision turns on. Defaulting
    // the other way would bias precisely the answer being sought.
    assert.equal(observeRequest("/api/v1/subnets", MATCHERS).keyed, false);
    assert.equal(
      observeRequest("/api/v1/subnets", MATCHERS, { keyed: "yes" as never })
        .keyed,
      false,
      "only a literal true counts as keyed",
    );
  });

  test("folding coalesces a burst into one bucket per (day, family, shape)", () => {
    const observations = [
      observeRequest("/api/v1/subnets/1", MATCHERS, { nowMs: AT }),
      observeRequest("/api/v1/subnets/2", MATCHERS, { nowMs: AT }),
      observeRequest("/api/v1/subnets/3", MATCHERS, { keyed: true, nowMs: AT }),
    ];
    const folded = foldObservations(observations);
    assert.equal(folded.length, 1, "three netuids are one bucket");
    assert.equal(folded[0].request_count, 3);
    assert.equal(folded[0].keyed_count, 1);
  });

  test("different shapes stay in different buckets", () => {
    const folded = foldObservations([
      observeRequest("/api/v1/subnets", MATCHERS, { nowMs: AT }),
      observeRequest("/api/v1/chain-events", MATCHERS, { nowMs: AT }),
    ]);
    assert.equal(folded.length, 2);
    assert.deepEqual(folded.map((b) => b.cost_shape).sort(), [
      "edge",
      "postgres",
    ]);
  });

  test("output is deterministically ordered", () => {
    // A stable statement order keeps the write path reviewable and its tests
    // order-independent.
    const make = () =>
      foldObservations([
        observeRequest("/api/v1/chain-events", MATCHERS, { nowMs: AT }),
        observeRequest("/api/v1/subnets", MATCHERS, { nowMs: AT }),
        observeRequest("/api/v1/ask", MATCHERS, { nowMs: AT }),
      ]);
    assert.deepEqual(make(), make());
    const families = make().map((b) => b.family);
    assert.deepEqual(families, [...families].sort());
  });

  test("malformed observations are skipped, never allowed to poison a batch", () => {
    const folded = foldObservations([
      null as never,
      { day: "", family: "x", costShape: "edge", keyed: false } as never,
      {
        day: "2026-07-29",
        family: "",
        costShape: "edge",
        keyed: false,
      } as never,
      observeRequest("/api/v1/subnets", MATCHERS, { nowMs: AT }),
    ]);
    assert.equal(folded.length, 1, "one good observation survives three bad");
    assert.equal(folded[0].request_count, 1);
  });

  test("ordering breaks ties by cost shape, not just day and family", () => {
    // The comparator's third clause only runs when day AND family match, which
    // never happens through observeRequest (one family has one shape). Folding
    // hand-built observations is the only way to exercise it — and without it a
    // tie would order non-deterministically, making the write path's statement
    // order unstable.
    const same = {
      day: "2026-07-29",
      family: "/api/v1/x",
      keyed: false,
    } as const;
    const folded = foldObservations([
      { ...same, costShape: "postgres" },
      { ...same, costShape: "ai" },
      { ...same, costShape: "edge" },
    ]);
    assert.deepEqual(
      folded.map((b) => b.cost_shape),
      ["ai", "edge", "postgres"],
    );
  });

  test("an empty batch folds to nothing", () => {
    assert.deepEqual(foldObservations([]), []);
  });
});

describe("recordUsageRollup posts every API request (#8597)", () => {
  // #8823: an observation is buffered, not written, until a flush trigger
  // fires. These tests are about WHAT gets recorded, so they flush explicitly;
  // the batching behaviour itself is the separate describe below.
  const envWith = (over: Record<string, unknown> = {}) => {
    const posts: { url: string; token: string | null; body: unknown }[] = [];
    const env = {
      API_KEY_LOOKUP_INTERNAL_TOKEN: "tok",
      DATA_API: {
        fetch: async (request: Request) => {
          posts.push({
            url: new URL(request.url).pathname,
            token: request.headers.get("x-api-key-lookup-token"),
            body: JSON.parse(await request.clone().text()),
          });
          return Response.json({ ok: true });
        },
      },
      ...over,
    } as unknown as Env;
    return { env, posts };
  };

  test("counts a KEYLESS request — the traffic api_key_usage_daily cannot see", async () => {
    // The entire reason this rollup exists. If keyless were dropped here, the
    // readout would answer the pricing question with the same blind spot the
    // issue was filed to remove.
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env, posts } = envWith();
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never;
    recordUsageRollup(env, ctx, "/api/v1/subnets/64", false);
    flushUsageRollup(env, ctx);
    await Promise.all(waited);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/v1/internal/usage-rollup");
    assert.equal(posts[0].token, "tok");
    const bucket = (posts[0].body as { buckets: Row[] }).buckets[0];
    assert.match(String(bucket.family), /\{netuid\}/);
    assert.equal(bucket.request_count, 1);
    assert.equal(bucket.keyed_count, 0, "keyless");
  });

  test("marks a keyed request as keyed", async () => {
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env, posts } = envWith();
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never;
    recordUsageRollup(env, ctx, "/api/v1/subnets", true);
    flushUsageRollup(env, ctx);
    await Promise.all(waited);
    const bucket = (posts[0].body as { buckets: Row[] }).buckets[0];
    assert.equal(bucket.keyed_count, 1);
  });

  test("is a no-op without the binding or token, never a throw", async () => {
    const { recordUsageRollup } = await import("../workers/api.ts");
    for (const over of [
      { DATA_API: undefined },
      { API_KEY_LOOKUP_INTERNAL_TOKEN: undefined },
    ]) {
      const { env, posts } = envWith(over);
      recordUsageRollup(env, undefined, "/api/v1/subnets", false);
      assert.deepEqual(posts, []);
    }
  });

  test("a failing DATA_API cannot reject — it must never fail a response", async () => {
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const env = {
      API_KEY_LOOKUP_INTERNAL_TOKEN: "tok",
      DATA_API: {
        fetch: async () => {
          throw new Error("down");
        },
      },
    } as unknown as Env;
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never;
    recordUsageRollup(env, ctx, "/api/v1/subnets", false);
    flushUsageRollup(env, ctx);
    // Resolves, never rejects — an unhandled rejection here would surface on
    // the real request.
    await Promise.all(waited);
  });

  test("works without an ExecutionContext", async () => {
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env } = envWith();
    recordUsageRollup(env, undefined, "/api/v1/subnets", false);
    flushUsageRollup(env, undefined);
  });
});

// #8823: the write path used to be 1:1 with requests. `foldObservations` was
// handed a single-element array per request, so N requests meant N DATA_API
// subrequests, N postgres() clients, and N upserts -- and every unmatched path
// collapses to the SAME (day, "unmatched", "edge") row, so an unauthenticated
// flood of 404s serialised on one row lock against a self-hosted database.
// Observations are now buffered in the isolate and flushed in batches. See
// docs/adr/0026-usage-rollup-write-path.md.
describe("recordUsageRollup batches its writes (#8823)", () => {
  function harness() {
    const posts: { buckets: Row[] }[] = [];
    const waited: Promise<unknown>[] = [];
    const env = {
      API_KEY_LOOKUP_INTERNAL_TOKEN: "tok",
      DATA_API: {
        fetch: async (request: Request) => {
          posts.push(
            JSON.parse(await request.clone().text()) as { buckets: Row[] },
          );
          return Response.json({ ok: true });
        },
      },
    } as unknown as Env;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never;
    return { env, ctx, posts, waited };
  }

  // Mirrors USAGE_ROLLUP_FLUSH_COUNT in workers/api.ts. Asserted below against
  // the module's own buffer size so a change there fails here loudly rather
  // than silently weakening this test.
  const FLUSH_COUNT = 64;

  test("N requests produce ceil(N / 64) writes, not N", async () => {
    const { recordUsageRollup, usageRollupBufferSize, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env, ctx, posts, waited } = harness();
    flushUsageRollup(env, ctx); // drain anything a sibling test left buffered
    posts.length = 0;

    for (let i = 0; i < FLUSH_COUNT - 1; i += 1) {
      recordUsageRollup(env, ctx, "/api/v1/subnets", false);
    }
    assert.equal(usageRollupBufferSize(), FLUSH_COUNT - 1);
    assert.equal(
      posts.length,
      0,
      "nothing is written below the flush threshold",
    );

    // The 64th observation trips the count trigger.
    recordUsageRollup(env, ctx, "/api/v1/subnets", false);
    await Promise.all(waited);
    assert.equal(posts.length, 1, "64 requests => exactly ONE subrequest");
    assert.equal(
      usageRollupBufferSize(),
      0,
      "the buffer is drained, not copied",
    );

    // ...and the batch is ONE bucket carrying all 64, not 64 buckets: the
    // upsert contends for the (day, family, shape) row once, not 64 times.
    assert.equal(posts[0].buckets.length, 1);
    assert.equal(posts[0].buckets[0].request_count, FLUSH_COUNT);

    // 64 more => a second write, and no more than that.
    for (let i = 0; i < FLUSH_COUNT; i += 1) {
      recordUsageRollup(env, ctx, "/api/v1/subnets", false);
    }
    await Promise.all(waited);
    assert.equal(posts.length, 2, "128 requests => 2 subrequests, not 128");
    flushUsageRollup(env, ctx);
  });

  test("an unmatched-path flood folds into ONE bucket per batch", async () => {
    // The abuse case the issue is really about: `/api/v1/<random>` 404s all
    // map to (day, "unmatched", "edge"), which is why they used to serialise
    // on a single row lock. Every distinct junk path in one batch now costs
    // one bucket, so the row is touched once per flush.
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env, ctx, posts, waited } = harness();
    flushUsageRollup(env, ctx);
    posts.length = 0;

    for (let i = 0; i < FLUSH_COUNT; i += 1) {
      recordUsageRollup(env, ctx, `/api/v1/${i}-scanner-probe-${i}`, false);
    }
    await Promise.all(waited);
    assert.equal(posts.length, 1, "64 junk 404s => ONE subrequest");
    assert.equal(
      posts[0].buckets.length,
      1,
      "64 DISTINCT junk paths => ONE bucket, not 64 rows",
    );
    assert.equal(posts[0].buckets[0].family, UNMATCHED_FAMILY);
    assert.equal(posts[0].buckets[0].request_count, FLUSH_COUNT);
    flushUsageRollup(env, ctx);
  });

  test("keyed and keyless in one batch stay distinguishable", async () => {
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env, ctx, posts, waited } = harness();
    flushUsageRollup(env, ctx);
    posts.length = 0;

    for (let i = 0; i < FLUSH_COUNT; i += 1) {
      recordUsageRollup(env, ctx, "/api/v1/subnets", i % 4 === 0);
    }
    await Promise.all(waited);
    assert.equal(posts.length, 1);
    // request_count/keyed_count keep their exact meaning across the change --
    // batched, never sampled or scaled (ADR 0026).
    assert.equal(posts[0].buckets[0].request_count, FLUSH_COUNT);
    assert.equal(posts[0].buckets[0].keyed_count, FLUSH_COUNT / 4);
    flushUsageRollup(env, ctx);
  });

  test("distinct families in one batch become distinct buckets, still one write", async () => {
    const { recordUsageRollup, flushUsageRollup } =
      await import("../workers/api.ts");
    const { env, ctx, posts, waited } = harness();
    flushUsageRollup(env, ctx);
    posts.length = 0;

    for (let i = 0; i < FLUSH_COUNT / 2; i += 1) {
      recordUsageRollup(env, ctx, "/api/v1/subnets", false);
      recordUsageRollup(env, ctx, "/api/v1/nonexistent-path", false);
    }
    await Promise.all(waited);
    assert.equal(posts.length, 1, "one subrequest covers both families");
    assert.equal(posts[0].buckets.length, 2);
    assert.deepEqual(
      posts[0].buckets.map((bucket: Row) => bucket.request_count),
      [FLUSH_COUNT / 2, FLUSH_COUNT / 2],
    );
    flushUsageRollup(env, ctx);
  });

  test("the age trigger flushes a partial buffer once a later request arrives", async () => {
    // Workers has no timer that runs outside a request, so the 10s age bound
    // can only be evaluated when the NEXT observation arrives. That is the
    // design, not a gap: a flush is affordable exactly when there is a request
    // whose waitUntil can carry it.
    const { recordUsageRollup, flushUsageRollup, usageRollupBufferSize } =
      await import("../workers/api.ts");
    const { env, ctx, posts, waited } = harness();
    flushUsageRollup(env, ctx);
    posts.length = 0;

    const realNow = Date.now;
    try {
      let clock = 1_800_000_000_000;
      Date.now = () => clock;
      recordUsageRollup(env, ctx, "/api/v1/subnets", false);
      assert.equal(usageRollupBufferSize(), 1);
      assert.equal(
        posts.length,
        0,
        "one observation is well below the count trigger",
      );

      clock += 10_001; // past USAGE_ROLLUP_FLUSH_AGE_MS
      recordUsageRollup(env, ctx, "/api/v1/subnets", false);
      await Promise.all(waited);
      assert.equal(
        posts.length,
        1,
        "the age trigger fired on the next request",
      );
      assert.equal(posts[0].buckets[0].request_count, 2);
      assert.equal(usageRollupBufferSize(), 0);
    } finally {
      Date.now = realNow;
      flushUsageRollup(env, ctx);
    }
  });

  test("handleRequest drives the same batching end-to-end, 404s included", async () => {
    const { handleRequest, flushUsageRollup, usageRollupBufferSize } =
      await import("../workers/api.ts");
    const { env, ctx, posts, waited } = harness();
    flushUsageRollup(env, ctx);
    posts.length = 0;

    // Real requests through the router: an unmatched /api/v1 path, which is
    // both the worst case for the old write path and the one that reaches the
    // generic 404 without passing any rate limiter.
    for (let i = 0; i < FLUSH_COUNT; i += 1) {
      await handleRequest(
        new Request(`https://api.metagraph.sh/api/v1/no-such-route-${i}`),
        env,
        ctx,
      );
    }
    await Promise.all(waited);
    assert.equal(
      posts.length,
      1,
      `${FLUSH_COUNT} requests through handleRequest => 1 usage-rollup subrequest`,
    );
    assert.equal(posts[0].buckets[0].request_count, FLUSH_COUNT);
    assert.equal(usageRollupBufferSize(), 0);

    // An OPTIONS preflight is still not counted (it returns before the hook).
    await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets", {
        method: "OPTIONS",
      }),
      env,
      ctx,
    );
    assert.equal(usageRollupBufferSize(), 0);
    flushUsageRollup(env, ctx);
  });
});
