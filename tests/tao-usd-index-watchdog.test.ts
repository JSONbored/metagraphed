// The TAO/USD index watchdog (#8603).
//
// The issue names the bar directly: "an alert that has never fired once is not
// known to work". So every condition here is driven to fire against a simulated
// state, and the healthy case is pinned against the shape production actually
// produces -- a watchdog that cannot go green on real data is as useless as one
// that cannot go red.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MIN_QUALIFYING_POOLS,
  OUTLIER_THRESHOLD,
} from "../src/tao-usd-index.ts";
import {
  evaluateTaoUsdIndex,
  poolDeviation,
  POOL_DEVIATION_WARN,
  POOL_FAILING_MS,
  runTaoUsdIndexWatchdog,
} from "../src/tao-usd-index-watchdog.ts";

const NOW = Date.parse("2026-08-10T06:00:00.000Z");
const MINUTE = 60_000;

const A = "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc";
const B = "0x2982d3295a0e1a99e6e88ece0e93ffdfc5c761ae";

/** A healthy tick, shaped exactly as production stores it (pools as TEXT). */
const tick = (
  minutesAgo: number,
  {
    a = 0.10650702834180564,
    b = 0.10589201476467973,
    basis = "wrapped_onchain_median",
    usd = 204.125,
    poolCount = 2,
    pools,
  }: {
    a?: number;
    b?: number;
    basis?: string;
    usd?: number | null;
    poolCount?: number;
    pools?: unknown;
  } = {},
) => ({
  observed_at: NOW - minutesAgo * MINUTE,
  price_basis: basis,
  usd_per_tao: usd,
  pool_count: poolCount,
  pools:
    pools !== undefined
      ? pools
      : JSON.stringify([
          {
            address: A,
            included: true,
            eth_per_tao: a,
            liquidity_usd: 2_103_895,
          },
          {
            address: B,
            included: true,
            eth_per_tao: b,
            liquidity_usd: 303_379,
          },
        ]),
});

const healthyWindow = () => Array.from({ length: 60 }, (_, i) => tick(i));

describe("the healthy case, shaped like production", () => {
  test("60 good ticks are OK with no alerts", () => {
    // Verified against the real table before this test was written: 60 rows,
    // deviation 0.2896%, both pools on every tick.
    const v = evaluateTaoUsdIndex({ rows: healthyWindow(), nowMs: NOW });
    assert.equal(v.verdict, "ok");
    assert.deepEqual(v.alerts, []);
    assert.equal(v.degradedTicks, 0);
    assert.equal(v.pools.length, 2);
    assert.ok((v.maxDeviation as number) < POOL_DEVIATION_WARN);
  });

  test("the zero-redundancy standing risk is REPORTED, not alerted", () => {
    // pool_count has been exactly the floor for the index's entire life. An
    // alert would fire every minute forever and train everyone to ignore the
    // channel; the fact still has to reach the verdict, and the runbook.
    const v = evaluateTaoUsdIndex({ rows: healthyWindow(), nowMs: NOW });
    assert.equal(v.noRedundancy, true);
    assert.deepEqual(v.alerts, [], "a permanent condition must not page");
  });

  test("a third qualifying pool clears the standing risk", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      tick(i, { poolCount: 3 }),
    );
    assert.equal(evaluateTaoUsdIndex({ rows, nowMs: NOW }).noRedundancy, false);
  });
});

describe("requirement 3 — the degraded state must not be found by a reader first", () => {
  test("one unpriced tick alerts and fails", () => {
    const rows = [
      tick(0, { basis: "insufficient_pools", usd: null, poolCount: 0 }),
      ...Array.from({ length: 59 }, (_, i) => tick(i + 1)),
    ];
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    assert.equal(v.verdict, "fail");
    assert.equal(v.degradedTicks, 1);
    assert.ok(
      v.alerts.some((a) => a.includes("published no price on 1 of 60")),
    );
  });

  test("a null price counts as degraded even if the basis says otherwise", () => {
    // Defence against a producer that writes a null without the paired basis:
    // the CHECK constraint forbids it, and a watchdog that trusted the label
    // over the value would go quiet exactly when the constraint was breached.
    const rows = [
      tick(0, { usd: null }),
      ...Array.from({ length: 5 }, (_, i) => tick(i + 1)),
    ];
    assert.equal(evaluateTaoUsdIndex({ rows, nowMs: NOW }).degradedTicks, 1);
  });
});

