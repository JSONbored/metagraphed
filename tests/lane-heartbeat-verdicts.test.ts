// The lane heartbeat's own reporting (#10777).
//
// LANE_PRODUCERS computed exactly the right per-lane object and handed it to
// handleScheduled, whose return value workers/api.entry.ts DISCARDS -- the same
// #9440 shape the SafeMode watchdog had, reintroduced by the three lanes that
// moved onto this heartbeat (#10715) and lost their own verdict writes on the
// way.
//
// Measured 2026-08-11: `revenue-probe` read `unknown -- no verdict for 194m
// (cadence ~60m)` on /api/v1/self-health while the heartbeat had been running
// on schedule every hour, because "ran and could not enqueue" and "never ran"
// produce the same nothing.
//
// Its own file, with the pg module mocked, because laneHealthStore builds a
// real client from HYPERDRIVE and the module is the only seam handleScheduled
// exposes for it -- see tests/helpers/pg-mock.ts.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { pgMockEnv } from "./helpers/pg-mock.ts";
import {
  LANE_PRODUCERS,
  handleScheduled,
  laneHeartbeatVerdict,
} from "../workers/api.ts";
import { LANE_HEARTBEAT_CRON } from "../workers/config.ts";

/** The lanes the heartbeat declares, which every tick must account for. */
const LANE_NAMES = LANE_PRODUCERS.map((l) => l.name);

