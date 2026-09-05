import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  NOMINATOR_HISTORY_MS,
  NOMINATOR_POSITIONS_COVERAGE_SQL,
  NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
  nominatorCoverageFloor,
} from "../src/nominator-scan-coverage.ts";
import {
  NOMINATOR_POSITIONS_DELIVERY_GRACE_MS,
  evaluateNominatorPositionsStaleness,
  runNominatorPositionsStalenessWatchdog,
} from "../src/nominator-positions-staleness-watchdog.ts";
import {
  coldkeyMaxCapturedAt,
  mirrorNominatorPositionsToNeon,
  POSITION_SOURCE_SELF_STAKE,
} from "../src/nominator-positions-neon-write.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 3, 12);
const CAPTURE = NOW - 3_600_000;
let db: PGlite;
const sql = {
  async unsafe(text: string, values: unknown[] = []) {
    return (await db.query(text, values)).rows;
  },
};

beforeAll(async () => {
  db = new PGlite();
  for (const file of [
    "0005_remaining_d1_tables.sql",
    "0006_lane_health.sql",
    "0007_hand_created_tables.sql",
    "0025_nominator_positions_shares.sql",
    "0027_nominator_positions_source.sql",
    "0035_nominator_scan_receipts.sql",
  ])
    await db.exec(fs.readFileSync(`migrations/neon/${file}`, "utf8"));
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec(
    "TRUNCATE nominator_positions, nominator_positions_passes, nominator_scan_receipts, lane_health",
  );
  pg.control.postgres = sql.unsafe;
  pg.control.rows = null;
  pg.control.answers = [];
  pg.control.failNext = null;
  pg.control.onQuery = null;
});

async function pass(
  capturedAt: number,
  covered: number,
  options: {
    expected?: number;
    counter?: number;
    completed?: boolean;
  } = {},
) {
  const expected = options.expected ?? covered;
  await db.query(
    "INSERT INTO nominator_scan_receipts SELECT $1::bigint, 'cold-' || n::text, 1 FROM generate_series(1, $2::int) n ON CONFLICT DO NOTHING",
    [capturedAt, covered],
  );
  await db.query(
    "INSERT INTO nominator_positions_passes VALUES ($1, $2, $3, $4) ON CONFLICT (captured_at) DO UPDATE SET expected_rows = EXCLUDED.expected_rows, received_rows = EXCLUDED.received_rows, completed_at = EXCLUDED.completed_at",
    [
      capturedAt,
      expected,
      options.counter ?? covered,
      options.completed === false ? null : capturedAt + 60_000,
    ],
  );
}

async function coverage() {
  return (
    await db.query<Record<string, unknown>>(
      NOMINATOR_POSITIONS_COVERAGE_SQL.replace("?", "$1"),
      [NOW - NOMINATOR_HISTORY_MS],
    )
  ).rows[0]!;
}

const tick = (
  now = NOW,
  floor: number | null = 80,
  record = vi.fn(async () => true),
) =>
  runNominatorPositionsStalenessWatchdog(
    { ...pgMockEnv(), NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS: floor },
    { now: () => now, recordException: record as never },
  );

