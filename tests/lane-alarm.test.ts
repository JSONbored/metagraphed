// The lane-health READER (src/lane-alarm.ts).
//
// The load-bearing properties are all about restraint, because an alerting
// system's failure mode is being muted rather than being wrong:
//
//   * a lane must be stale CONTINUOUSLY to alarm -- a flicker must not,
//   * an alarm must not be re-opened while its issue is still open,
//   * an unreadable issue list must NOT be read as "nothing is open",
//   * and only an `ok` verdict closes -- `unknown` is not recovery.
//
// The silence detector gets the same scrutiny from the other direction: it must
// fire for a watchdog that stopped writing while its last verdict said `ok`,
// which is the fault that had no detector at all before this file.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The store is Postgres now (#10179), reached through `new Client(...)` inside
// src/lane-health-store.ts -- which runLaneAlarm cannot be handed, because it
// selects its own store from `env` and takes no db dep. Mocking the module is
// the seam; see tests/helpers/pg-mock.ts for why it is a module mock and why
// the controller has to be built inside vi.hoisted.
//
// The pure readers below (loadLaneStaleRuns, loadLaneUnknownRuns, loadLaneMaxGap) take
// a `db` argument, so they keep their own hand-rolled double -- injection is
// still injection, and a module mock would say less about them than the fake
// they are handed.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  laneAlarmSummary,
  LANE_ALARM_MAX_OPENS_PER_TICK,
  LANE_ALARM_MIN_STALE_MS,
  LANE_SILENCE_EXEMPT,
  LANE_ALARM_TITLE_PREFIX,
  LANE_MAX_GAP_SQL,
  LANE_STALE_RUN_SQL,
  laneAlarmGitHub,
  laneAlarmIssueBody,
  laneAlarmPlan,
  laneAlarmRecoveryComment,
  laneAlarmTitle,
  laneSilenceThresholdMs,
  loadLaneMaxGap,
  loadLaneStaleRuns,
  runLaneAlarm,
  type LaneAlarm,
  type LaneAlarmGitHub,
} from "../src/lane-alarm.ts";
import type { LaneHealthRecord } from "../src/lane-health.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60 * 1000;

function record(over: Partial<LaneHealthRecord> = {}): LaneHealthRecord {
  return {
    lane: "neurons-staleness",
    verdict: "stale",
    age_ms: 4 * HOUR,
    detail: "partial",
    checked_at: NOW - 1000,
    ...over,
  };
}

/** A double for the `db` these two readers TAKE. They are the injectable half
 * of this module -- runLaneAlarm selects its own store, but loadLaneStaleRuns
 * and loadLaneMaxGap are handed one -- so a hand-rolled fake still says more
 * here than the module mock does. Returns rows, or throws however asked. */
function fakeDb(rows: Record<string, unknown>[] | Error = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const answer = () => {
    if (rows instanceof Error) throw rows;
    return rows;
  };
  return {
    calls,
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return answer();
    },
    async run(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return { changes: 1 };
    },
  };
}

// The `laneCadenceMs` describe was REMOVED (#10723) along with the function: it
// documented a MEAN-gap computation nobody performs any more. Why the mean was the
// wrong number is recorded in tests/lane-silence-cadence.test.ts and in
// src/lane-alarm.ts's LANE_MAX_GAP_SQL comment.

describe("laneSilenceThresholdMs", () => {
  test("three intervals for a slow lane", () => {
    assert.equal(laneSilenceThresholdMs(24 * HOUR), 72 * HOUR);
  });

  test("floors a fast lane, so a deploy is not an outage", () => {
    // tao-usd-index ticks every minute; three intervals would be 3 minutes.
    assert.equal(laneSilenceThresholdMs(60_000), 90 * 60_000);
  });
});

