// #11328: a subnet's miners stopping announcing an axon.
//
// The fixtures are the REAL measured series, taken from production Neon on
// 2026-08-15 over 37 retained days. That matters here more than usual, because
// the detector's shape was chosen by those numbers: SN25's collapse begins with
// a 26% step that no day-over-day threshold catches, and SN103 looks like the
// largest axon event in the window while actually being a subnet turning over.
// A synthetic fixture would have agreed with whatever was implemented.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { pgMockEnv } from "./helpers/pg-mock.ts";
import {
  AXON_BASELINE_FLOOR,
  AXON_FLEET_WIDE_FLAGS,
  AXON_MAX_LISTED,
  axonDetail,
  evaluateAxonAnnouncements,
  evaluateSubnetAxons,
  groupAxonDays,
  isFleetWide,
  isoDaysAgo,
  medianOf,
  runAxonAnnouncementWatchdog,
  type AxonDay,
  type AxonFinding,
} from "../src/axon-announcement-watchdog.ts";

/** Days at a uniform width, oldest first. */
const flat = (n: number, withAxon: number, neurons = 256): AxonDay[] =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    withAxon,
    neurons,
  }));

const then = (base: AxonDay[], ...tail: [number, number][]): AxonDay[] => [
  ...base,
  ...tail.map(([withAxon, neurons], i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    withAxon,
    neurons,
  })),
];

describe("medianOf", () => {
  test("odd and even lengths", () => {
    assert.equal(medianOf([3, 1, 2]), 2);
    assert.equal(medianOf([4, 1, 3, 2]), 2.5);
  });

  test("empty is null, not zero", () => {
    // Zero would read as "the subnet had no axons", which is a measurement.
    assert.equal(medianOf([]), null);
    assert.equal(medianOf([Number.NaN]), null);
  });

  test("non-finite values are dropped, not propagated", () => {
    assert.equal(medianOf([1, Number.NaN, 3, Number.POSITIVE_INFINITY]), 2);
  });

  test("the caller's array is not reordered", () => {
    const input = [3, 1, 2];
    medianOf(input);
    assert.deepEqual(input, [3, 1, 2]);
  });
});

describe("evaluateSubnetAxons — the real incidents", () => {
  test("SN101: 223 steady, then 129 and held (the filed case)", () => {
    const series = then(flat(8, 223), [129, 256]);
    const f = evaluateSubnetAxons(101, series);
    assert.ok(f, "SN101's drop is a finding");
    assert.equal(f.kind, "announcements-withdrawn");
    assert.equal(f.withAxon, 129);
    assert.equal(f.baseline, 223);
    assert.ok(f.ratio < 0.6);
  });

  test("SN25: the GRADUAL collapse a day-over-day test misses", () => {
    // 80 -> 59 is a 26% step. Against the trailing baseline the 21 is caught,
    // which is the whole reason the baseline form was chosen.
    const series = then(flat(8, 80), [59, 256], [21, 256]);
    const f = evaluateSubnetAxons(25, series);
    assert.ok(f, "SN25's decline is caught against baseline");
    assert.equal(f.withAxon, 21);
    assert.equal(f.kind, "announcements-withdrawn");
  });

  test("the first 26% step alone is NOT flagged", () => {
    // The other side of the same boundary: a detector that fired here would
    // fire on ordinary movement, whose 5th percentile is a 2% drop.
    assert.equal(evaluateSubnetAxons(25, then(flat(8, 80), [59, 256])), null);
  });

  test("SN103: neurons collapsed too, so it is turnover, not withdrawal", () => {
    // 252 -> 0 axons looks like the largest axon event in the window. It is a
    // subnet that emptied: 256 -> 2 neurons on the same day.
    const series = then(flat(8, 252, 256), [0, 2]);
    const f = evaluateSubnetAxons(103, series);
    assert.ok(f);
    assert.equal(f.kind, "subnet-turned-over");
    assert.equal(f.neurons, 2);
    assert.equal(f.neuronBaseline, 256);
  });

  test("a steady subnet is not a finding", () => {
    assert.equal(evaluateSubnetAxons(1, flat(9, 200)), null);
  });
});