describe("receipt-backed scan measurement", () => {
  test("empty receipts and pass ledger are unmeasured, never healthy", async () => {
    const row = await coverage();
    assert.equal(row.latest, null);
    assert.equal(row.covered, 0);
    assert.equal(row.baseline_days, 0);
    assert.equal((await tick()).reason, "no_rows");
  });

  test("self-stake takeover cannot erase a successful scan or change its clock", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      coldkey: `cold-${i + 1}`,
      hotkey: "hotkey",
      netuid: 1,
      share_fraction: 1,
      captured_at: CAPTURE,
    }));
    const mirror = (input: typeof rows, source?: string) =>
      mirrorNominatorPositionsToNeon(
        {},
        null,
        {
          rows: input,
          source,
          coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(input),
        },
        { sql },
      );
    await mirror(rows);
    await pass(CAPTURE, 100);
    await mirror(
      rows.slice(0, 30).map((r) => ({ ...r, captured_at: NOW })),
      POSITION_SOURCE_SELF_STAKE,
    );
    const result = await tick();
    assert.equal(result.alerted, false);
    assert.equal(result.latest_captured_at, CAPTURE);
    assert.equal(result.covered_coldkeys, 100);
    assert.equal(result.delivery_complete, true);
    assert.equal(
      (
        await db.query<{ count: number }>(
          "SELECT COUNT(*) FROM nominator_positions WHERE source = 'alpha'",
        )
      ).rows[0]!.count,
      70,
    );
  });

  test("two captures in the former four-hour window stay separate", async () => {
    await pass(CAPTURE - 3_600_000, 100);
    await pass(CAPTURE, 50, { expected: 100, completed: false });
    const result = await tick();
    assert.equal(result.covered_coldkeys, 50);
    assert.equal(result.total_coldkeys, 100);
    assert.equal(result.reason, "partial");
  });

  test("replayed delivery counters cannot make missing receipts complete", async () => {
    await pass(CAPTURE, 90, { expected: 100, counter: 180 });
    const partial = await tick();
    assert.equal(
      partial.covered_coldkeys,
      90,
      "width alone exceeds the 80-coldkey floor",
    );
    assert.equal(partial.received_rows, 90);
    assert.equal(partial.reason, "partial");
    await pass(CAPTURE, 100, { expected: 100, counter: 190 });
    const complete = await tick();
    assert.equal(complete.delivery_complete, true);
    assert.equal(complete.alerted, false);
  });

  test("a delivery in progress is unknown briefly and alerts if it never completes", async () => {
    // The ten-minute write buffer plus a drain can legitimately exceed ten
    // minutes even though producer delivery succeeded. Never mark it healthy.
    const capturedAt = NOW - 13 * 60_000;
    await pass(capturedAt, 50, { expected: 100, completed: false });
    const record = vi.fn(async () => true);
    const pending = await tick(NOW, 80, record);
    assert.equal(pending.reason, "in_progress");
    assert.equal(pending.alerted, false);
    assert.equal(record.mock.calls.length, 0);
    assert.equal(
      (
        await db.query<{ verdict: string }>(
          "SELECT verdict FROM lane_health ORDER BY checked_at DESC LIMIT 1",
        )
      ).rows[0]!.verdict,
      "unknown",
    );
    const expired = await tick(
      capturedAt + NOMINATOR_POSITIONS_DELIVERY_GRACE_MS + 1,
      80,
      record,
    );
    assert.equal(expired.reason, "partial");
    assert.equal(record.mock.calls.length, 1);
  });

  test("receipts without a pass declaration never become healthy", async () => {
    await db.query(
      "INSERT INTO nominator_scan_receipts VALUES ($1, 'cold', 1)",
      [NOW - 60_000],
    );
    assert.equal((await tick()).reason, "in_progress");
    const record = vi.fn(async () => true);
    const expired = await tick(
      NOW + NOMINATOR_POSITIONS_DELIVERY_GRACE_MS,
      80,
      record,
    );
    assert.equal(expired.reason, "partial");
    assert.equal(expired.expected_rows, null);
    assert.match(
      String(
        (record.mock.calls[0] as unknown as [unknown, { error: Error }])[1]
          .error.message,
      ),
      /1\/unknown rows/,
    );
  });

  test("a newer failed pass declaration is not hidden behind the last full scan", async () => {
    await pass(CAPTURE - DAY, 100);
    await pass(CAPTURE, 0, { expected: 100, completed: false });
    const result = await tick();
    assert.equal(result.latest_captured_at, CAPTURE);
    assert.equal(result.covered_coldkeys, 0);
    assert.equal(result.reason, "partial");
  });

  test("a stale full scan remains stale while targeted updates run", async () => {
    await pass(NOW - 40 * 3_600_000, 100);
    assert.equal((await tick()).reason, "stale");
  });
});