describe("laneAlarmPlan", () => {
  const base = {
    latest: {},
    runs: {},
    unknownRuns: {},
    observedMaxGap: {},
    openAlarms: {},
    nowMs: NOW,
    minStaleMs: LANE_ALARM_MIN_STALE_MS,
  };

  test("alarms on a lane stale for longer than the threshold", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 28 * HOUR, ticks: 112 } },
      observedMaxGap: { a: 15 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.deepEqual(
      {
        lane: plan.open[0].lane,
        kind: plan.open[0].kind,
        ticks: plan.open[0].ticks,
        cadence: plan.open[0].cadence_ms,
      },
      { lane: "a", kind: "stale", ticks: 112, cadence: 15 * 60_000 },
    );
  });

  // #10634: a lane that reports a VALUE, not a heartbeat.
  //
  // `poller-build` is written once per container start, to announce the running
  // build. It alarmed continuously for two days ("silent: 2.0 days") while the
  // poller was 31 seconds behind head and writing normally — five deploys in the
  // cadence window were enough to calibrate a "cadence" out of DEPLOY intervals,
  // after which the healthy state (no reboot) reads as an outage.
  // #10695: the verdict the OPEN path had no case for.
  //
  // The close path already refused to treat `unknown` as recovery, and
  // migrations/neon/0006 says collapsing it into `ok` "would report an unmeasured
  // lane as a healthy one" -- but nothing opened an alarm for it. A lane that went
  // `ok` -> `unknown` and stayed there was invisible: not stale, and not silent
  // because it kept recording. Measured consequence: #10676 moved
  // `table-freshness` off a `providers` breach, which left it reporting `unknown`
  // for the stampFrom divergence (#10656) with nothing to say so.
  test("alarms a lane stuck on `unknown` past the stale bound", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", verdict: "unknown" }) },
      unknownRuns: { a: { since: NOW - 4 * HOUR, ticks: 4 } },
      observedMaxGap: { a: 15 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].lane, "a");
    // Its OWN kind, not folded into stale: `stale` means a breach was measured,
    // `unknown` means the measurement did not happen.
    assert.equal(plan.open[0].kind, "unknown");
    assert.equal(plan.open[0].ticks, 4);
  });

  test("one `unknown` tick is ordinary, not an alarm", () => {
    // An unreadable table or a cross-check that could not run is a normal single
    // tick. The bound is the same one stale uses, so this cannot become noisier
    // than the stale path it mirrors.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", verdict: "unknown" }) },
      unknownRuns: { a: { since: NOW - 60_000, ticks: 1 } },
      observedMaxGap: { a: 15 * 60_000 },
    });
    assert.deepEqual(plan.open, []);
  });

  test("a LIVE `unknown` lane alarms once, as unknown and not as silent", () => {
    // Two issues for one fault is the noise this design avoids. The lane is
    // still recording, so it is the unknown loop's finding; the silence loop
    // must not also claim it.
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({ lane: "a", verdict: "unknown", checked_at: NOW - 30_000 }),
      },
      unknownRuns: { a: { since: NOW - 6 * HOUR, ticks: 6 } },
      observedMaxGap: { a: 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "unknown");
  });

  test("an `unknown` lane that STOPPED recording is silent, not unknown", () => {
    // The pre-existing rule, and the right priority: a dead producer outranks
    // "running but cannot measure". Without the liveness gate in the unknown
    // loop this would report the weaker finding.
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "unknown",
          checked_at: NOW - 6 * HOUR,
        }),
      },
      unknownRuns: { a: { since: NOW - 6 * HOUR, ticks: 6 } },
      observedMaxGap: { a: 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "silent");
  });

  // #10723: the assertion that would have caught four false alarms.
  //
  // `neon:account-balances` writes a verdict per BATCH -- 6,268 rows in seven days
  // against a six-hourly producer -- so its observed MEAN gap is one minute. Judged
  // by that, every gap between passes is an outage, and on 2026-08-11T02:28Z four
  // Neon lanes alarmed at 1.7-1.8h against producers running every 6h and 24h.
  //
  // laneSilenceCadenceMs floors the observed gap by the producer's DECLARED cadence
  // wherever LANE_PRODUCER names one, which is what src/self-health.ts already did.
  test("a lane with a declared producer is not alarmed inside its interval", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        "neon:account-balances": record({
          lane: "neon:account-balances",
          verdict: "ok",
          // Well past the 90-minute floor, and well inside the declared 6h.
          checked_at: NOW - 2 * HOUR,
        }),
      },
      // The mean-gap number that caused the false alarms.
      observedMaxGap: { "neon:account-balances": 60_000 },
    });
    assert.deepEqual(plan.open, []);
  });

  test("a lane with a declared producer still alarms past three intervals", () => {
    // The floor must not become a mute button: three cadences of slack, then it
    // fires. account_balances is 6h, so 20h is past 3x.
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        "neon:account-balances": record({
          lane: "neon:account-balances",
          verdict: "ok",
          checked_at: NOW - 20 * HOUR,
        }),
      },
      observedMaxGap: { "neon:account-balances": 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "silent");
    // The DECLARED cadence is what it reports, not the one-minute observation.
    assert.equal(plan.open[0].cadence_ms, 6 * HOUR);
  });

  test("a lane with NO declared producer still uses its observed gap", () => {
    // The fallback has to survive: an undeclared lane behaves exactly as before.
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        z: record({ lane: "z", verdict: "ok", checked_at: NOW - 4 * HOUR }),
      },
      observedMaxGap: { z: 30 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].cadence_ms, 30 * 60_000);
  });

  test("never alarms an exempt lane for silence, however long it is quiet", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        "poller-build": record({
          lane: "poller-build",
          verdict: "ok",
          checked_at: NOW - 30 * 24 * HOUR,
        }),
      },
      // A calibrated cadence, which is exactly the state that produced the
      // false alarm — the exemption has to hold even so.
      observedMaxGap: { "poller-build": 12 * HOUR },
    });
    assert.deepEqual(plan.open, []);
  });

  // The exemption is SILENCE-ONLY. A verdict the lane actually reports is the
  // lane saying something is wrong, and must still alarm — otherwise this would
  // be suppressing a watchdog rather than fixing its cadence model.
  test("still alarms an exempt lane that reports itself STALE", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        "poller-build": record({ lane: "poller-build", verdict: "stale" }),
      },
      runs: { "poller-build": { since: NOW - 28 * HOUR, ticks: 40 } },
      observedMaxGap: { "poller-build": 12 * HOUR },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].lane, "poller-build");
    assert.equal(plan.open[0].kind, "stale");
  });

  // Proving the exemption is narrow: without this, an `in` check against the
  // wrong object (or a blanket skip) would pass both tests above.
  test("a non-exempt lane with the same shape still alarms as silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        neurons: record({
          lane: "neurons",
          verdict: "ok",
          checked_at: NOW - 30 * 24 * HOUR,
        }),
      },
      observedMaxGap: { neurons: 12 * HOUR },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].lane, "neurons");
    assert.equal(plan.open[0].kind, "silent");
  });

  // Every exemption has to carry a reason naming what covers the lane instead,
  // so the map cannot grow into a place things go to stop being checked.
  test("every exempt lane declares a non-trivial reason", () => {
    const entries = Object.entries(LANE_SILENCE_EXEMPT);
    assert.ok(entries.length > 0);
    // Small on purpose. If this ever needs raising, the lane probably wants its
    // cadence fixed instead.
    assert.ok(
      entries.length <= 3,
      `the exempt map should stay small, has ${entries.length}`,
    );
    for (const [lane, reason] of entries) {
      assert.ok(reason.length > 40, `${lane} needs a real reason`);
      assert.match(reason, /covered by|indexer-lag|liveness/i);
    }
  });

  test("a one-tick flicker never reaches the threshold", () => {
    // chain-detail did this 64 times in one day while being healthy. If a blip
    // could alarm, the alarm would be muted within a week.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 60_000, ticks: 1 } },
    });
    assert.deepEqual(plan.open, []);
  });

  test("dates a stale lane from its newest verdict when no run row exists", () => {
    // The two reads are separate queries; a verdict can land between them.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", checked_at: NOW - 3 * HOUR }) },
      runs: {},
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].since, NOW - 3 * HOUR);
    assert.equal(plan.open[0].ticks, 1);
    assert.equal(plan.open[0].cadence_ms, null);
  });

  test("alarms on a SILENT lane whose last verdict said ok", () => {
    // The fault with no detector: staleLanes() sees nothing, because nothing it
    // can see is stale. The watchdog simply stopped writing.
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "ok",
          detail: null,
          checked_at: NOW - 6 * HOUR,
        }),
      },
      observedMaxGap: { a: 30 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "silent");
    assert.equal(plan.open[0].ticks, 0);
  });

  test("a lane inside its own cadence is not silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({ lane: "a", verdict: "ok", checked_at: NOW - 20 * 60_000 }),
      },
      observedMaxGap: { a: 15 * 60_000 },
    });
    assert.deepEqual(plan.open, []);
  });

  test("an uncalibrated lane is never called silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "ok",
          checked_at: NOW - 40 * 24 * HOUR,
        }),
      },
      observedMaxGap: {},
    });
    assert.deepEqual(plan.open, []);
  });

  test("a stale lane raises one alarm, not two", () => {
    // It is also, by definition, not writing recently -- but "stale" and "then
    // it stopped saying so" are one outage.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", checked_at: NOW - 9 * HOUR }) },
      runs: { a: { since: NOW - 9 * HOUR, ticks: 30 } },
      observedMaxGap: { a: 15 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "stale");
  });

  test("an `unknown` verdict is never STALE, but can still go silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "unknown",
          checked_at: NOW - 9 * HOUR,
        }),
      },
      observedMaxGap: { a: 15 * 60_000 },
    });
    // staleLanes() excludes `unknown`, so this cannot be a stale alarm. It is
    // 9 hours past a 15-minute cadence, though, so the silence detector still
    // reaches it -- which is the point: "the watchdog cannot evaluate this lane
    // and has now stopped trying" is exactly what needs reporting.
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "silent");
  });

  test("ignores a RETIRED lane whose last verdict is a week old", () => {
    // A retired lane's final row sits in lane_health until retention expires
    // it. If that row said `stale`, staleLanes() keeps returning it -- and the
    // alarm would re-raise a lane that no longer exists for 90 days.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", checked_at: NOW - 9 * 24 * HOUR }) },
      runs: { a: { since: NOW - 30 * 24 * HOUR, ticks: 4000 } },
    });
    assert.deepEqual(plan.open, []);
    // And it cannot come back as `silent` either: the cadence read looks at the
    // same window, so a lane with nothing in it is uncalibrated.
    assert.equal(plan.suppressed, 0);
  });

  test("does not re-open a lane that already has an issue", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 28 * HOUR, ticks: 112 } },
      openAlarms: { a: 4242 },
    });
    assert.deepEqual(plan.open, []);
    assert.equal(plan.suppressed, 0);
  });

  test("caps a platform-wide outage, and reports what it capped", () => {
    const latest: Record<string, LaneHealthRecord> = {};
    const runs: Record<string, { since: number; ticks: number }> = {};
    for (let i = 0; i < 9; i += 1) {
      const lane = `lane-${i}`;
      latest[lane] = record({ lane });
      // Descending start times, so the WORST are not the ones sorted first.
      runs[lane] = { since: NOW - (2 + i) * HOUR, ticks: 10 };
    }
    const plan = laneAlarmPlan({ ...base, latest, runs });
    assert.equal(plan.open.length, LANE_ALARM_MAX_OPENS_PER_TICK);
    assert.equal(plan.suppressed, 9 - LANE_ALARM_MAX_OPENS_PER_TICK);
    // Oldest-first: the longest-running fault must survive the cap.
    assert.equal(plan.open[0].lane, "lane-8");
  });

  test("closes an issue when its lane reports ok", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", verdict: "ok" }) },
      openAlarms: { a: 77 },
    });
    assert.deepEqual(
      plan.close.map((c) => ({ lane: c.lane, issue: c.issue })),
      [{ lane: "a", issue: 77 }],
    );
  });

  test("does NOT close on `unknown` -- absence of measurement is not recovery", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", verdict: "unknown" }) },
      openAlarms: { a: 77 },
    });
    assert.deepEqual(plan.close, []);
  });

  test("does NOT close a lane that has no record at all", () => {
    const plan = laneAlarmPlan({ ...base, openAlarms: { a: 77 } });
    assert.deepEqual(plan.close, []);
  });

  test("does not close a lane that is still stale", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 28 * HOUR, ticks: 112 } },
      openAlarms: { a: 77 },
    });
    assert.deepEqual(plan.close, []);
  });
});

