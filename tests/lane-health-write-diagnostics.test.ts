import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  classifyLaneHealthWriteError,
  createLaneHealthWriteReporter,
  LANE_HEALTH_WRITE_FAILURES,
} from "../src/lane-health-write-diagnostics.ts";
import { recordLaneVerdict } from "../src/lane-health.ts";

afterEach(() => vi.restoreAllMocks());

test("driver failures become fixed classes without exporting their text", () => {
  for (const [error, reason] of [
    [
      new Error("D1_ERROR: database or disk is full: SQLITE_FULL"),
      "insert_capacity",
    ],
    [{ code: "SQLITE_FULL", message: 19 }, "insert_capacity"],
    [new Error("D1_ERROR: Exceeded maximum DB size."), "insert_capacity"],
    [{ code: "D1_ERROR", message: "maximum database size" }, "insert_capacity"],
    [new Error("D1_ERROR: D1 DB storage limit"), "insert_capacity"],
    [new Error("D1_ERROR: storage limit exceeded"), "insert_capacity"],
    [new Error("Exceeded maximum DB size."), "insert_error"],
    [new Error("D1_ERROR: unrelated write failure"), "insert_error"],
    [
      { cause: new Error("D1_ERROR: Exceeded maximum DB size.") },
      "insert_capacity",
    ],
    [new Error("SQLITE_BUSY token=do-not-log"), "insert_busy"],
    [new Error("SQLITE_LOCKED"), "insert_busy"],
    [new Error("binding timed out"), "insert_timeout"],
    [new Error("timeout"), "insert_timeout"],
    [new Error("SQLITE_CONSTRAINT"), "insert_constraint"],
    [new Error("constraint failed: row-payload"), "insert_constraint"],
    [new Error("no such table: lane_health"), "insert_schema"],
    [new Error("allocated near 10GB"), "insert_error"],
    [{ cause: { code: "SQLITE_FULL" } }, "insert_capacity"],
    [null, "insert_error"],
    ["SQLITE_FULL", "insert_error"],
    [{}, "insert_error"],
  ] as const)
    assert.equal(classifyLaneHealthWriteError(error), reason);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(classifyLaneHealthWriteError(cycle), "insert_error");
  assert.equal(
    classifyLaneHealthWriteError({
      get message() {
        throw new Error("hidden");
      },
    }),
    "insert_error",
  );
});

test("one isolate-wide time bucket bounds all failure reasons and packet identities", () => {
  let clock = 0;
  const events: unknown[] = [];
  const report = createLaneHealthWriteReporter(
    () => clock,
    (summary) => events.push(summary),
  );
  report(2, 2, []);
  assert.equal(events.length, 0);
  report(2, 1, ["insert_capacity"]);
  for (let index = 0; index < 1000; index++) report(50, 0, ["insert_busy"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    expected: 2,
    confirmed: 1,
    failures: Object.fromEntries(
      LANE_HEALTH_WRITE_FAILURES.map((reason) => [
        reason,
        Number(reason === "insert_capacity"),
      ]),
    ),
  });
  clock = 60_000;
  report(null, 0, ["missing_secret"]);
  assert.equal(events.length, 2);
  assert.ok(JSON.stringify(events).length < 1024);
});

test("the default sink has one fixed label and never receives error or row payloads", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(Date, "now").mockReturnValue(1);
  createLaneHealthWriteReporter()(1, 0, ["returned_identity"]);
  assert.equal(warn.mock.calls.length, 1);
  assert.equal(warn.mock.calls[0][0], "poller_lane_health_write_failure");
  assert.deepEqual(Object.keys(warn.mock.calls[0][1]).sort(), [
    "confirmed",
    "expected",
    "failures",
  ]);
  assert.doesNotThrow(() =>
    createLaneHealthWriteReporter(
      () => 0,
      () => {
        throw new Error("sink unavailable");
      },
    )(1, 0, ["insert_error"]),
  );
});

test("writer diagnostics distinguish missing stores, returned counts and identities without changing failure semantics", async () => {
  const row = {
    lane: "chain-detail",
    verdict: "ok" as const,
    age_ms: 1,
    detail: "private payload token=hidden",
    checked_at: 1,
  };
  for (const [rows, reason] of [
    [[], "returned_count"],
    [[row, row], "returned_count"],
    [[null], "returned_identity"],
    [[{ ...row, detail: "different" }], "returned_identity"],
    [new Error("SQLITE_FULL password=hidden"), "insert_capacity"],
  ] as const) {
    const failures: unknown[] = [];
    const db = {
      async run() {
        return { changes: 0 };
      },
      async query() {
        if (rows instanceof Error) throw rows;
        return rows;
      },
    };
    assert.equal(
      await recordLaneVerdict(db as never, row, {
        confirm: true,
        onFailure: (failure) => failures.push(failure),
      }),
      false,
    );
    assert.deepEqual(failures, [reason]);
    assert.doesNotMatch(
      JSON.stringify(failures),
      /hidden|private|password|payload/,
    );
  }
  const missing: string[] = [];
  assert.equal(
    await recordLaneVerdict(null, row, {
      onFailure: (failure) => missing.push(failure),
    }),
    false,
  );
  assert.deepEqual(missing, ["missing_store"]);
  assert.equal(
    await recordLaneVerdict(null, row, {
      onFailure: () => {
        throw new Error("diagnostic failed");
      },
    }),
    false,
  );
});