describe("evaluateSubnetAxons — what it refuses to measure", () => {
  test("a baseline under the floor is skipped rather than flagged", () => {
    // Without this the list is dominated by subnets where a 30% move is three
    // miners. Floor-1 so the boundary itself is exercised.
    const series = then(flat(8, AXON_BASELINE_FLOOR - 1), [0, 256]);
    assert.equal(evaluateSubnetAxons(7, series), null);
  });

  test("a baseline exactly at the floor IS measured", () => {
    const series = then(flat(8, AXON_BASELINE_FLOOR), [0, 256]);
    assert.ok(evaluateSubnetAxons(7, series));
  });

  test("too little history is null, never a clean verdict", () => {
    assert.equal(evaluateSubnetAxons(1, []), null);
    assert.equal(evaluateSubnetAxons(1, flat(1, 200)), null);
    assert.equal(
      evaluateSubnetAxons(1, undefined as unknown as AxonDay[]),
      null,
    );
  });

  test("a non-finite latest reading is null", () => {
    const series = then(flat(8, 200));
    series.push({ date: "2026-09-09", withAxon: Number.NaN, neurons: 256 });
    assert.equal(evaluateSubnetAxons(1, series), null);
  });

  test("a neuron baseline under the floor cannot claim turnover", () => {
    // Axons collapse while the neuron count is too small to judge: the finding
    // stands, but it must not assert the subnet turned over.
    const series = [
      ...Array.from({ length: 8 }, (_, i) => ({
        date: `2026-08-0${i + 1}`,
        withAxon: 40,
        neurons: 5,
      })),
      { date: "2026-09-01", withAxon: 2, neurons: 1 },
    ];
    const f = evaluateSubnetAxons(9, series);
    assert.ok(f);
    assert.equal(f.kind, "announcements-withdrawn");
  });
});

describe("the fleet-wide guard", () => {
  const finding = (netuid: number): AxonFinding => ({
    netuid,
    date: "2026-08-15",
    withAxon: 1,
    baseline: 100,
    ratio: 0.01,
    neurons: 256,
    neuronBaseline: 256,
    kind: "announcements-withdrawn",
  });

  test("three subnets is the observed independent maximum, so not fleet-wide", () => {
    assert.equal(isFleetWide([finding(1), finding(2), finding(3)]), false);
  });

  test("at the threshold it IS fleet-wide", () => {
    const many = Array.from({ length: AXON_FLEET_WIDE_FLAGS }, (_, i) =>
      finding(i),
    );
    assert.equal(isFleetWide(many), true);
  });

  test("nothing flagged is not fleet-wide", () => {
    assert.equal(isFleetWide([]), false);
  });
});