describe("laneAlarmIssueBody", () => {
  function alarm(over: Partial<LaneAlarm> = {}): LaneAlarm {
    return {
      lane: "neurons-staleness",
      kind: "stale",
      since: NOW - 28 * HOUR,
      ticks: 112,
      detail: "partial",
      age_ms: 4 * HOUR,
      cadence_ms: 15 * 60_000,
      ...over,
    };
  }

  test("a stale body names the duration, the tick count, and the reason", () => {
    const body = laneAlarmIssueBody(alarm(), NOW);
    assert.match(body, /reported \*\*stale\*\* on every tick/);
    assert.match(body, /28\.0h/);
    assert.match(body, /112 consecutive verdicts/);
    assert.match(body, /watchdog said \| `partial`/);
    assert.match(body, /observed cadence \| 15 min/);
    assert.match(body, /lane was behind by \| 4\.0h/);
    assert.match(body, /FROM lane_health WHERE lane = 'neurons-staleness'/);
  });

  test("a silent body says the watchdog stopped, and what it last said", () => {
    const body = laneAlarmIssueBody(
      alarm({ kind: "silent", ticks: 0, detail: "ok", age_ms: null }),
      NOW,
    );
    assert.match(body, /no verdict at all/);
    assert.match(body, /appears to have stopped running/);
    assert.doesNotMatch(body, /lane was behind by/);
  });

  test("a silent lane that never wrote a detail still reads correctly", () => {
    const body = laneAlarmIssueBody(
      alarm({ kind: "silent", detail: null, cadence_ms: null }),
      NOW,
    );
    assert.match(body, /last verdict it did write said `ok`/);
    assert.doesNotMatch(body, /observed cadence/);
    assert.doesNotMatch(body, /watchdog said/);
  });

  test("renders every duration scale", () => {
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 30_000 }), NOW),
      /30s/,
    );
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 20 * 60_000 }), NOW),
      /20 min/,
    );
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 5 * HOUR }), NOW),
      /5\.0h/,
    );
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 102 * HOUR }), NOW),
      /4\.3 days/,
    );
  });

  test("never renders a negative duration from a clock that disagrees", () => {
    // `since` comes from the store and `now` from the Worker; they are
    // different clocks, and "-3s" in an alarm reads as a bug in the alarm.
    assert.match(laneAlarmIssueBody(alarm({ since: NOW + 3000 }), NOW), /0s/);
  });
});