/** One heartbeat tick, returning the lane_health statements it wrote. */
async function runTick() {
  pg.control.queries.length = 0;
  const waits: Promise<unknown>[] = [];
  await handleScheduled(
    { cron: LANE_HEARTBEAT_CRON } as never,
    pgMockEnv(["lane_health"]) as never,
    { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never,
  );
  // The verdicts go through waitUntil, so a test that did not await them would
  // assert on an empty list and pass for the wrong reason.
  await Promise.allSettled(waits);
  return pg.control.queries.filter((q) => /lane_health/i.test(q.text));
}

describe("the heartbeat records a verdict per producer", () => {
  test("a failing producer is RECORDED, not merely returned", async () => {
    // With no queue bindings every lane declines. Before this that produced no
    // row anywhere and the lane read `unknown` forever -- indistinguishable
    // from a cron that had stopped firing.
    const written = await runTick();
    assert.ok(
      written.length > 0,
      "the heartbeat wrote no lane_health row at all -- returning a verdict " +
        "is not reporting one, which is the whole of #10777",
    );
  });

  test("every declared producer gets its own row", async () => {
    // One row for the heartbeat would collapse `no_eligible_surfaces` on the
    // revenue lane and a missing binding on the sweep lane into "the heartbeat
    // is unhappy", which sends a reader to the wrong place.
    const written = await runTick();
    const seen = new Set(
      written.flatMap((q) =>
        q.values.filter(
          (v): v is string => typeof v === "string" && LANE_NAMES.includes(v),
        ),
      ),
    );
    assert.deepEqual(
      [...seen].sort(),
      [...LANE_NAMES].sort(),
      "a producer with no verdict is one nobody can tell apart from a " +
        "producer that never ran",
    );
  });

  test("the producer's own reason is carried into the verdict", async () => {
    const written = await runTick();
    const flat = JSON.stringify(written.map((q) => q.values));
    assert.match(
      flat,
      /no_queue_binding/,
      "the detail must say WHY, or the row is only a timestamp",
    );
  });

  test("the verdict is stale, never ok, when a producer declined", async () => {
    // An `ok` here would publish a working lane on the public self-health card
    // while nothing was enqueued.
    const written = await runTick();
    const flat = JSON.stringify(written.map((q) => q.values));
    assert.match(flat, /stale/);
  });
});

describe("laneHeartbeatVerdict, the rule alone", () => {
  test("a producer that enqueued reports ok and its count", () => {
    assert.deepEqual(
      laneHeartbeatVerdict({ lane: "revenue-probe", ok: true, enqueued: 42 }),
      {
        lane: "revenue-probe",
        verdict: "ok",
        age_ms: null,
        detail: "42 enqueued",
      },
    );
  });

  test("a producer that declined reports stale and its own words", () => {
    assert.deepEqual(
      laneHeartbeatVerdict({
        lane: "revenue-probe",
        ok: false,
        enqueued: 0,
        reason: "no_eligible_surfaces",
      }),
      {
        lane: "revenue-probe",
        verdict: "stale",
        age_ms: null,
        detail: "no_eligible_surfaces",
      },
    );
  });

  test("a partial send keeps BOTH the reason and the count it managed", () => {
    // enqueueAll reports partial sends as partial. A verdict that dropped the
    // reason would make "the queue rejected half of these" look like a clean
    // pass over a smaller set.
    const v = laneHeartbeatVerdict({
      lane: "origin-reachability",
      ok: false,
      enqueued: 50,
      reason: "send_failed: over quota",
    });
    assert.equal(v.verdict, "stale");
    assert.match(v.detail, /send_failed: over quota/);
  });

  test("a declining producer with no reason still reports something", () => {
    // Defensive rather than reachable today: every enqueueAll failure sets a
    // reason. A verdict with an empty detail would be a timestamp pretending
    // to be a report.
    const v = laneHeartbeatVerdict({
      lane: "attribution-sweep",
      ok: false,
      enqueued: 0,
    });
    assert.equal(v.verdict, "stale");
    assert.equal(v.detail, "0 enqueued");
  });

  test("age_ms is null, never a number", () => {
    // Nothing here is behind; something here either enqueued or did not. A
    // number would be read as lag by every consumer of lane_health.
    for (const ok of [true, false]) {
      assert.equal(
        laneHeartbeatVerdict({ lane: "x", ok, enqueued: 1, reason: "r" })
          .age_ms,
        null,
      );
    }
  });
});

describe("heartbeat producer exception isolation", () => {
  for (const failure of [
    new Error("artifact rejected: token=private-fixture"),
    "artifact rejected: token=private-fixture",
  ]) {
    test(`records every lane when a producer throws ${String(failure)}`, async () => {
      const failedLane = LANE_PRODUCERS[1];
      const spies = LANE_PRODUCERS.map((lane) =>
        vi.spyOn(lane, "enqueue").mockImplementation(async () => {
          if (lane === failedLane) throw failure;
          // Settle after the rejection so the test catches fail-fast reporting.
          await Promise.resolve();
          return { ok: true, enqueued: 128 };
        }),
      );
      pg.control.queries.length = 0;
      const waits: Promise<unknown>[] = [];
      try {
        await assert.rejects(
          handleScheduled(
            { cron: LANE_HEARTBEAT_CRON } as never,
            pgMockEnv(["lane_health"]) as never,
            { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never,
          ),
          (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [failure]);
            return true;
          },
        );
        await Promise.allSettled(waits);
        const written = pg.control.queries.filter((q) =>
          /INSERT INTO lane_health/i.test(q.text),
        );
        for (const lane of LANE_PRODUCERS) {
          const row = written.find((q) => q.values.includes(lane.name));
          assert.ok(row, `missing verdict for ${lane.name}`);
          assert.ok(row.values.includes(lane === failedLane ? "stale" : "ok"));
          assert.ok(
            row.values.includes(
              lane === failedLane
                ? "enqueue_threw"
                : "128 enqueued",
            ),
          );
        }
        assert.doesNotMatch(JSON.stringify(written), /private-fixture/);
        for (const spy of spies) assert.equal(spy.mock.calls.length, 1);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  }
});

test("heartbeat waits for a pending sibling and preserves multiple exceptions", async () => {
  const failures = [
    new Error("first fixture failure"),
    new Error("second fixture failure"),
  ];
  let release!: () => void;
  let signalEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const spies = LANE_PRODUCERS.map((lane, index) =>
    vi.spyOn(lane, "enqueue").mockImplementation(async () => {
      if (index < failures.length) throw failures[index];
      if (index === LANE_PRODUCERS.length - 1) {
        signalEntered();
        await gate;
      }
      return { ok: true, enqueued: 128 };
    }),
  );
  pg.control.queries.length = 0;
  const waits: Promise<unknown>[] = [];
  let settled = false;
  const tick = handleScheduled(
    { cron: LANE_HEARTBEAT_CRON } as never,
    pgMockEnv(["lane_health"]) as never,
    { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never,
  ).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await entered;
    // Allow a fail-fast Promise.all rejection to reach handleScheduled.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(
      settled,
      false,
      "tick rejected before its pending sibling settled",
    );
    release();
    const error = await tick;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    await Promise.allSettled(waits);
    const written = pg.control.queries.filter((q) =>
      /INSERT INTO lane_health/i.test(q.text),
    );
    assert.equal(written.length, LANE_PRODUCERS.length);
    const lastLane = LANE_PRODUCERS[LANE_PRODUCERS.length - 1];
    assert.ok(
      written.some(
        (q) => q.values.includes(lastLane.name) && q.values.includes("ok"),
      ),
    );
  } finally {
    release();
    await tick;
    await Promise.allSettled(waits);
    for (const spy of spies) spy.mockRestore();
  }
});