describe("evaluateAxonAnnouncements and axonDetail", () => {
  test("worst ratio first, and only subnets with findings", () => {
    const bySubnet = new Map<number, AxonDay[]>([
      [101, then(flat(8, 223), [129, 256])],
      [1, flat(9, 200)],
      [103, then(flat(8, 252), [0, 2])],
    ]);
    const found = evaluateAxonAnnouncements(bySubnet);
    assert.deepEqual(
      found.map((f) => f.netuid),
      [103, 101],
      "sorted by severity, and the healthy subnet is absent",
    );
  });

  test("equal ratios fall back to netuid so the order is stable", () => {
    const bySubnet = new Map<number, AxonDay[]>([
      [9, then(flat(8, 100), [10, 256])],
      [2, then(flat(8, 100), [10, 256])],
    ]);
    assert.deepEqual(
      evaluateAxonAnnouncements(bySubnet).map((f) => f.netuid),
      [2, 9],
    );
  });

  test("an empty detail says so rather than reading as an empty finding", () => {
    assert.equal(axonDetail([]), "no subnet below baseline");
  });

  test("detail names the counts and calls out turnover", () => {
    const bySubnet = new Map<number, AxonDay[]>([
      [103, then(flat(8, 252), [0, 2])],
    ]);
    const detail = axonDetail(evaluateAxonAnnouncements(bySubnet));
    assert.match(detail, /SN103 0\/252 axons/);
    assert.match(detail, /the subnet turned over/);
  });

  test("a long list is bounded and says how many it withheld", () => {
    const bySubnet = new Map<number, AxonDay[]>();
    for (let i = 0; i < AXON_MAX_LISTED + 3; i += 1) {
      bySubnet.set(i + 1, then(flat(8, 100), [10 + i, 256]));
    }
    const detail = axonDetail(evaluateAxonAnnouncements(bySubnet));
    assert.match(detail, /\(\+3 more\)/);
  });
});

describe("groupAxonDays", () => {
  test("groups by netuid and sorts oldest first regardless of row order", () => {
    const grouped = groupAxonDays([
      { netuid: 5, date: "2026-08-02", with_axon: 2, neurons: 10 },
      { netuid: 5, date: "2026-08-01", with_axon: 1, neurons: 10 },
      { netuid: 6, date: "2026-08-01", with_axon: 9, neurons: 10 },
    ]);
    assert.deepEqual(
      grouped.get(5)?.map((d) => d.date),
      ["2026-08-01", "2026-08-02"],
    );
    assert.equal(grouped.get(6)?.length, 1);
  });

  test("unusable rows are dropped rather than defaulted into the series", () => {
    const grouped = groupAxonDays([
      { netuid: "nope", date: "2026-08-01", with_axon: 1, neurons: 1 },
      { netuid: 5, date: "", with_axon: 1, neurons: 1 },
      { netuid: 5, date: "2026-08-01", with_axon: "x", neurons: 1 },
      { netuid: 5, date: "2026-08-02", with_axon: 1, neurons: 1 },
    ]);
    assert.equal(grouped.size, 1);
    assert.equal(grouped.get(5)?.length, 1);
  });

  test("COUNT(*) arrives as a STRING from Postgres and is still counted", () => {
    // Verified against production Neon 2026-08-15: `COUNT(*)` is int8, and the
    // driver hands int8 back as a string. A reader that compared these without
    // coercing would silently measure nothing -- every ratio would be NaN and
    // `NaN < 0.7` is false, so the watchdog would report a permanently clean
    // sweep. See tests/pg-int8-shape.test.ts for the same trap elsewhere.
    const grouped = groupAxonDays([
      { netuid: 101, date: "2026-08-01", with_axon: "223", neurons: "256" },
    ]);
    assert.deepEqual(grouped.get(101), [
      { date: "2026-08-01", withAxon: 223, neurons: 256 },
    ]);
  });

  test("a string-typed series still produces a finding end to end", () => {
    // The composed version of the above: the failure mode is silence, so the
    // assertion has to be that something IS found.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({
        netuid: 101,
        date: `2026-08-0${i + 1}`,
        with_axon: "223",
        neurons: "256",
      })),
      { netuid: 101, date: "2026-08-09", with_axon: "129", neurons: "256" },
    ];
    const found = evaluateAxonAnnouncements(groupAxonDays(rows));
    assert.equal(found.length, 1);
    assert.equal(found[0].withAxon, 129);
    assert.equal(found[0].baseline, 223);
  });

  test("a null row set is empty, not a throw", () => {
    assert.equal(
      groupAxonDays(null as unknown as Record<string, unknown>[]).size,
      0,
    );
  });
});