describe("laneAlarmRecoveryComment", () => {
  test("states the recovery time and the verdict detail", () => {
    const comment = laneAlarmRecoveryComment(
      "a",
      record({ verdict: "ok", detail: "129 of 129 netuids" }),
    );
    assert.match(comment, /reported \*\*ok\*\*/);
    assert.match(comment, /129 of 129 netuids/);
  });

  test("reads cleanly when the watchdog wrote no detail", () => {
    const comment = laneAlarmRecoveryComment(
      "a",
      record({ verdict: "ok", detail: null }),
    );
    assert.match(comment, /Closing automatically\.$/);
  });
});

// RE-POINTED AT loadLaneMaxGap (#10723). These assertions were written against
// loadLaneCadence -- the mean-gap loader, now deleted -- but what they actually
// cover is the robustness contract every one of these readers shares: skip a row
// with no lane, coerce an unreadable number, tolerate a driver that answers
// without a `results` key, and decline to `{}` rather than throw. That contract
// matters more on the loader the alarm actually issues.
describe("loadLaneStaleRuns / loadLaneMaxGap", () => {
  test("read the current run and the observed cadence", async () => {
    const db = fakeDb([{ lane: "a", since: 10, ticks: 5 }]);
    assert.deepEqual(await loadLaneStaleRuns(db), {
      a: { since: 10, ticks: 5 },
    });
    assert.equal(db.calls[0].sql, LANE_STALE_RUN_SQL);

    const gapDb = fakeDb([{ lane: "a", n: 5, max_gap: 15 * 60_000 }]);
    assert.deepEqual(await loadLaneMaxGap(gapDb, NOW - 7 * 24 * HOUR), {
      a: 15 * 60_000,
    });
    assert.equal(gapDb.calls[0].sql, LANE_MAX_GAP_SQL);
    assert.deepEqual(gapDb.calls[0].values, [NOW - 7 * 24 * HOUR]);
  });

  test("skip a row with no lane name rather than keying on an empty string", async () => {
    assert.deepEqual(
      await loadLaneStaleRuns(fakeDb([{ since: 1, ticks: 1 }])),
      {},
    );
    assert.deepEqual(
      await loadLaneMaxGap(fakeDb([{ n: 5, max_gap: 1 }]), 0),
      {},
    );
  });

  test("coerce an unreadable count to zero rather than NaN", async () => {
    // A NaN cadence compares false against every threshold, which would report
    // a dead watchdog healthy -- the same class of bug as #9530's NaN coverage.
    assert.deepEqual(
      await loadLaneStaleRuns(fakeDb([{ lane: "a", since: "x", ticks: null }])),
      { a: { since: 0, ticks: 0 } },
    );
  });

  test("treat a driver that answers with no rows key as empty", async () => {
    // Drivers have answered both `{}` and `null` here; a reader that trusted
    // The D1 null-result premise retired with the envelope (#10909); the
    // remaining nothing-shape is zero rows, which must read as no lanes.
    const shim = {
      query: async () => [],
      run: async () => ({ changes: 1 }),
    };
    assert.deepEqual(await loadLaneStaleRuns(shim), {});
    assert.deepEqual(await loadLaneMaxGap(shim, 0), {});
  });

  test("return empty on a missing binding or a failing query", async () => {
    assert.deepEqual(await loadLaneStaleRuns(null), {});
    assert.deepEqual(await loadLaneMaxGap(undefined, 0), {});
    assert.deepEqual(
      await loadLaneStaleRuns(fakeDb(new Error("no such table"))),
      {},
    );
    assert.deepEqual(await loadLaneMaxGap(fakeDb(new Error("boom")), 0), {});
  });
});

