import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  runDueStalenessWatchdogs,
  type StalenessWatchdogLane,
} from "../src/staleness-watchdog-heartbeat.ts";

/** A lane that records every env it was run with. */
function lane(
  name: string,
  everyMinutes: number,
  run: (env: string) => Promise<Record<string, unknown>> = async () => ({}),
): StalenessWatchdogLane<string> {
  return { name, everyMinutes, run };
}

const MINUTE = 60_000;

describe("runDueStalenessWatchdogs", () => {
  test("runs every lane when none has ever run", async () => {
    const calls: string[] = [];
    const tick = await runDueStalenessWatchdogs(
      [
        lane("a", 15, async () => (calls.push("a"), {})),
        lane("b", 60, async () => (calls.push("b"), {})),
      ],
      "env",
      { lastRunMs: {}, now: () => 1_000_000 },
    );
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(tick.ok, true);
    assert.equal(tick.skipped, 0);
  });

  // THE REGRESSION TEST. Eight watchdogs gave up their own cron minutes for
  // this heartbeat, and the only thing they sold in exchange was detection
  // latency. Simulated over the quarter-hourly grid, each cadence must come out
  // at exactly the rate its old cron ran at: 15m -> 4/hour, 30m -> 2, 60m -> 1.
  test("reproduces 15/30/60-minute cadences EXACTLY over an hour", async () => {
    const ranAt: Record<string, number[]> = { q: [], h: [], hr: [] };
    const lanes = [
      lane("q", 15, async () => ({})),
      lane("h", 30, async () => ({})),
      lane("hr", 60, async () => ({})),
    ];
    const lastRun: Record<string, number> = {};
    // Ticks at :06, :21, :36, :51 -- the grid the heartbeat claims.
    const start = 6 * MINUTE;
    // Five ticks: the first seeds last-run, the next four are the hour measured.
    for (let i = 0; i < 5; i += 1) {
      const now = start + i * 15 * MINUTE;
      const tick = await runDueStalenessWatchdogs(lanes, "env", {
        lastRunMs: lastRun,
        now: () => now,
      });
      for (const outcome of tick.ran) {
        lastRun[outcome.lane] = now;
        if (i > 0) ranAt[outcome.lane]!.push(now);
      }
    }
    assert.equal(ranAt.q!.length, 4, "a 15-minute lane runs 4x an hour");
    assert.equal(ranAt.h!.length, 2, "a 30-minute lane runs 2x an hour");
    assert.equal(ranAt.hr!.length, 1, "a 60-minute lane runs 1x an hour");
  });

  test("a lane that is not due is skipped, and counted as skipped", async () => {
    const calls: string[] = [];
    const now = 10 * 60 * MINUTE;
    const tick = await runDueStalenessWatchdogs(
      [
        lane("fresh", 60, async () => (calls.push("fresh"), {})),
        lane("stale", 15, async () => (calls.push("stale"), {})),
      ],
      "env",
      {
        // `fresh` ran a minute ago; `stale` ran an hour ago.
        lastRunMs: { fresh: now - MINUTE, stale: now - 60 * MINUTE },
        now: () => now,
      },
    );
    assert.deepEqual(calls, ["stale"]);
    assert.equal(tick.skipped, 1);
    assert.equal(tick.ran.length, 1);
  });
});

// The property the module exists for. Eight alarms behind one trigger makes
// "one lane's failure silences another's alarm" eight times cheaper to hit, and
// #9228 already paid for that lesson once in this codebase.
describe("one lane's failure cannot silence another's alarm", () => {
  test("a THROWING lane does not stop the lanes after it", async () => {
    const calls: string[] = [];
    const tick = await runDueStalenessWatchdogs(
      [
        lane("first", 15, async () => (calls.push("first"), {})),
        lane("boom", 15, async () => {
          calls.push("boom");
          throw new Error("neon said no");
        }),
        lane("last", 15, async () => (calls.push("last"), {})),
      ],
      "env",
      { lastRunMs: {}, now: () => 1_000_000 },
    );
    assert.deepEqual(calls, ["first", "boom", "last"], "all three were run");
    assert.equal(tick.ok, false, "the tick is not ok");
    assert.deepEqual(
      tick.ran.map((r) => [r.lane, r.ok]),
      [
        ["first", true],
        ["boom", false],
        ["last", true],
      ],
      "the failure is attributed to the lane that threw, and only to it",
    );
    assert.equal(tick.ran[1]!.error, "neon said no");
  });

  test("a lane that throws is reported, never marked healthy", async () => {
    // It writes no verdict, so its lane_health.checked_at freezes and the
    // existing alarm reports it stale. Recording a verdict here would refresh
    // that stamp and make a permanently broken watchdog look recently checked.
    const tick = await runDueStalenessWatchdogs(
      [
        lane("boom", 15, async () => {
          throw new Error("down");
        }),
      ],
      "env",
      { lastRunMs: {}, now: () => 1_000_000 },
    );
    assert.equal(tick.ok, false);
    assert.equal(tick.ran[0]!.ok, false);
  });

  test("a non-Error throw is still attributed, not swallowed", async () => {
    const tick = await runDueStalenessWatchdogs(
      [
        lane("odd", 15, async () => {
          throw "a string";
        }),
      ],
      "env",
      { lastRunMs: {}, now: () => 1_000_000 },
    );
    assert.equal(tick.ran[0]!.error, "a string");
    assert.equal(tick.ok, false);
  });

  test("lanes run SEQUENTIALLY, not concurrently", async () => {
    // Eight MAX() queries at once is eight pooled Neon connections for no gain.
    // Overlap is what this asserts against: a concurrent implementation would
    // interleave the enter/exit markers.
    const order: string[] = [];
    const slow = (name: string) =>
      lane(name, 15, async () => {
        order.push(`${name}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(`${name}:exit`);
        return {};
      });
    await runDueStalenessWatchdogs([slow("a"), slow("b")], "env", {
      lastRunMs: {},
      now: () => 1_000_000,
    });
    assert.deepEqual(order, ["a:enter", "a:exit", "b:enter", "b:exit"]);
  });
});

describe("runDueStalenessWatchdogs — the shapes a tick can arrive in", () => {
  test("an empty registry is an ok, idle tick", async () => {
    const tick = await runDueStalenessWatchdogs([], "env", {
      now: () => 1_000_000,
    });
    assert.deepEqual(tick, { ok: true, ran: [], skipped: 0 });
  });

  test("a tick with nothing DUE is ok, not a failure", async () => {
    const now = 10 * 60 * MINUTE;
    const tick = await runDueStalenessWatchdogs([lane("a", 60)], "env", {
      lastRunMs: { a: now - MINUTE },
      now: () => now,
    });
    assert.equal(tick.ok, true, "idle is healthy");
    assert.equal(tick.skipped, 1);
    assert.deepEqual(tick.ran, []);
  });

  test("no deps at all still runs — the gate defaults to running", async () => {
    // Omitting lastRunMs means every lane reads as never-run. Same polarity as
    // lanesDue: uncertainty resolves to running, because not running is the
    // failure this family exists to remove.
    const calls: string[] = [];
    const tick = await runDueStalenessWatchdogs(
      [lane("a", 60, async () => (calls.push("a"), {}))],
      "env",
    );
    assert.deepEqual(calls, ["a"]);
    assert.equal(tick.ok, true);
  });
});