describe("requirement 2 — divergence, warned before it becomes a stop", () => {
  test("a spread past the warn threshold alerts", () => {
    // Half-spread just over POOL_DEVIATION_WARN.
    const base = 0.1;
    const spread = POOL_DEVIATION_WARN * 2 * 1.1;
    const rows = [
      tick(0, { a: base * (1 + spread / 2), b: base * (1 - spread / 2) }),
      ...Array.from({ length: 10 }, (_, i) => tick(i + 1)),
    ];
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    assert.equal(v.verdict, "warn", "a wide spread is not yet a wrong number");
    assert.ok(v.alerts.some((a) => a.includes("pool deviation reached")));
  });

  test("the alert explains that rejection STOPS publication here", () => {
    // The non-obvious part, and the reason this warns early: with two pools the
    // median is their midpoint, both sit equidistant from it, and crossing the
    // rejection threshold removes BOTH rather than discarding one.
    const base = 0.1;
    const spread = OUTLIER_THRESHOLD * 2 * 1.1;
    const rows = [
      tick(0, { a: base * (1 + spread / 2), b: base * (1 - spread / 2) }),
    ];
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    const alert = v.alerts.find((a) => a.includes("pool deviation")) as string;
    assert.ok(alert.includes("removes BOTH"));
    assert.ok(alert.includes("stops publication"));
  });

  test("the deviation is measured the way the aggregator measures it", () => {
    // Against the UNWEIGHTED median of the included readings. Measuring it any
    // other way would warn at a threshold the aggregator does not use.
    assert.equal(poolDeviation([]), null);
    assert.equal(
      poolDeviation([{ address: A, included: true, eth_per_tao: 1 }]),
      null,
      "one pool has no spread to measure",
    );
    // 0.98 and 1.02 around a midpoint of 1.0 -> 2% each side.
    const d = poolDeviation([
      { address: A, included: true, eth_per_tao: 0.98 },
      { address: B, included: true, eth_per_tao: 1.02 },
    ]) as number;
    assert.ok(Math.abs(d - 0.02) < 1e-9);
  });

  test("an EXCLUDED pool does not drag the deviation", () => {
    // It is already not contributing; counting it would warn about a reading
    // the aggregator has itself discarded.
    const d = poolDeviation([
      { address: A, included: true, eth_per_tao: 1 },
      { address: B, included: true, eth_per_tao: 1.001 },
      { address: "0xdead", included: false, eth_per_tao: 5 },
    ]) as number;
    assert.ok(d < 0.01);
  });
});

describe("requirement 1 — per-pool health, by last success", () => {
  test("a pool that stops contributing alerts once it passes the bound", () => {
    // A contributes throughout; B stopped 20 minutes ago (bound is 15).
    const rows = Array.from({ length: 60 }, (_, i) =>
      i < 20
        ? tick(i, {
            pools: JSON.stringify([
              {
                address: A,
                included: true,
                eth_per_tao: 0.106,
                liquidity_usd: 2_103_895,
              },
              { address: B, included: false, reason: "unusable_reading" },
            ]),
          })
        : tick(i),
    );
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    assert.equal(v.verdict, "fail");
    const b = v.pools.find((p) => p.address === B);
    assert.equal(b?.failing, true);
    assert.equal(v.pools.find((p) => p.address === A)?.failing, false);
    assert.ok(
      v.alerts.some((a) => a.includes(B) && a.includes("last contributed")),
    );
  });

  test("a pool that flaps but still contributes is NOT called dead", () => {
    // Measured against its last contribution, not its exclusion count -- a pool
    // doing its job half the time is degraded, not gone.
    const rows = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? tick(i)
        : tick(i, {
            pools: JSON.stringify([
              {
                address: A,
                included: true,
                eth_per_tao: 0.106,
                liquidity_usd: 1,
              },
              { address: B, included: false, reason: "outlier" },
            ]),
          }),
    );
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    const b = v.pools.find((p) => p.address === B);
    assert.equal(b?.failing, false);
    assert.ok((b?.excludedTicks ?? 0) > 0, "the exclusions are still counted");
    assert.equal(v.verdict, "ok");
  });

  test("a pool that never contributed carries its reason", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      tick(i, {
        pools: JSON.stringify([
          { address: A, included: true, eth_per_tao: 0.106, liquidity_usd: 1 },
          { address: B, included: false, reason: "below_tvl_floor" },
        ]),
      }),
    );
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    const b = v.pools.find((p) => p.address === B);
    assert.equal(b?.lastIncludedAt, null);
    assert.equal(b?.lastReason, "below_tvl_floor");
    assert.ok(v.alerts.some((a) => a.includes("no tick in the window")));
  });

  test("the failing bound is sized to the producer, not to a round number", () => {
    // One minute per tick; 15 minutes is 15 ticks. Pinned so a later change is
    // deliberate rather than a rounding drift.
    assert.equal(POOL_FAILING_MS, 15 * MINUTE);
  });
});