describe("laneAlarmGitHub", () => {
  function client(handler: (url: string, init?: RequestInit) => unknown) {
    const seen: { url: string; init?: RequestInit }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      const out = handler(url, init);
      return out ?? { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { seen, gh: laneAlarmGitHub("t0ken", "o/r", impl) };
  }

  test("lists only open lane alarms, keyed by lane", async () => {
    const { gh, seen } = client(() => ({
      ok: true,
      json: async () => [
        { number: 1, title: `${LANE_ALARM_TITLE_PREFIX}neurons-staleness` },
        { number: 2, title: "feat: unrelated" },
        // A PR whose title matches would otherwise be closed as an alarm.
        {
          number: 3,
          title: `${LANE_ALARM_TITLE_PREFIX}metagraph`,
          pull_request: {},
        },
        { number: 4, title: LANE_ALARM_TITLE_PREFIX },
        { number: null, title: `${LANE_ALARM_TITLE_PREFIX}ghost` },
        { title: `${LANE_ALARM_TITLE_PREFIX}nameless` },
        {},
      ],
    }));
    assert.deepEqual(await gh.listOpen(), { "neurons-staleness": 1 });
    assert.match(
      seen[0].url,
      /\/repos\/o\/r\/issues\?state=open&per_page=100$/,
    );
  });

  // NULL, not `{}`. This asserted the opposite, and the opposite is what put
  // production in the state it was in: runLaneAlarm's own comment says an
  // unreadable issue list must not be read as "no alarms are open" -- and then
  // this client answered exactly that for every non-2xx, so the runner's guard
  // could never fire. A token that cannot LIST issues cannot CREATE them
  // either, so every tick planned a full set of opens and got none.
  test("an error or an unreadable body DECLINES, rather than reporting nothing open", async () => {
    const bad = client(() => ({ ok: false, json: async () => [] }));
    assert.equal(await bad.gh.listOpen(), null);
    const odd = client(() => ({
      ok: true,
      json: async () => ({ message: "nope" }),
    }));
    assert.equal(await odd.gh.listOpen(), null);
    // And an empty list still means empty -- the two must stay distinguishable.
    const empty = client(() => ({ ok: true, json: async () => [] }));
    assert.deepEqual(await empty.gh.listOpen(), {});
  });

  // #11194: per-ROW parsing. One issue GitHub shapes unexpectedly must cost
  // that issue and not the page -- refusing the whole list would drop every
  // open alarm and re-raise all of them on the next tick.
  test("an unreadable row is skipped; the rest of the page still lists", async () => {
    const { gh } = client(() => ({
      ok: true,
      json: async () => [
        { number: 5, title: 42 },
        "not an object even slightly",
        { number: 1, title: `${LANE_ALARM_TITLE_PREFIX}neurons-staleness` },
      ],
    }));
    assert.deepEqual(await gh.listOpen(), { "neurons-staleness": 1 });
  });

  test("opens an issue and returns its number", async () => {
    const { gh, seen } = client(() => ({
      ok: true,
      json: async () => ({ number: 99 }),
    }));
    const alarm = {
      lane: "a",
      kind: "stale" as const,
      since: NOW,
      ticks: 1,
      detail: null,
      age_ms: null,
      cadence_ms: null,
    };
    assert.equal(await gh.open(alarm, "t", "b"), 99);
    assert.equal(seen[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(seen[0].init?.body)), {
      title: "t",
      body: "b",
    });
  });

  test("a rejected or numberless create reports null rather than a false success", async () => {
    const denied = client(() => ({ ok: false, json: async () => ({}) }));
    const alarm = {
      lane: "a",
      kind: "stale" as const,
      since: NOW,
      ticks: 1,
      detail: null,
      age_ms: null,
      cadence_ms: null,
    };
    assert.equal(await denied.gh.open(alarm, "t", "b"), null);
    const odd = client(() => ({ ok: true, json: async () => ({}) }));
    assert.equal(await odd.gh.open(alarm, "t", "b"), null);
  });

  test("comments before it closes, so the history carries the reason", async () => {
    const { gh, seen } = client(() => ({ ok: true, json: async () => ({}) }));
    assert.equal(await gh.close(12, "recovered"), true);
    assert.match(seen[0].url, /\/issues\/12\/comments$/);
    assert.equal(seen[1].init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(seen[1].init?.body)), {
      state: "closed",
      state_reason: "completed",
    });
  });

  test("still closes when the comment fails", async () => {
    // The close is the point. A dropped comment is a worse issue history, not
    // an alarm left open forever.
    let first = true;
    const { gh } = client(() => {
      if (first) {
        first = false;
        throw new Error("comment rejected");
      }
      return { ok: true, json: async () => ({}) };
    });
    assert.equal(await gh.close(12, "recovered"), true);
  });

  test("reports a failed close rather than counting it", async () => {
    const { gh } = client((url) =>
      url.endsWith("/comments")
        ? { ok: true, json: async () => ({}) }
        : { ok: false, json: async () => ({}) },
    );
    assert.equal(await gh.close(12, "recovered"), false);
  });
});