describe("the defensive fallbacks, each exercised", () => {
  // These are the paths that only run when something upstream is already
  // malformed. Untested, they are where a watchdog quietly starts measuring
  // nothing — so each one gets its own case rather than being assumed.

  test("absent columns default rather than producing NaN rows", () => {
    // A row missing with_axon/neurons entirely (a schema change, a partial
    // projection) reads as zero rather than NaN. NaN would make every ratio
    // NaN, and `NaN < 0.7` is false — a permanently clean sweep.
    const grouped = groupAxonDays([{ netuid: 5, date: "2026-08-01" }]);
    assert.deepEqual(grouped.get(5), [
      { date: "2026-08-01", withAxon: 0, neurons: 0 },
    ]);
  });

  test("an absent date is skipped, not coerced to the string 'undefined'", () => {
    assert.equal(groupAxonDays([{ netuid: 5 }]).size, 0);
  });

  test("a neuron baseline that cannot be measured does not claim turnover", () => {
    // Every neuron reading in the window is unusable, so the median is null and
    // the fallback is 0 — which must NOT be read as "neurons collapsed to zero".
    const series: AxonDay[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        date: `2026-08-0${i + 1}`,
        withAxon: 100,
        neurons: Number.NaN,
      })),
      { date: "2026-09-01", withAxon: 10, neurons: 256 },
    ];
    const f = evaluateSubnetAxons(11, series);
    assert.ok(f);
    assert.equal(f.neuronBaseline, 0);
    assert.equal(
      f.kind,
      "announcements-withdrawn",
      "an unmeasurable neuron baseline cannot assert the subnet turned over",
    );
  });

  test("a non-Error thrown by the store is still reported", async () => {
    pg.control.queries.length = 0;
    pg.control.answers.length = 0;
    pg.control.failNext = "connection went away" as unknown as Error;
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { ok: boolean; detail: string };
    assert.equal(result.ok, false);
    assert.match(result.detail, /connection went away/);
  });

  test("a failing exception recorder does not take the verdict down with it", async () => {
    // The verdict write is the durable half. A telemetry outage must not stop
    // it, which is the same contract recordLaneVerdict promises its callers.
    pg.control.queries.length = 0;
    pg.control.answers.length = 0;
    pg.control.answers.push({
      match: /FROM neuron_daily/,
      rows: [
        ...Array.from({ length: 8 }, (_, i) => ({
          netuid: 101,
          date: `2026-08-0${i + 1}`,
          with_axon: 223,
          neurons: 256,
        })),
        { netuid: 101, date: "2026-08-09", with_axon: 129, neurons: 256 },
      ],
    });
    pg.control.answers.push({ match: /.*/, rows: [] });
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => {
        throw new Error("posthog down");
      }) as never,
    })) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
    assert.ok(
      pg.control.queries.some((q) =>
        q.text.includes("INSERT INTO lane_health"),
      ),
      "the verdict landed even though the exception capture threw",
    );
  });

  test("runs with no deps at all, taking its own clock and recorder", async () => {
    // The production call site passes none of them.
    pg.control.queries.length = 0;
    pg.control.answers.length = 0;
    pg.control.answers.push({ match: /.*/, rows: [] });
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv())) as {
      ok: boolean;
      alerted: boolean;
    };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
  });
});