describe("requirement 4 — a wholly failed ingestion is distinct from pool failure", () => {
  test("an empty window FAILS rather than reading as all-quiet", () => {
    // The trap this closes: a per-pool check over zero rows finds zero failing
    // pools and reports healthy. Silence is the loudest state here.
    for (const empty of [[], null, undefined]) {
      const v = evaluateTaoUsdIndex({ rows: empty as never, nowMs: NOW });
      assert.equal(v.verdict, "fail");
      assert.ok(v.alerts[0].includes("wrote no rows"));
      assert.ok(v.alerts[0].includes("down, not merely degraded"));
    }
  });

  test("rows without a usable timestamp are not counted as ticks", () => {
    const v = evaluateTaoUsdIndex({
      rows: [{ observed_at: "nope", price_basis: "x" }],
      nowMs: NOW,
    });
    assert.equal(v.verdict, "fail");
    assert.equal(v.ticks, 0);
  });
});

describe("the stored shape", () => {
  test("pools parse from TEXT or from an already-decoded array", () => {
    // Production stores the column as TEXT; a pg driver or a test may hand back
    // either. Both must evaluate identically, or the watchdog is green locally
    // and blind in production.
    const asText = evaluateTaoUsdIndex({ rows: [tick(0)], nowMs: NOW });
    const asArray = evaluateTaoUsdIndex({
      rows: [
        tick(0, {
          pools: [
            { address: A, included: true, eth_per_tao: 0.10650702834180564 },
            { address: B, included: true, eth_per_tao: 0.10589201476467973 },
          ],
        }),
      ],
      nowMs: NOW,
    });
    assert.equal(asText.pools.length, asArray.pools.length);
    assert.equal(asText.maxDeviation, asArray.maxDeviation);
  });

  test("malformed pool JSON degrades to no pools rather than throwing", () => {
    const v = evaluateTaoUsdIndex({
      rows: [tick(0, { pools: "{not json" }), tick(1, { pools: 42 })],
      nowMs: NOW,
    });
    assert.equal(v.pools.length, 0);
    assert.equal(v.maxDeviation, null);
    // Still a real tick that published a price, so not degraded.
    assert.equal(v.degradedTicks, 0);
  });

  test("a pool entry with no address is skipped, not keyed to undefined", () => {
    const v = evaluateTaoUsdIndex({
      rows: [
        tick(0, {
          pools: JSON.stringify([{ included: true, eth_per_tao: 1 }]),
        }),
      ],
      nowMs: NOW,
    });
    assert.equal(v.pools.length, 0);
  });

  test("row order does not change the verdict", () => {
    const rows = healthyWindow();
    const forward = evaluateTaoUsdIndex({
      rows: [...rows].reverse(),
      nowMs: NOW,
    });
    const backward = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    assert.equal(forward.verdict, backward.verdict);
    assert.deepEqual(forward.pools, backward.pools);
  });
});