describe("runLaneAlarm", () => {
  /** A GitHub double that records what it was asked to do. */
  function fakeGitHub(open: Record<string, number> = {}): LaneAlarmGitHub & {
    opened: string[];
    closed: number[];
  } {
    const opened: string[] = [];
    const closed: number[] = [];
    return {
      opened,
      closed,
      listOpen: async () => open,
      open: async (alarm) => {
        opened.push(alarm.lane);
        return 100 + opened.length;
      },
      close: async (issue) => {
        closed.push(issue);
        return true;
      },
    };
  }

  /** The store, answering each of the three reads with its own rows.
   *
   * Matched by SUBSTRING rather than by whole statement, because the text that
   * reaches the double has been through toPositionalPlaceholders -- the cadence
   * read's `checked_at > ?` arrives as `checked_at > $1`, so an equality test
   * against LANE_CADENCE_SQL would silently fall through to the wrong rows. The
   * three fragments below are each unique to one statement: the stale-run read
   * is the only one selecting `MIN(checked_at) AS since`, the cadence read the
   * only one selecting `COUNT(*) AS n`, and the latest read the only one whose
   * projection is the five verdict columns.
   *
   * `written` collects the INSERTs only. The prune that recordLaneVerdict
   * issues on the way through binds the same lane name, so counting every
   * statement would make "one verdict" read as two. */
  function healthDb(rows: {
    latest?: Record<string, unknown>[];
    runs?: Record<string, unknown>[];
    /** LANE_MAX_GAP_SQL rows: `{ lane, n, max_gap }` (#10723). The alarm reads the
     * MAX gap now, not the mean, so this bucket answers that query's shape. */
    maxGap?: Record<string, unknown>[];
  }) {
    const written: Record<string, unknown>[] = [];
    pg.control.queries.length = 0;
    pg.control.rows = null;
    pg.control.failNext = null;
    pg.control.answers = [
      { match: "MIN(checked_at) AS since", rows: rows.runs ?? [] },
      { match: "COUNT(*) AS n", rows: rows.maxGap ?? [] },
      {
        match: "SELECT lane, verdict, age_ms, detail, checked_at",
        rows: rows.latest ?? [],
      },
    ];
    pg.control.onQuery = (q) => {
      if (q.text.startsWith("INSERT")) {
        written.push({ sql: q.text, values: q.values });
      }
    };
    return { written, env: pgMockEnv() };
  }

  /** Everything the alarm needs from env other than its store. */
  const TOKEN = { GITHUB_TOKEN: "t" };

  test("opens an issue for a lane stale past the threshold, and records its own tick", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "neurons-staleness",
          verdict: "stale",
          age_ms: 4 * HOUR,
          detail: "partial",
          checked_at: NOW - 1000,
        },
      ],
      runs: [{ lane: "neurons-staleness", since: NOW - 28 * HOUR, ticks: 112 }],
      maxGap: [{ lane: "neurons-staleness", n: 100, max_gap: 15 * 60_000 }],
    });
    const github = fakeGitHub();
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.ok, true);
    assert.equal(out.alarming, 1);
    assert.equal(out.opened, 1);
    assert.deepEqual(github.opened, ["neurons-staleness"]);
    // The reader's own verdict, so a reader that stops is itself visible.
    assert.equal(db.written.length, 1);
    assert.deepEqual(db.written[0].values, [
      "lane-alarm",
      "ok",
      null,
      "1 alarming, 0 recovered, 1 lanes",
      NOW,
    ]);
  });

  test("closes the issue once the lane reports ok", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "neurons-staleness",
          verdict: "ok",
          age_ms: 60_000,
          detail: null,
          checked_at: NOW - 1000,
        },
      ],
    });
    const github = fakeGitHub({ "neurons-staleness": 4242 });
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.recovered, 1);
    assert.equal(out.closed, 1);
    assert.deepEqual(github.closed, [4242]);
  });

  test("an unreadable issue list stops the WRITES, and still records every lane", async () => {
    // The single most damaging thing this could do: treat a failed list as
    // "nothing is open" and re-open every outstanding alarm, every tick.
    //
    // The second most damaging is what the fix for that used to do -- return
    // early, and take the per-lane captures with it. The one failure mode
    // where GitHub is unreachable is exactly when the second channel matters,
    // so the writes stop and the recording does not.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const github = fakeGitHub();
    github.listOpen = async () => {
      throw new Error("502 from github");
    };
    const seen: Array<{ errorCode?: string }> = [];
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      {
        github,
        now: () => NOW,
        recordException: async (_env, payload) => {
          seen.push(payload as { errorCode?: string });
          return true;
        },
      },
    );
    assert.equal((out as { reason?: string }).reason, "issue_list_unavailable");
    assert.equal((out as { delivered?: boolean }).delivered, false);
    assert.deepEqual(github.opened, [], "nothing was filed blind");
    // ...and the lane was still reported, on the channel that still worked.
    assert.equal(
      seen.filter((p) => p.errorCode === "lane_stale").length,
      1,
      "the alarming lane was still recorded",
    );
    assert.equal(
      seen.filter((p) => p.errorCode === "alarm_list_unavailable").length,
      1,
      "and the dead list reported itself",
    );
  });

  // The same failure through the door the client used to leave open: a non-2xx
  // LIST. It used to flatten to `{}`, which is "no alarms are open" -- so the
  // guard above could never fire on the case that actually happens, and every
  // tick planned a full set of opens against a token that could not create
  // them.
  test("a REFUSED issue list stops the tick too, not just a thrown one", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const github = fakeGitHub();
    github.listOpen = async () => null;
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github, now: () => NOW },
    );
    assert.equal((out as { reason?: string }).reason, "issue_list_unavailable");
    assert.deepEqual(github.opened, []);
  });

  // THE ALARM'S ONLY PUSH CHANNEL, CHECKED. `opened` was a number in a return
  // value nothing read: a tick that planned alarms and got none of them
  // accepted was indistinguishable from a quiet one, and production sat in
  // exactly that state -- zero `alarm(lane):` issues ever filed, against days
  // of alarming lanes, while the per-lane events kept firing into PostHog.
  test("an alarm GitHub refuses to open is reported, not counted and dropped", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const github = fakeGitHub();
    github.open = async () => null; // GitHub said no -- 403, 422, anything.
    const seen: Array<{ errorCode?: string; error?: Error }> = [];
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      {
        github,
        now: () => NOW,
        recordException: async (_env, payload) => {
          seen.push(payload as { errorCode?: string; error?: Error });
          return true;
        },
      },
    );
    assert.equal((out as { opened?: number }).opened, 0);
    const undelivered = seen.filter((p) => p.errorCode === "alarm_undelivered");
    assert.equal(undelivered.length, 1, "the dead channel reported itself");
    assert.match(String(undelivered[0].error?.message), /delivered nothing/);
    // Under its OWN fingerprint -- filed as a lane it would read as one more
    // stale producer, when it is the watchdog failing to report at all.
    assert.equal(
      (undelivered[0] as { fingerprintDetail?: string }).fingerprintDetail,
      "delivery",
    );
  });

  test("a telemetry failure never fails the tick that found the dead channel", async () => {
    // The one thing worse than an alarm nobody can see is an alarm that takes
    // the watchdog down with it. Both captures on this path are best-effort.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const throwing = async () => {
      throw new Error("posthog down");
    };

    // Both captures on this path, because both are `.catch(() => false)` and a
    // swallowed rejection is only safe if something proves it is swallowed.
    const refused = fakeGitHub();
    refused.open = async () => null;
    const a = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github: refused, now: () => NOW, recordException: throwing },
    );
    assert.equal((a as { ok?: boolean }).ok, true);
    assert.equal((a as { opened?: number }).opened, 0);

    const unlistable = fakeGitHub();
    unlistable.listOpen = async () => null;
    const b = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github: unlistable, now: () => NOW, recordException: throwing },
    );
    assert.equal((b as { ok?: boolean }).ok, true);
    assert.equal((b as { delivered?: boolean }).delivered, false);
  });

  test("a tick that DELIVERS reports nothing extra", async () => {
    // The negative control: the capture above must not fire on a working tick,
    // or it becomes the noise it exists to cut through.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const seen: Array<{ errorCode?: string }> = [];
    await runLaneAlarm(
      { ...TOKEN, ...db.env },
      {
        github: fakeGitHub(),
        now: () => NOW,
        recordException: async (_env, payload) => {
          seen.push(payload as { errorCode?: string });
          return true;
        },
      },
    );
    assert.deepEqual(
      seen.filter((p) => p.errorCode === "alarm_undelivered"),
      [],
    );
  });

  // ITS OWN SECRET, falling back to the shared one. GITHUB_TOKEN is declared as
  // the upgrade radar's public-READ token; opening an issue needs
  // `issues: write` on this repository, and sharing one credential let the
  // weaker requirement set the ceiling.
  test("prefers LANE_ALARM_GITHUB_TOKEN, and falls back to GITHUB_TOKEN", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    /** Every `authorization` header the run sent, for one env. */
    async function authHeaders(
      env: Record<string, unknown>,
    ): Promise<string[]> {
      const seen: string[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        seen.push(
          String((init?.headers as Record<string, string>)?.authorization),
        );
        // An empty issue list, then accept the create.
        return String(url).includes("state=open")
          ? new Response("[]", { status: 200 })
          : new Response(JSON.stringify({ number: 7 }), { status: 201 });
      }) as unknown as typeof fetch;
      await runLaneAlarm(env, { now: () => NOW, fetchImpl });
      return seen;
    }

    const both = await authHeaders({
      GITHUB_TOKEN: "read-only",
      LANE_ALARM_GITHUB_TOKEN: "writer",
      ...db.env,
    });
    assert.ok(both.length > 0, "the run actually called GitHub");
    assert.deepEqual(
      [...new Set(both)],
      ["Bearer writer"],
      "the write-scoped secret wins when both are set",
    );

    const sharedOnly = await authHeaders({
      GITHUB_TOKEN: "read-only",
      ...db.env,
    });
    assert.deepEqual(
      [...new Set(sharedOnly)],
      ["Bearer read-only"],
      "and the shared one still works where it has the scope",
    );
  });

  test("still records the alarm when no token is configured", async () => {
    // Notification degrades to PostHog alone; the tick still runs and the
    // durable verdict still lands.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const seen: unknown[] = [];
    const out = await runLaneAlarm(db.env, {
      now: () => NOW,
      recordException: async (_env, payload) => {
        seen.push(payload);
        return true;
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.delivered, false);
    assert.equal(out.opened, 0);
    assert.equal(seen.length, 1);
  });

  // #10673: every alarm in a tick used to fingerprint `watchdog:lane-alarm:Error`,
  // which is also the storm guard's throttle key — so the first alarming lane
  // consumed the window and the rest were dropped as repeats of it. Measured on
  // production: exactly one event per tick for six consecutive hours while this
  // watchdog's own verdict read "4 alarming". Tagging each capture with its lane
  // is what makes the "recorded for every alarm" claim above true.
  test("tags each capture with its lane, so a tick's alarms do not collapse", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "table-freshness",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
        {
          lane: "metagraph",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [
        { lane: "table-freshness", since: NOW - 28 * HOUR, ticks: 100 },
        { lane: "metagraph", since: NOW - 28 * HOUR, ticks: 100 },
      ],
    });
    const seen: {
      error: unknown;
      route?: string;
      fingerprintDetail?: string;
    }[] = [];
    await runLaneAlarm(db.env, {
      now: () => NOW,
      recordException: async (_env, payload) => {
        seen.push(payload);
        return true;
      },
    });
    assert.equal(seen.length, 2);
    // The route stays the shared one — it mirrors UsageEvent's vocabulary. It is
    // fingerprintDetail that separates the findings.
    assert.deepEqual(
      seen.map((payload) => payload.route),
      ["watchdog:lane-alarm", "watchdog:lane-alarm"],
    );
    assert.deepEqual(
      [...seen.map((payload) => payload.fingerprintDetail)].sort(),
      ["metagraph", "table-freshness"],
    );
    // Each detail equals the lane named in its own message, so a capture can
    // never be attributed to the wrong lane.
    for (const payload of seen) {
      assert.match(
        String((payload.error as Error).message),
        new RegExp(`^lane ${payload.fingerprintDetail} is `),
      );
    }
  });

  test("counts a rejected create as not opened", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const github = fakeGitHub();
    github.open = async () => {
      throw new Error("rate limited");
    };
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.alarming, 1);
    assert.equal(out.opened, 0);
  });

  test("counts a rejected close as not closed", async () => {
    const db = healthDb({
      latest: [
        { lane: "a", verdict: "ok", age_ms: 1, detail: null, checked_at: NOW },
      ],
    });
    const github = fakeGitHub({ a: 5 });
    github.close = async () => {
      throw new Error("rate limited");
    };
    const out = await runLaneAlarm(
      { ...TOKEN, ...db.env },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.recovered, 1);
    assert.equal(out.closed, 0);
  });

  test("honours an overridden threshold and repo", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 90 * 60_000, ticks: 6 }],
    });
    const calls: string[] = [];
    const out = await runLaneAlarm(
      {
        GITHUB_TOKEN: "t",
        LANE_ALARM_REPO: "o/other",
        LANE_ALARM_MIN_STALE_MS: 2 * HOUR,
        ...db.env,
      },
      {
        now: () => NOW,
        recordException: async () => true,
        fetchImpl: (async (url: string) => {
          calls.push(String(url));
          return { ok: true, json: async () => [] };
        }) as unknown as typeof fetch,
      },
    );
    // 90 minutes is under the overridden 2-hour threshold.
    assert.equal(out.alarming, 0);
    assert.match(calls[0], /\/repos\/o\/other\/issues/);
  });

  test("builds its own GitHub client from the ambient fetch when given none", async () => {
    // The wiring the cron actually uses: no deps at all beyond the clock.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "ok",
          age_ms: 1,
          detail: null,
          checked_at: NOW - 40 * HOUR,
        },
      ],
      maxGap: [{ lane: "a", n: 50, max_gap: 12 * 60_000 }],
    });
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => (calls.length === 1 ? [] : { number: 7 }),
      };
    }) as unknown as typeof fetch;
    try {
      const out = await runLaneAlarm(
        { ...TOKEN, ...db.env },
        { now: () => NOW, recordException: async () => true },
      );
      // Silent, not stale -- so this also exercises the `lane_silent` code.
      assert.equal(out.alarming, 1);
      assert.equal(out.opened, 1);
    } finally {
      globalThis.fetch = original;
    }
    assert.match(
      calls[0],
      /\/repos\/JSONbored\/metagraphed\/issues\?state=open/,
    );
  });

  test("reports a missing binding rather than throwing", async () => {
    assert.deepEqual(await runLaneAlarm({}), {
      ok: false,
      reason: "no lane_health store bound",
    });
    assert.deepEqual(await runLaneAlarm(null), {
      ok: false,
      reason: "no lane_health store bound",
    });
  });

  test("survives a telemetry sink that rejects", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const out = await runLaneAlarm(db.env, {
      now: () => NOW,
      recordException: async () => {
        throw new Error("posthog is down");
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.alarming, 1);
  });
});

