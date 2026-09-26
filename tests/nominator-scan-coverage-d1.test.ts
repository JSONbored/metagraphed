import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
  NOMINATOR_HISTORY_MS,
  NOMINATOR_POSITIONS_COVERAGE_SQL,
} from "../src/nominator-scan-coverage.ts";
import { runNominatorPositionsStalenessWatchdog } from "../src/nominator-positions-staleness-watchdog.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12);
const CAPTURE = NOW - 3_600_000;
let db: D1Database;

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0001_lane_health.sql",
    "0002_lane_health_current.sql",
    "0010_ledger_state.sql",
  ]) {
    const migration = readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("-- statement-breakpoint"))
      await db.prepare(statement).run();
  }
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  await db.batch(
    [
      "nominator_scan_receipts",
      "nominator_positions_passes",
      "lane_health",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
});

async function pass(
  at: number,
  covered: number,
  expected = covered,
  completed: number | null = at + 60_000,
) {
  await db.batch([
    ...Array.from({ length: covered }, (_, i) =>
      db
        .prepare("INSERT INTO nominator_scan_receipts VALUES (?, ?, 1)")
        .bind(at, `cold-${i}`),
    ),
    db
      .prepare("INSERT INTO nominator_positions_passes VALUES (?, ?, ?, ?)")
      .bind(at, expected, covered, completed),
  ]);
}

const coverage = () =>
  db
    .prepare(NOMINATOR_POSITIONS_COVERAGE_SQL)
    .bind(NOW - NOMINATOR_HISTORY_MS)
    .first<Record<string, unknown>>();

const tick = (record = vi.fn(async () => true)) =>
  runNominatorPositionsStalenessWatchdog(
    {
      D1_STATE: db,
      D1_STATE_TABLES:
        "nominator_scan_receipts,nominator_positions_passes,lane_health",
      NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS: 4,
    },
    { now: () => NOW, recordException: record },
  );

test("D1 measures and persists empty, complete and partial scans without a Neon fallback", async () => {
  assert.equal((await coverage())?.latest, null);
  assert.equal((await tick()).reason, "no_rows");
  await pass(CAPTURE, 5);
  const complete = await tick();
  assert.equal(complete.ok, true);
  assert.equal(complete.delivery_complete, true);
  assert.equal(complete.alerted, false);
  assert.equal(complete.covered_coldkeys, 5);
  assert.equal(complete.latest_captured_at, CAPTURE);
  const verdict = await db
    .prepare("SELECT verdict FROM lane_health ORDER BY rowid DESC LIMIT 1")
    .first();
  assert.equal(verdict?.verdict, "ok");

  await pass(CAPTURE + 60_000, 0, 5, null);
  const record = vi.fn(async () => true);
  const partial = await tick(record);
  assert.equal(partial.reason, "partial");
  assert.equal(partial.received_rows, 0);
  assert.equal(partial.expected_rows, 5);
  assert.equal(partial.delivery_complete, false);
  assert.equal(record.mock.calls.length, 1);
});

test("D1 gives one vote per completed prior day and excludes expired and current-day scans", async () => {
  for (let day = 1; day <= 7; day++) {
    await pass(CAPTURE - day * DAY - 60_000, 20);
    await pass(CAPTURE - day * DAY, day + 2);
  }
  await pass(CAPTURE - 8 * DAY, 30);
  await pass(CAPTURE - 40 * DAY, 40);
  await pass(CAPTURE - 60_000, 30);
  await pass(CAPTURE, 5);
  const row = await coverage();
  assert.equal(row?.baseline_days, 7);
  assert.equal(row?.baseline_coldkeys, 6);
  assert.equal(row?.covered, 5);
  assert.equal(row?.total, 30);
});

test("D1 interpolates an even median and rejects incomplete or replay-inflated history", async () => {
  await pass(CAPTURE - DAY, 5);
  await pass(CAPTURE - 2 * DAY, 6);
  await pass(CAPTURE - 3 * DAY, 20, 21);
  await pass(CAPTURE - 4 * DAY, 20, 20, null);
  await db
    .prepare(
      "UPDATE nominator_positions_passes SET received_rows = 21 WHERE captured_at = ?",
    )
    .bind(CAPTURE - 3 * DAY)
    .run();
  await pass(CAPTURE, 5);
  const row = await coverage();
  assert.equal(row?.baseline_days, 2);
  assert.equal(row?.baseline_coldkeys, 5.5);
});