describe("the thresholds are derived, not typed twice", () => {
  test("the warning sits at half the rejection threshold", () => {
    // Compared against the DECLARATION rather than a literal: if ADR 0025
    // retunes OUTLIER_THRESHOLD, the warning moves with it instead of quietly
    // becoming noise or a rubber stamp.
    assert.equal(POOL_DEVIATION_WARN, OUTLIER_THRESHOLD / 2);
    assert.ok(POOL_DEVIATION_WARN < OUTLIER_THRESHOLD);
  });

  test("the quorum floor comes from the aggregator", () => {
    assert.equal(MIN_QUALIFYING_POOLS, 2);
  });
});

describe("the runner, and what it records", () => {
  const store = (results: unknown[] | Error) => ({
    prepare: () => ({
      bind: () => ({
        all: async () => {
          if (results instanceof Error) throw results;
          return { results };
        },
      }),
    }),
  });
  const laneSpy = () => {
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      db: {
        prepare: () => ({
          bind: (...v: unknown[]) => ({
            run: async () => {
              rows.push({ lane: v[0], verdict: v[1], detail: v[3] });
              return {};
            },
          }),
        }),
      },
    };
  };

  test("a healthy window records ok, with the precise verdict in detail", async () => {
    const lane = laneSpy();
    const out = await runTaoUsdIndexWatchdog(
      {},
      {
        db: store(healthyWindow()),
        laneHealthDb: lane.db as never,
        now: () => NOW,
      },
    );
    assert.equal(out.verdict, "ok");
    assert.equal(out.recorded, true);
    assert.equal(lane.rows[0].lane, "watchdog:tao-usd-index");
    assert.equal(lane.rows[0].verdict, "ok");
    const detail = JSON.parse(lane.rows[0].detail as string);
    assert.equal(detail.verdict, "ok");
    assert.equal(
      detail.no_redundancy,
      true,
      "the standing risk is durable, not just logged",
    );
  });

  test("a READ FAILURE is `unknown`, never `stale`", async () => {
    // The distinction the lane column exists to make: "we could not ask" must
    // not be recorded as a verdict about the producer. Reporting stale here
    // would send someone to the ingestion lane for a fault in the reader.
    const lane = laneSpy();
    const out = await runTaoUsdIndexWatchdog(
      {},
      {
        db: store(new Error("connection reset")),
        laneHealthDb: lane.db as never,
        now: () => NOW,
      },
    );
    assert.equal(lane.rows[0].verdict, "unknown");
    assert.ok(out.alerts[0].includes("reader fault, not a producer verdict"));
  });

  test("an empty read is `stale`, because that IS a verdict about the producer", async () => {
    const lane = laneSpy();
    await runTaoUsdIndexWatchdog(
      {},
      { db: store([]), laneHealthDb: lane.db as never, now: () => NOW },
    );
    assert.equal(lane.rows[0].verdict, "stale");
    const detail = JSON.parse(lane.rows[0].detail as string);
    assert.equal(detail.verdict, "fail");
  });

  test("a degraded window records stale while keeping `fail` in detail", async () => {
    const lane = laneSpy();
    const rows = [
      tick(0, { basis: "insufficient_pools", usd: null, poolCount: 0 }),
      ...Array.from({ length: 10 }, (_, i) => tick(i + 1)),
    ];
    await runTaoUsdIndexWatchdog(
      {},
      { db: store(rows), laneHealthDb: lane.db as never, now: () => NOW },
    );
    assert.equal(lane.rows[0].verdict, "stale");
    assert.equal(JSON.parse(lane.rows[0].detail as string).verdict, "fail");
  });

  test("a failed lane write is reported, not swallowed", async () => {
    const out = await runTaoUsdIndexWatchdog(
      {},
      { db: store(healthyWindow()), laneHealthDb: null, now: () => NOW },
    );
    assert.equal(out.recorded, false);
    assert.equal(out.verdict, "ok", "the verdict still stands even unrecorded");
  });
});