describe("laneAlarmTitle", () => {
  test("is the dedup key, and is stable across ticks", () => {
    assert.equal(
      laneAlarmTitle("neurons-staleness"),
      `${LANE_ALARM_TITLE_PREFIX}neurons-staleness`,
    );
  });
});

describe("the summary a capture carries (#10809)", () => {
  const NOW = 1_760_000_000_000;
  const staleFor = (hours: number, cadenceMs: number | null) => ({
    lane: "neon:validator-nominator-counts",
    kind: "stale" as const,
    since: NOW - hours * 3_600_000,
    ticks: 1,
    detail: "1 statement(s) flushed, 1 failed",
    age_ms: null,
    cadence_ms: cadenceMs,
  });

  test("a stale duration is stated against the cadence that makes it readable", () => {
    // Measured on production 2026-08-11: this lane's figure climbed 1h per hour
    // from 1.4h to 7.9h while NOTHING new failed -- a stale verdict simply ages
    // until the next pass overwrites it. Its producer runs every 24 hours, so
    // 7.9h is a third of one cycle after a single failed flush. The bare
    // duration read as eight hours of a worsening outage, and it was not.
    const summary = laneAlarmSummary(staleFor(7.9, 86_400_000), NOW);
    assert.match(summary, /is stale: /);
    assert.match(
      summary,
      /producer cadence 24\.0h/,
      `the duration needs its unit: ${summary}`,
    );
  });

  test("an uncalibrated lane says only what it measured", () => {
    // No declared producer and too little history to estimate one: inventing a
    // cadence here would be exactly the false precision the alarm's own
    // LANE_ALARM_MIN_CADENCE_SAMPLES rule refuses.
    const summary = laneAlarmSummary(staleFor(7.9, null), NOW);
    assert.match(summary, /is stale: /);
    assert.doesNotMatch(summary, /cadence/);
  });

  test("a dead-letter lane names WHAT was lost, not a cadence", () => {
    // `lane revenue-probes-dlq is stale: 41.0h (producer cadence 1.0h)` reads
    // as forty-one missed cycles and is not that: a DLQ writes `stale` when a
    // message is lost and never writes `ok`, so the duration is "how long ago
    // something was lost and nobody looked". Measured 2026-08-12, that reading
    // worked -- it was triaged as the most urgent lane in the fleet, ahead of
    // six that were genuinely silent.
    const summary = laneAlarmSummary(
      {
        ...staleFor(41, 3_600_000),
        lane: "revenue-probes-dlq",
        detail: "2 dead-lettered message(s) on revenue-probes-dlq (sn-64-x)",
      },
      NOW,
    );
    assert.doesNotMatch(
      summary,
      /cadence/,
      `a DLQ duration is not cycles-behind: ${summary}`,
    );
    assert.match(
      summary,
      /sn-64-x/,
      "the subject IS the diagnosis, and the alarm has been carrying it unread",
    );
  });

  test("a dead-letter lane with no detail still says what it can", () => {
    const summary = laneAlarmSummary(
      { ...staleFor(41, 3_600_000), lane: "revenue-probes-dlq", detail: null },
      NOW,
    );
    assert.match(summary, /lane revenue-probes-dlq is stale: 41\.0h/);
    assert.doesNotMatch(summary, /cadence/);
  });

  test("a producer lane is unaffected by the dead-letter branch", () => {
    // Guards the guard: if the DLQ check widened to every lane, the cadence
    // that #10809 added would silently vanish from the alarms that need it.
    assert.match(
      laneAlarmSummary(staleFor(7.9, 86_400_000), NOW),
      /producer cadence 24\.0h/,
    );
  });

  test("silence is left alone -- its bound already IS the cadence", () => {
    const summary = laneAlarmSummary(
      { ...staleFor(4, 86_400_000), kind: "silent" as const },
      NOW,
    );
    assert.match(summary, /is silent: /);
    assert.doesNotMatch(summary, /cadence/);
  });
});
