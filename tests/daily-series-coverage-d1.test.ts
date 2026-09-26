import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
  DAILY_COVERAGE_LOOKBACK_DAYS,
  DAILY_SERIES,
  evaluateDailyCoverage,
  runDailySeriesCoverageWatchdog,
} from "../src/daily-series-coverage-watchdog.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const NOW = Date.UTC(2026, 8, 26, 12);
const day = (offset: number) =>
  new Date(NOW - offset * 86_400_000).toISOString().slice(0, 10);
let db: D1Database;
const queries: string[] = [];
const env = () => ({
  D1_STATE: {
    prepare(sql: string) {
      queries.push(sql);
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  },
  D1_STATE_TABLES: "neuron_daily,account_position_daily,lane_health",
});

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0001_lane_health.sql",
    "0002_lane_health_current.sql",
    "0007_neuron_documents.sql",
    "0012_neuron_daily_join_index.sql",
    "0022_neuron_document_dates.sql",
  ]) {
    const sql = readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint"))
      await db.prepare(statement).run();
  }
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  queries.length = 0;
  await db.batch(
    [
      ...DAILY_SERIES.flatMap(({ table }) => [
        `${table}_members`,
        `${table}_documents`,
      ]),
      "lane_health",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
});

async function seed(days: number) {
  for (let offset = 0; offset < days; offset++) {
    const statements: D1PreparedStatement[] = [];
    for (const { table } of DAILY_SERIES) {
      for (const netuid of [0, 7]) {
        for (const shard of [0, 1]) {
          statements.push(
            db
              .prepare(
                `INSERT INTO ${table}_documents VALUES (?, ?, ?, ?, jsonb('{}'))`,
              )
              .bind(netuid, day(offset), shard, NOW),
          );
          for (let i = 0; i < 4; i++) {
            const id = shard * 256 + i;
            statements.push(
              table === "neuron_daily"
                ? db
                    .prepare(
                      `INSERT INTO neuron_daily_members VALUES (?, ?, ?, NULL, NULL, ?)`,
                    )
                    .bind(netuid, id, day(offset), shard)
                : db
                    .prepare(
                      `INSERT INTO account_position_daily_members VALUES (?, ?, ?, ?)`,
                    )
                    .bind(`account-${id}`, netuid, day(offset), shard),
            );
          }
        }
      }
    }
    await db.batch(statements);
  }
}

async function expected() {
  return Promise.all(
    DAILY_SERIES.map(async ({ table, column }) => {
      const { results } = await db
        .prepare(
          `SELECT ${column} AS date, COUNT(*) AS rows FROM ${table} GROUP BY ${column} ORDER BY ${column} DESC LIMIT ?`,
        )
        .bind(DAILY_COVERAGE_LOOKBACK_DAYS)
        .all<{ date: string; rows: number }>();
      return evaluateDailyCoverage(table, results);
    }),
  );
}

test("D1 counts preserve view semantics, gaps, thin days, orphaned members and durable alarms", async () => {
  await seed(8);
  await db.batch([
    db.prepare("DELETE FROM neuron_daily_documents WHERE day=?").bind(day(3)),
    db
      .prepare(
        "DELETE FROM account_position_daily_members WHERE snapshot_date=? AND account NOT IN ('account-0','account-256')",
      )
      .bind(day(4)),
    db.prepare("UPDATE neuron_daily_members SET shard=99 WHERE uid=1"),
    db.prepare("DELETE FROM neuron_daily_members WHERE uid=2"),
    db.prepare(
      "INSERT INTO neuron_daily_members VALUES (0, 99, '2099-01-01', NULL, NULL, 0)",
    ),
    db
      .prepare(
        "INSERT INTO account_position_daily_documents VALUES (99, '2099-01-01', 0, ?, jsonb('{}'))",
      )
      .bind(NOW),
  ]);
  const record = vi.fn(async () => true);
  const result = await runDailySeriesCoverageWatchdog(env(), {
    now: () => NOW,
    recordException: record,
  });
  assert.equal(result.ok, true);
  assert.equal(result.alerted, true);
  assert.deepEqual(result.verdicts, await expected());
  assert.equal(record.mock.calls.length, 1);
  const verdict = await db
    .prepare("SELECT verdict, detail FROM lane_health_current")
    .first();
  assert.equal(verdict?.verdict, "stale");
  assert.match(String(verdict?.detail), new RegExp(day(3)));
  assert.match(String(verdict?.detail), new RegExp(day(4)));
  for (const sql of queries.filter((sql) =>
    sql.startsWith("WITH member_counts"),
  )) {
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(90)
      .all<{ detail: string }>();
    assert.ok(
      results.some(({ detail }) => detail === "MATERIALIZE member_counts"),
    );
    assert.ok(
      results.some(({ detail }) => /SEARCH d USING PRIMARY KEY/.test(detail)),
    );
  }
});

test("D1 keeps empty series and the newest 90 valid days identical to the views", async () => {
  const tick = () => runDailySeriesCoverageWatchdog(env(), { now: () => NOW });
  assert.deepEqual((await tick()).verdicts, await expected());
  await seed(95);
  // An old member without a document and a future empty document cannot
  // change either end of the measured window or displace a populated day.
  await db.batch([
    db.prepare(
      "INSERT INTO account_position_daily_members VALUES ('orphan',0,'1970-01-22',0)",
    ),
    db
      .prepare(
        "INSERT INTO neuron_daily_documents VALUES (99,'2099-01-01',0,?,jsonb('{}'))",
      )
      .bind(NOW),
  ]);
  const result = await tick();
  assert.equal(result.ok, true);
  assert.equal(result.alerted, false);
  assert.deepEqual(result.verdicts, await expected());
});
