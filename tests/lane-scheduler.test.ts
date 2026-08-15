// #10709: lanes run on a declared cadence, not on whichever minute was free.
//
// The thing under test gates 39 producers. Every assertion here is written from
// the same premise: the expensive failure is a lane that silently STOPS, so the
// tests care much more about "does an uncertain input still run" than about
// "does a due lane run on the exact millisecond".
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  LANE_DUE_TOLERANCE_MS,
  lanesDue,
  lastRunFromLaneHealth,
  type ScheduledLane,
} from "../src/lane-scheduler.ts";
import {
  LANE_HEARTBEAT_CRON,
  LANE_HEARTBEAT_CRONS,
  LANE_HEARTBEAT_EXTRA_CRON,
} from "../workers/config.ts";
import { LANE_PRODUCERS } from "../workers/api.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

const hourly: ScheduledLane[] = [{ name: "a", everyMinutes: 60 }];
const names = (lanes: readonly ScheduledLane[]) => lanes.map((l) => l.name);

describe("lanesDue — the steady state", () => {
  test("a lane that just ran is not due again", () => {
    assert.deepEqual(names(lanesDue(hourly, { a: NOW - 60_000 }, NOW)), []);
  });

  test("a lane whose cadence has elapsed is due", () => {
    assert.deepEqual(names(lanesDue(hourly, { a: NOW - HOUR_MS }, NOW)), ["a"]);
  });

  test("lanes are filtered independently, not all-or-nothing", () => {
    // The point of a registry is that one lane being due says nothing about
    // another. A gate that ran all-or-none would reintroduce the coupling the
    // shared heartbeat had before cadences existed.
    const lanes: ScheduledLane[] = [
      { name: "hourly", everyMinutes: 60 },
      { name: "daily", everyMinutes: 1440 },
    ];
    const lastRun = { hourly: NOW - HOUR_MS, daily: NOW - HOUR_MS };
    assert.deepEqual(names(lanesDue(lanes, lastRun, NOW)), ["hourly"]);
  });

  test("an empty registry yields nothing rather than throwing", () => {
    assert.deepEqual(lanesDue([], {}, NOW), []);
  });
});

describe("lanesDue — tolerance, and why it is not zero", () => {
  // WITHOUT tolerance an hourly lane silently becomes two-hourly: cron delivery
  // is not to-the-millisecond, so an elapsed of 59m57s fails a strict >= 60min
  // and the next tick is a full interval away. This is the regression test for
  // that, and it is the reason LANE_DUE_TOLERANCE_MS exists at all.
  test("a lane arriving a few seconds early still runs", () => {
    const lastRun = { a: NOW - (HOUR_MS - 3_000) };
    assert.deepEqual(names(lanesDue(hourly, lastRun, NOW)), ["a"]);
  });

  test("exactly at the tolerance boundary is due", () => {
    const lastRun = { a: NOW - (HOUR_MS - LANE_DUE_TOLERANCE_MS) };
    assert.deepEqual(names(lanesDue(hourly, lastRun, NOW)), ["a"]);
  });

  test("one millisecond inside the boundary is NOT due", () => {
    // The other side of the same boundary. Without this, a tolerance of
    // `everyMinutes` would pass every test above and gate nothing.
    const lastRun = { a: NOW - (HOUR_MS - LANE_DUE_TOLERANCE_MS - 1) };
    assert.deepEqual(names(lanesDue(hourly, lastRun, NOW)), []);
  });

  test("tolerance is smaller than the smallest gap between two ticks", () => {
    // A tolerance wider than the gap between two ticks lets a lane come due on
    // both of them and run twice. Derived from the registered expressions
    // rather than restated, so widening the grid cannot quietly invalidate it.
    const minutes = LANE_HEARTBEAT_CRONS.flatMap((cron) =>
      cron.split(/\s+/)[0].split(",").map(Number),
    ).sort((a, b) => a - b);
    assert.ok(minutes.length >= 2, "expected a multi-tick grid");
    let smallestGap = 60 - minutes[minutes.length - 1] + minutes[0];
    for (let i = 1; i < minutes.length; i += 1) {
      smallestGap = Math.min(smallestGap, minutes[i] - minutes[i - 1]);
    }
    assert.ok(
      LANE_DUE_TOLERANCE_MS < smallestGap * 60 * 1000,
      `tolerance ${LANE_DUE_TOLERANCE_MS}ms is not below the ${smallestGap}min gap`,
    );
  });
});

