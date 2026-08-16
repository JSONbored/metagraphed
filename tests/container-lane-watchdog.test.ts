// The alarm for the five lanes running inside metagraphed-infra's decode
// container. Every assertion here is about a distinction the 2026-08-16
// incident proved this repo could not draw: the account-summary projection was
// dead for 32 hours while `lane_health` held not one stale row for it, but NO
// row at all.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CONTAINER_LANES,
  CONTAINER_LANE_THRESHOLD_MS,
  CONTAINER_MISSED_PASSES,
  CONTAINER_PASS_INTERVAL_MS,
  LANE_DETAIL_MAX,
  evaluateContainerLanes,
  laneFailureDetail,
  runContainerLaneWatchdog,
} from "../src/container-lane-watchdog.ts";

const NOW = Date.parse("2026-08-16T14:36:00.000Z");
const FRESH = "2026-08-16T14:26:18Z";

describe("evaluateContainerLanes", () => {
  test("replays the incident: one dead lane between four healthy ones", () => {
    // Read off production 2026-08-16T14:36Z. The pass ran THROUGH
    // account-summary's neighbours, so the shape is not "the container is
    // down" -- it is one lane failing silently, which is exactly what no
    // existing watchdog could express.
    const verdict = evaluateContainerLanes({
      statuses: [
        {
          lane: "container:decode",
          body: { updated_at: "2026-08-16T14:19:40Z", status: "ok" },
        },
        {
          lane: "container:daily-rollup",
          body: { checked_at: "2026-08-16T14:23:58Z", ok: true },
        },
        {
          lane: "container:state-mirror",
          body: { checked_at: "2026-08-16T14:26:17Z", ok: true },
        },
        {
          lane: "container:account-events-rollup",
          body: { checked_at: FRESH, ok: true },
        },
        {
          lane: "container:account-summary",
          // `phase: complete, ok: true` -- it did not crash. It ran, succeeded,
          // and was never invoked again. Only the AGE tells you.
          body: {
            checked_at: "2026-08-15T06:26:33Z",
            ok: true,
            phase: "complete",
          },
        },
      ],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.deepEqual(verdict.stale_lanes, ["container:account-summary"]);
    assert.match(
      verdict.entries[4]!.detail ?? "",
      /32\.2h since the last pass/,
    );
    assert.equal(
      verdict.entries[4]!.age_ms,
      NOW - Date.parse("2026-08-15T06:26:33Z"),
    );
    // ...and the four that ran are not swept up with it.
    for (const entry of verdict.entries.slice(0, 4)) {
      assert.equal(entry.verdict, "ok", entry.lane);
      assert.equal(entry.detail, null);
    }
  });

  test("a DECLARED failure outranks a fresh timestamp", () => {
    // A lane that just ran and said it failed is FRESH, so the age rule alone
    // would call it healthy. Its own `ok: false` is the better signal.
    const verdict = evaluateContainerLanes({
      statuses: [
        {
          lane: "container:decode",
          body: {
            updated_at: FRESH,
            status: "failed",
            detail: "load: pyiceberg commit conflict",
          },
        },
        {
          lane: "container:state-mirror",
          body: { checked_at: FRESH, ok: false, phase: "mirror" },
        },
      ],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.deepEqual(verdict.stale_lanes, [
      "container:decode",
      "container:state-mirror",
    ]);
    // The producer's own words, not a message invented here about a process
    // running in another repository.
    assert.match(
      verdict.entries[0]!.detail ?? "",
      /lane failed: load: pyiceberg commit conflict/,
    );
    assert.match(verdict.entries[1]!.detail ?? "", /lane failed: mirror/);
  });

  test("a failure with nothing to quote still says so", () => {
    // The producer is another repo's script; it may report `ok: false` and
    // nothing else. A verdict that went blank there would report the lane as
    // failing without saying it failed.
    const verdict = evaluateContainerLanes({
      statuses: [
        { lane: "bare", body: { checked_at: FRESH, ok: false } },
        // `status` alone, with neither detail nor phase to prefer over it.
        { lane: "status-only", body: { updated_at: FRESH, status: "failed" } },
      ],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(verdict.entries[0]!.detail, "lane reported failure");
    assert.equal(verdict.entries[1]!.detail, "lane failed: failed");
  });

  test("absent and unreadable are UNKNOWN, never stale and never ok", () => {
    // #10215's distinction. An absent status may mean a perfectly healthy lane
    // whose object is merely missing: calling that `stale` invents a fault,
    // calling it `ok` invents a measurement.
    const verdict = evaluateContainerLanes({
      statuses: [
        { lane: "container:decode", body: null },
        { lane: "container:daily-rollup", body: { ok: true } },
        {
          lane: "container:state-mirror",
          body: { checked_at: "not a date", ok: true },
        },
      ],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false, "unknown is not an alarm");
    assert.deepEqual(verdict.stale_lanes, []);
    for (const entry of verdict.entries) {
      assert.equal(entry.verdict, "unknown", entry.lane);
      assert.equal(entry.age_ms, null, "an unmeasured age is null, not 0");
    }
    assert.match(
      verdict.entries[0]!.detail ?? "",
      /no status object published/,
    );
    assert.match(verdict.entries[1]!.detail ?? "", /no readable timestamp/);
  });

  test("either timestamp spelling is accepted", () => {
    // decode publishes `updated_at`; the other four publish `checked_at`.
    // Which word a script chose is not a fact about lane health.
    const verdict = evaluateContainerLanes({
      statuses: [
        { lane: "a", body: { updated_at: FRESH, ok: true } },
        { lane: "b", body: { checked_at: FRESH, ok: true } },
      ],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.deepEqual(
      verdict.entries.map((e) => e.verdict),
      ["ok", "ok"],
    );
  });

  test("a healthy fleet is entirely quiet", () => {
    const verdict = evaluateContainerLanes({
      statuses: CONTAINER_LANES.map(({ lane }) => ({
        lane,
        body: { checked_at: FRESH, ok: true },
      })),
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false);
    assert.equal(verdict.checked, 5);
  });
});

describe("the bound", () => {
  test("is six passes of the container's own cadence", () => {
    assert.equal(CONTAINER_PASS_INTERVAL_MS, 3_600_000);
    assert.equal(CONTAINER_MISSED_PASSES, 6);
    assert.equal(CONTAINER_LANE_THRESHOLD_MS, 6 * 3_600_000);
  });

  test("catches the incident, and is not tripped by one missed pass", () => {
    // The two properties the width has to satisfy at once: it must fire on the
    // real 32-hour stall well before 32 hours, and it must NOT fire on a lane
    // that skipped a pass for a redeploy.
    const stall = evaluateContainerLanes({
      statuses: [{ lane: "l", body: { checked_at: "2026-08-15T06:26:33Z" } }],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(stall.stale, true);

    const skipped = evaluateContainerLanes({
      statuses: [
        {
          lane: "l",
          body: { checked_at: new Date(NOW - 2 * 3_600_000).toISOString() },
        },
      ],
      nowMs: NOW,
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(
      skipped.stale,
      false,
      "two missed passes is jitter, not a stall",
    );
  });
});

describe("runContainerLaneWatchdog", () => {
  /** A bucket serving the given bodies by key; anything else is absent. */
  function bucketWith(bodies: Record<string, unknown>) {
    return {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          if (!(key in bodies)) return null;
          return {
            async json() {
              return bodies[key];
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;
  }

  /** Records what was written to lane_health. */
  function laneSpy() {
    const rows: unknown[][] = [];
    return {
      rows,
      db: {
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT")) rows.push(values);
          return { changes: 1 };
        },
      },
    };
  }

  test("writes a DURABLE verdict for every lane, every tick", async () => {
    // #9330/#9340: PostHog drops `$exception` once the free-tier quota is
    // exhausted, and a dropped notification is indistinguishable from a fleet
    // that was fine. The row is the record; the event is the notification.
    const spy = laneSpy();
    const bodies = Object.fromEntries(
      CONTAINER_LANES.map(({ key }) => [key, { checked_at: FRESH, ok: true }]),
    );
    const result = (await runContainerLaneWatchdog(bucketWith(bodies), {
      now: () => NOW,
      recordException: (async () => true) as never,
      laneHealthDb: spy.db,
    })) as { ok?: boolean; stale?: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    assert.equal(spy.rows.length, 5, "one row per lane even when all are ok");
    assert.deepEqual(
      spy.rows.map((r) => r[0]),
      CONTAINER_LANES.map((l) => l.lane),
    );
  });

  test("reads the artifacts and names the stalled lane in ONE event", async () => {
    const spy = laneSpy();
    const messages: string[] = [];
    const bodies = Object.fromEntries(
      CONTAINER_LANES.map(({ key, lane }) => [
        key,
        lane === "container:account-summary"
          ? { checked_at: "2026-08-15T06:26:33Z", ok: true, phase: "complete" }
          : { checked_at: FRESH, ok: true },
      ]),
    );
    const result = (await runContainerLaneWatchdog(bucketWith(bodies), {
      now: () => NOW,
      recordException: (async (_env: unknown, ev: { error?: unknown }) => {
        messages.push(String((ev.error as Error)?.message));
        return true;
      }) as never,
      laneHealthDb: spy.db,
    })) as { stale?: boolean; stale_lanes?: string[] };
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_lanes, ["container:account-summary"]);
    assert.equal(messages.length, 1, "one event, not five");
    assert.match(messages[0]!, /container:account-summary/);
    assert.match(
      messages[0]!,
      /nothing in this Worker will recover them/,
      "the message must say where the fix lives",
    );
  });

  test("a lane that has NEVER run is unknown, and the others still report", async () => {
    // A real shape: a lane added to the container that has not completed a
    // pass yet has no status object at all. It must not be reported as healthy,
    // and it must not suppress the four lanes that did run.
    const spy = laneSpy();
    const bodies = Object.fromEntries(
      CONTAINER_LANES.filter((l) => l.lane !== "container:account-summary").map(
        ({ key }) => [key, { checked_at: FRESH, ok: true }],
      ),
    );
    const result = (await runContainerLaneWatchdog(bucketWith(bodies), {
      now: () => NOW,
      recordException: (async () => true) as never,
      laneHealthDb: spy.db,
    })) as { stale?: boolean };
    assert.equal(result.stale, false, "never-run is unknown, not an alarm");
    const verdicts = Object.fromEntries(
      spy.rows.map((r) => [String(r[0]), String(r[1])]),
    );
    assert.equal(verdicts["container:account-summary"], "unknown");
    assert.equal(verdicts["container:decode"], "ok");
  });

  test("a body that is not an object reads as absent", async () => {
    // Every field carries `.catch`, so the OBJECT parse is the only thing left
    // that can fail -- a status key holding a string, or an array, which is
    // what a half-written or wrong-keyed object looks like from here.
    const spy = laneSpy();
    const notObjects = {
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return "not a status object";
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;
    const result = (await runContainerLaneWatchdog(notObjects, {
      now: () => NOW,
      recordException: (async () => true) as never,
      laneHealthDb: spy.db,
    })) as { ok?: boolean; stale?: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.stale, false, "unparseable is unknown, not an alarm");
    assert.deepEqual(
      spy.rows.map((r) => r[1]),
      Array(5).fill("unknown"),
    );
  });

  test("a telemetry failure does not take the tick down", async () => {
    // The durable row is the record and the event is only the notification, so
    // a rejecting capture must not cost the verdicts -- the inversion
    // #9330/#9340 exist about.
    const spy = laneSpy();
    const bodies = Object.fromEntries(
      CONTAINER_LANES.map(({ key }) => [
        key,
        { checked_at: "2026-08-15T06:26:33Z", ok: true },
      ]),
    );
    const result = (await runContainerLaneWatchdog(bucketWith(bodies), {
      now: () => NOW,
      recordException: (async () => {
        throw new Error("posthog quota exhausted");
      }) as never,
      laneHealthDb: spy.db,
    })) as { ok?: boolean; stale?: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.equal(spy.rows.length, 5, "every verdict still recorded");
  });

  test("a missing binding is a stated no-op, not a silent pass", async () => {
    const result = (await runContainerLaneWatchdog({}, {})) as {
      ok?: boolean;
      reason?: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /r2 binding unavailable/);
  });

  test("a throwing bucket reads as absent rather than taking the tick down", async () => {
    const spy = laneSpy();
    const throwing = {
      METAGRAPH_ARCHIVE: {
        async get() {
          throw new Error("r2 unreachable");
        },
      },
    } as unknown as Record<string, unknown>;
    const result = (await runContainerLaneWatchdog(throwing, {
      now: () => NOW,
      recordException: (async () => true) as never,
      laneHealthDb: spy.db,
    })) as { ok?: boolean; stale?: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.stale, false, "unreadable is unknown, not an alarm");
    assert.equal(spy.rows.length, 5, "and every lane still gets a row");
  });
});

/**
 * The detail a `stale` verdict carries, after the watchdog's first real catch.
 *
 * 2026-08-16T16:30:40Z, production: the account-summary lane published
 * `ok: false, phase: "complete", failures: { _lane: "ArrowInvalid: ..." }` and
 * `lane_health` recorded `lane failed: complete`. The reader fell through
 * `detail` (absent) to `phase`, which names the step that FINISHED rather than
 * the reason it failed.
 */
describe("laneFailureDetail", () => {
  test("QUOTES THE FAILURE, not the phase that finished", () => {
    assert.equal(
      laneFailureDetail({
        phase: "complete",
        failures: { _lane: "ArrowInvalid: Schema at index 1 was different" },
      }),
      "_lane: ArrowInvalid: Schema at index 1 was different",
    );
  });

  test("EVERY step that failed, not an arbitrary one", () => {
    // The map is per-step, so a pass that failed three ways has three things
    // worth knowing, and picking one would be an arbitrary choice presented as
    // a summary.
    assert.equal(
      laneFailureDetail({ failures: { a: "first broke", b: "second broke" } }),
      "a: first broke; b: second broke",
    );
  });

  test("a long message is FLATTENED AND BOUNDED", () => {
    // The real one carried a 700-character pyarrow traceback. A `$exception`
    // nobody can read at a glance is a `$exception` nobody reads, and the full
    // text is in the status object either way.
    const said = laneFailureDetail({
      failures: { _where: `line one\n  line two ${"x".repeat(500)}` },
    });
    assert.ok(said!.length <= LANE_DETAIL_MAX + "_where: ".length, said!);
    assert.ok(!said!.includes("\n"), "a newline in an alarm line");
    assert.ok(said!.endsWith("\u2026"), said!.slice(-20));
  });

  test("a NON-STRING value is skipped rather than stringified", () => {
    // `[object Object]` in an alarm is worse than the key's absence: it looks
    // like a message and carries none. This repo owns none of the producers.
    assert.equal(
      laneFailureDetail({ detail: "the real one", failures: { a: { b: 1 } } }),
      "the real one",
    );
  });

  test("an EMPTY failures map falls through, it does not report nothing", () => {
    // Every successful pass publishes `failures: {}`, so treating the key's
    // presence as the signal would silence the fallback for the lanes that
    // report most carefully.
    assert.equal(laneFailureDetail({ failures: {}, detail: "d" }), "d");
    assert.equal(laneFailureDetail({ failures: {}, phase: "p" }), "p");
    assert.equal(laneFailureDetail({ failures: null }), null);
  });

  test("the RUNNER carries it into the verdict", () => {
    // The unit above is the rule; this is the property that matters -- the
    // durable record is what an operator reads at 3am.
    const verdict = evaluateContainerLanes({
      statuses: [
        {
          lane: "container:account-summary",
          body: {
            checked_at: "2026-08-16T16:30:40Z",
            ok: false,
            phase: "complete",
            failures: { _lane: "ArrowInvalid: Schema at index 1" },
          },
        },
      ],
      nowMs: Date.parse("2026-08-16T16:31:00Z"),
      thresholdMs: CONTAINER_LANE_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(
      verdict.entries[0]!.detail,
      "lane failed: _lane: ArrowInvalid: Schema at index 1",
    );
  });
});