describe("the shapes a real store hands back", () => {
  test("JSON that is not an array yields no pools", () => {
    const v = evaluateTaoUsdIndex({
      rows: [tick(0, { pools: '{"address":"0x1"}' })],
      nowMs: NOW,
    });
    assert.equal(v.pools.length, 0);
  });

  test("an odd pool count uses the middle reading, not a midpoint", () => {
    // Three pools is the shape we WANT (it would end the zero-redundancy risk),
    // so the median has to be right for it before it ever happens.
    const d = poolDeviation([
      { address: A, included: true, eth_per_tao: 0.9 },
      { address: B, included: true, eth_per_tao: 1.0 },
      { address: "0x3", included: true, eth_per_tao: 1.05 },
    ]) as number;
    // Reference is 1.0, so the widest deviation is 0.9 -> 10%.
    assert.ok(Math.abs(d - 0.1) < 1e-9);
  });

  test("a row with no pool_count does not read as above the floor", () => {
    const rows = [
      {
        observed_at: NOW,
        price_basis: "wrapped_onchain_median",
        usd_per_tao: 1,
      },
    ];
    assert.equal(evaluateTaoUsdIndex({ rows, nowMs: NOW }).noRedundancy, true);
  });

  test("an exclusion with no reason keeps the last one it had", () => {
    // Otherwise a later reasonless exclusion erases the diagnosis that would
    // tell an operator what to do.
    const rows = [
      tick(0, {
        pools: JSON.stringify([
          { address: A, included: true, eth_per_tao: 0.106 },
          { address: B, included: false },
        ]),
      }),
      tick(30, {
        pools: JSON.stringify([
          { address: A, included: true, eth_per_tao: 0.106 },
          { address: B, included: false, reason: "below_tvl_floor" },
        ]),
      }),
    ];
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    assert.equal(
      v.pools.find((p) => p.address === B)?.lastReason,
      "below_tvl_floor",
    );
  });

  test("a failing pool with no recorded reason still reads as a sentence", () => {
    const rows = [
      tick(0, {
        pools: JSON.stringify([
          { address: A, included: true, eth_per_tao: 0.106 },
          { address: B, included: false },
        ]),
      }),
    ];
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    assert.ok(v.alerts.some((a) => a.includes("unstated")));
  });

  test("a store answering without `results` is an empty window, not a crash", async () => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({}) }) }) };
    const out = await runTaoUsdIndexWatchdog({}, { db, now: () => NOW });
    assert.equal(out.verdict, "fail");
    assert.ok(out.alerts[0].includes("wrote no rows"));
  });

  test("with no injected store or lane db, it degrades instead of throwing", async () => {
    // The default paths: readStore over an empty env yields nothing to query,
    // and laneHealthStore yields nothing to write to. Neither may throw -- a
    // watchdog that crashes on a cold binding is a watchdog that is silent.
    const out = await runTaoUsdIndexWatchdog({});
    assert.equal(out.recorded, false);
    assert.ok(["fail", "ok", "warn"].includes(out.verdict));
  });
});

describe("the last two edges", () => {
  test("a pool that stopped contributing with no reason still reports the gap", () => {
    // It contributed, then went absent from the array entirely — no exclusion
    // entry, so no reason. The elapsed time is the diagnosis in that case.
    const rows = [
      tick(0, {
        pools: JSON.stringify([
          { address: A, included: true, eth_per_tao: 0.106 },
        ]),
      }),
      tick(40, {
        pools: JSON.stringify([
          { address: A, included: true, eth_per_tao: 0.106 },
          { address: B, included: true, eth_per_tao: 0.1059 },
        ]),
      }),
    ];
    const v = evaluateTaoUsdIndex({ rows, nowMs: NOW });
    const alert = v.alerts.find((a) => a.includes(B)) as string;
    assert.ok(alert.includes("last contributed 40 minutes ago"));
    assert.ok(alert.includes("unstated"));
  });

  test("a null env is survivable", async () => {
    // The scheduled handler passes whatever it has; a watchdog that throws on a
    // missing binding is one that never reports.
    const out = await runTaoUsdIndexWatchdog(null);
    assert.equal(out.recorded, false);
  });
});