describe("completed daily scan baseline", () => {
  test("seven prior days follow gradual population drift and detect a sudden drop", async () => {
    for (let day = 1; day <= 7; day++)
      await pass(CAPTURE - day * DAY, 1000 + day * 10);
    await pass(CAPTURE, 970);
    const result = await tick(NOW, null);
    assert.equal(result.baseline_days, 7);
    assert.equal(result.baseline_coldkeys, 1040);
    assert.equal(result.coverage_floor_source, "history");
    assert.equal(result.coverage_floor_coldkeys, 832);
    assert.equal(result.alerted, false);
    await pass(CAPTURE + 1000, 500);
    assert.equal((await tick(NOW, null)).reason, "partial");
  });

  test("partial deliveries and repeated scans in one day cannot fill the history window", async () => {
    for (let day = 1; day <= 6; day++) await pass(CAPTURE - day * DAY, 1000);
    await pass(CAPTURE - 7 * DAY, 1000, { expected: 2000, counter: 4000 });
    for (let n = 1; n <= 10; n++) await pass(CAPTURE - DAY + n * 1000, 1000);
    await pass(CAPTURE, 1000);
    const result = await tick(NOW, null);
    assert.equal(result.baseline_days, 6);
    assert.equal(result.coverage_floor_source, "bootstrap");
    assert.equal(
      result.coverage_floor_coldkeys,
      NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
    );
    assert.equal(
      result.alerted,
      true,
      "insufficient history cannot lower the floor",
    );
  });

  test("old receipts and a large current pass do not affect the trailing median", async () => {
    for (let day = 1; day <= 8; day++)
      await pass(CAPTURE - day * DAY, day === 8 ? 9000 : 1000);
    await pass(CAPTURE - 40 * DAY, 20_000);
    await pass(CAPTURE, 5000);
    const row = await coverage();
    assert.equal(row.baseline_days, 7);
    assert.equal(row.baseline_coldkeys, 1000);
    assert.equal(
      row.total,
      9000,
      "expired receipts do not enter the retained population",
    );
  });
});

test("floor selection requires mature finite evidence and respects a valid override", () => {
  assert.deepEqual(nominatorCoverageFloor(7, 1000, undefined), {
    coldkeys: 800,
    source: "history",
  });
  assert.deepEqual(nominatorCoverageFloor(7, 1000, "950"), {
    coldkeys: 950,
    source: "override",
  });
  for (const [days, coldkeys] of [
    [6, 1000],
    [7, null],
    [7, NaN],
    [7, Infinity],
    [7, 0],
  ] as const) {
    assert.deepEqual(nominatorCoverageFloor(days, coldkeys, undefined), {
      coldkeys: NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
      source: "bootstrap",
    });
  }
  for (const override of [0, 0.4, -1, NaN, Infinity, "invalid"]) {
    assert.equal(nominatorCoverageFloor(7, 1000, override).source, "history");
  }
});

test("invalid or excessive deliveries do not receive processing grace", () => {
  const input = {
    latestCapturedAtMs: NOW - 1,
    coveredColdkeys: 100,
    totalColdkeys: 100,
    receivedRows: 101,
    expectedRows: 100,
    completedAtMs: null,
    nowMs: NOW,
    thresholdMs: 36 * 3_600_000,
    coverageFloorColdkeys: 80,
  };
  assert.equal(evaluateNominatorPositionsStaleness(input).reason, "partial");
  assert.equal(
    evaluateNominatorPositionsStaleness({
      ...input,
      latestCapturedAtMs: NOW + 1,
      receivedRows: 50,
    }).reason,
    "partial",
  );
  assert.equal(
    evaluateNominatorPositionsStaleness({ ...input, expectedRows: 0 })
      .delivery_complete,
    false,
  );
});