describe("isoDaysAgo", () => {
  test("returns a snapshot_date-shaped string", () => {
    assert.equal(
      isoDaysAgo(Date.parse("2026-08-15T12:00:00Z"), 8),
      "2026-08-07",
    );
  });

  test("a broken clock degrades to now rather than producing NaN", () => {
    assert.match(isoDaysAgo(Number.NaN, 8), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the watchdog tick", () => {
  beforeEach(() => {
    pg.control.queries.length = 0;
    pg.control.answers.length = 0;
    pg.control.rows = null;
    pg.control.failNext = null;
  });

  const answerWith = (rows: Record<string, unknown>[]) => {
    pg.control.answers.push({ match: /FROM neuron_daily/, rows });
    pg.control.answers.push({ match: /.*/, rows: [] });
  };

  const recordedVerdict = () => {
    const insert = pg.control.queries.find((q) =>
      q.text.includes("INSERT INTO lane_health"),
    );
    assert.ok(insert, "the tick recorded a verdict");
    return {
      lane: insert.values[0],
      verdict: insert.values[1],
      detail: insert.values[3],
    };
  };

  const rowsFor = (netuid: number, series: AxonDay[]) =>
    series.map((d) => ({
      netuid,
      date: d.date,
      with_axon: d.withAxon,
      neurons: d.neurons,
    }));

  test("records `stale` and NAMES the subnet when axons collapse", async () => {
    answerWith(rowsFor(101, then(flat(8, 223), [129, 256])));
    let captured: Record<string, unknown> | null = null;
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async (_e: unknown, ev: Record<string, unknown>) => {
        captured = ev;
        return true;
      }) as never,
    })) as { ok: boolean; alerted: boolean; fleet_wide: boolean };

    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
    assert.equal(result.fleet_wide, false);
    const v = recordedVerdict();
    assert.equal(v.lane, "axon-announcement");
    assert.equal(v.verdict, "stale");
    assert.match(String(v.detail), /SN101 129\/223 axons/);
    assert.equal(
      (captured as unknown as { errorCode: string }).errorCode,
      "axon_announcements_dropped",
    );
    assert.equal(
      (captured as unknown as { route: string }).route,
      "watchdog:axon-announcement",
      "the route is NOT a lane-alarm or -staleness shape, so it still pages",
    );
  });

  test("records `ok` when nothing moved", async () => {
    answerWith(rowsFor(1, flat(9, 200)));
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { alerted: boolean };
    assert.equal(result.alerted, false);
    assert.equal(recordedVerdict().verdict, "ok");
    assert.match(String(recordedVerdict().detail), /no subnet below baseline/);
  });

  test("many subnets at once is reported as OUR capture, not their outage", async () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < AXON_FLEET_WIDE_FLAGS; i += 1) {
      rows.push(...rowsFor(i + 1, then(flat(8, 100), [5, 256])));
    }
    answerWith(rows);
    let captured: Record<string, unknown> | null = null;
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async (_e: unknown, ev: Record<string, unknown>) => {
        captured = ev;
        return true;
      }) as never,
    })) as { fleet_wide: boolean };

    assert.equal(result.fleet_wide, true);
    assert.equal(
      (captured as unknown as { errorCode: string }).errorCode,
      "axon_capture_suspect",
      "a different code, because it sends a reader to the poller not to a subnet",
    );
    assert.match(
      String((captured as unknown as { error: Error }).error.message),
      /capture failing rather than as subnets going dark/,
    );
  });

  test("a failing read is reported, not rendered as a clean sweep", async () => {
    pg.control.failNext = new Error("connection reset");
    const result = (await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { ok: boolean; reason: string; detail: string };
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.match(result.detail, /connection reset/);
    assert.equal(
      pg.control.queries.some((q) =>
        q.text.includes("INSERT INTO lane_health"),
      ),
      false,
      "a failed read records NO verdict -- silence beats a false `ok`",
    );
  });

  test("declines rather than reporting a clean sweep with no store", async () => {
    const result = (await runAxonAnnouncementWatchdog(undefined, {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { ok: boolean; reason: string };
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no store bound");
  });

  test("the window it asks for covers the baseline plus the day under test", async () => {
    answerWith(rowsFor(1, flat(9, 200)));
    await runAxonAnnouncementWatchdog(pgMockEnv(), {
      now: () => Date.parse("2026-08-15T12:00:00Z"),
      recordException: (async () => true) as never,
    });
    const read = pg.control.queries.find((q) =>
      q.text.includes("FROM neuron_daily"),
    );
    assert.ok(read);
    assert.equal(read.values[0], "2026-08-07");
  });
});