describe("lanesDue — every uncertain input resolves to RUNNING", () => {
  // This block is the safety argument. A gate in front of 39 producers must
  // fail toward running: an extra enqueue costs one queue message, a missed one
  // is the silent stop #10566, #10680 and #10548 all turned out to be.
  test("a lane with no last-run entry runs", () => {
    assert.deepEqual(names(lanesDue(hourly, {}, NOW)), ["a"]);
  });

  test("an explicit null or undefined last-run runs", () => {
    assert.deepEqual(names(lanesDue(hourly, { a: null }, NOW)), ["a"]);
    assert.deepEqual(names(lanesDue(hourly, { a: undefined }, NOW)), ["a"]);
  });

  test("a zero last-run runs rather than reading as the epoch", () => {
    // lane_health reads checked_at through `safeIntOrNull(...) ?? 0`, so an
    // unparseable stamp arrives as a real 0, not as absent.
    assert.deepEqual(names(lanesDue(hourly, { a: 0 }, NOW)), ["a"]);
  });

  test("a NaN last-run runs", () => {
    assert.deepEqual(names(lanesDue(hourly, { a: NaN }, NOW)), ["a"]);
  });

  test("a FUTURE last-run runs instead of stalling until time catches up", () => {
    // Clock skew or a bad row. Under a strict comparison a stamp an hour in the
    // future would park the lane for an hour with no error anywhere.
    assert.deepEqual(names(lanesDue(hourly, { a: NOW + HOUR_MS }, NOW)), ["a"]);
  });

  test("a lane with a missing or nonsensical cadence runs every tick", () => {
    const broken = [
      { name: "a", everyMinutes: 0 },
      { name: "b", everyMinutes: -5 },
      { name: "c" } as ScheduledLane,
    ];
    const lastRun = { a: NOW - 1, b: NOW - 1, c: NOW - 1 };
    assert.deepEqual(names(lanesDue(broken, lastRun, NOW)), ["a", "b", "c"]);
  });

  test("a non-finite now runs everything", () => {
    // Nothing can be decided without a clock, so the answer is "run", and the
    // returned array is a copy rather than the caller's own registry.
    const out = lanesDue(hourly, { a: NOW }, Number.NaN);
    assert.deepEqual(names(out), ["a"]);
    assert.notEqual(out, hourly);
  });

  test("a lane name that matches no health row runs", () => {
    // A renamed lane reads as never-run, so it runs too often rather than never
    // — the loud direction for a typo.
    assert.deepEqual(names(lanesDue(hourly, { different: NOW }, NOW)), ["a"]);
  });
});

describe("lastRunFromLaneHealth — omit rather than default", () => {
  test("a usable stamp is carried through", () => {
    const out = lastRunFromLaneHealth({ a: { checked_at: NOW } });
    assert.deepEqual(out, { a: NOW });
  });

  test("every unusable stamp is OMITTED, so the lane reads as never-run", () => {
    // Omitted rather than zeroed. Both make `lanesDue` return the lane, but a 0
    // says it by accident of arithmetic and would survive a later change to the
    // comparison; an absent key says it on purpose.
    const out = lastRunFromLaneHealth({
      zero: { checked_at: 0 },
      negative: { checked_at: -1 },
      nan: { checked_at: Number.NaN },
      nullish: { checked_at: null },
      missing: {},
      nullRecord: null,
      undefinedRecord: undefined,
    });
    assert.deepEqual(out, {});
  });

  test("an empty or nullish snapshot yields an empty map", () => {
    // loadLatestLaneHealth returns {} on ANY store failure, so this is the
    // degraded path: no stamps, every lane due, pre-#10709 behaviour.
    assert.deepEqual(lastRunFromLaneHealth({}), {});
    assert.deepEqual(
      lastRunFromLaneHealth(
        undefined as unknown as Record<string, { checked_at?: number }>,
      ),
      {},
    );
  });

  test("a failed lane-health read runs every lane, never none", () => {
    // The composed property, and the one that matters: a broken store must
    // degrade to running everything. The opposite polarity would let one failed
    // query silently stop all four producers.
    const lastRun = lastRunFromLaneHealth({});
    assert.deepEqual(names(lanesDue(LANE_PRODUCERS, lastRun, NOW)), [
      ...LANE_PRODUCERS.map((l) => l.name),
    ]);
  });
});

describe("the registry — every lane keeps a path to run", () => {
  // #10709's own acceptance criterion: a gate proving every registered lane is
  // still reachable, and that the set has not shrunk.
  test("every registered producer declares a usable cadence", () => {
    for (const lane of LANE_PRODUCERS) {
      assert.ok(lane.name, "a producer has no name");
      assert.equal(
        typeof lane.everyMinutes,
        "number",
        `${lane.name} has no everyMinutes`,
      );
      assert.ok(
        Number.isFinite(lane.everyMinutes) && lane.everyMinutes > 0,
        `${lane.name} has a nonsensical cadence`,
      );
      assert.equal(typeof lane.enqueue, "function");
    }
  });

  test("the registry has not shrunk", () => {
    // Named rather than counted: a count passes when one lane is swapped for
    // another, which is the migration mistake worth catching.
    assert.deepEqual(
      [...LANE_PRODUCERS.map((l) => l.name)].sort(),
      [
        "attribution-sweep",
        "compute-declarations",
        "origin-reachability",
        "revenue-probe",
      ],
      "a lane left LANE_PRODUCERS — it now has no clock at all",
    );
  });

  test("no lane declares a cadence finer than the grid can deliver", () => {
    // Declaring 5 minutes against a grid whose tightest gap is 9 does not make
    // a 5-minute lane; it makes a lane that runs every tick while reading as
    // though it were faster. Caught here rather than discovered in a dashboard.
    const minutes = LANE_HEARTBEAT_CRONS.flatMap((cron) =>
      cron.split(/\s+/)[0].split(",").map(Number),
    ).sort((a, b) => a - b);
    let smallestGap = 60 - minutes[minutes.length - 1] + minutes[0];
    for (let i = 1; i < minutes.length; i += 1) {
      smallestGap = Math.min(smallestGap, minutes[i] - minutes[i - 1]);
    }
    for (const lane of LANE_PRODUCERS) {
      assert.ok(
        lane.everyMinutes >= smallestGap,
        `${lane.name} wants ${lane.everyMinutes}min, finer than the ${smallestGap}min grid`,
      );
    }
  });

  test("every lane is reachable from a tick within its own cadence", () => {
    // The end-to-end property, replayed against the real grid: step a whole day
    // of ticks and assert each lane actually comes up. A cadence nothing can
    // satisfy is a lane that never runs, which is the failure being removed.
    const ticks: number[] = [];
    const minutes = LANE_HEARTBEAT_CRONS.flatMap((cron) =>
      cron.split(/\s+/)[0].split(",").map(Number),
    ).sort((a, b) => a - b);
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of minutes) {
        ticks.push(NOW + hour * HOUR_MS + minute * 60_000);
      }
    }
    const lastRun: Record<string, number> = {};
    const runs: Record<string, number> = {};
    for (const tick of ticks) {
      for (const lane of lanesDue(LANE_PRODUCERS, lastRun, tick)) {
        lastRun[lane.name] = tick;
        runs[lane.name] = (runs[lane.name] ?? 0) + 1;
      }
    }
    for (const lane of LANE_PRODUCERS) {
      // Hourly lanes over 24h of ticks: at least 20 runs, and never once per
      // tick (which would mean the gate is not gating).
      assert.ok(
        (runs[lane.name] ?? 0) >= 20,
        `${lane.name} ran only ${runs[lane.name] ?? 0} times in a day`,
      );
      assert.ok(
        (runs[lane.name] ?? 0) < ticks.length,
        `${lane.name} ran on every tick — the cadence gate is not gating`,
      );
    }
  });
});

describe("the wiring — the grid is registered and dispatch matches all of it", () => {
  test("every heartbeat expression is a registered trigger", async () => {
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    for (const cron of LANE_HEARTBEAT_CRONS) {
      assert.ok(
        wrangler.includes(`"${cron}"`),
        `${cron} is not in wrangler.jsonc triggers.crons — it will never fire`,
      );
    }
  });

  test("the original expression is still in the set", () => {
    // The migration's whole safety property: minute 26 is the expression the
    // account already has registered, so code deployed before a triggers deploy
    // still runs the heartbeat. Removing it from this set is what would create
    // the silent window.
    assert.ok(LANE_HEARTBEAT_CRONS.includes(LANE_HEARTBEAT_CRON));
    assert.equal(LANE_HEARTBEAT_CRON, "26 * * * *");
    assert.ok(LANE_HEARTBEAT_CRONS.includes(LANE_HEARTBEAT_EXTRA_CRON));
  });

  test("the expressions are distinct and share no minute", () => {
    // Two heartbeat expressions firing in the same minute would run the lanes
    // twice concurrently. Distinctness is also what the literal-string dispatch
    // requires of every registered cron.
    assert.equal(
      new Set(LANE_HEARTBEAT_CRONS).size,
      LANE_HEARTBEAT_CRONS.length,
    );
    const minutes = LANE_HEARTBEAT_CRONS.flatMap((cron) =>
      cron.split(/\s+/)[0].split(","),
    );
    assert.equal(new Set(minutes).size, minutes.length);
  });

  test("dispatch tests membership rather than equality", async () => {
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /if \(LANE_HEARTBEAT_CRONS\.includes\(cron\)\) \{/);
    // The old shape, explicitly. An equality check against one constant would
    // silently ignore every other expression on the grid.
    assert.doesNotMatch(api, /if \(cron === LANE_HEARTBEAT_CRON\) \{/);
  });
});
