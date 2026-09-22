import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import {
  persistProbesToNeon,
  rollupUptimeDailyToNeon,
  rollupFailureReasonsToNeon,
  pruneChecksNeon,
  upsertSubnetSnapshotsToNeon,
  OBSERVATION_TABLES,
} from "../src/observations-neon.ts";
import { observationsReadDb } from "../src/observations-read-runner.ts";
import { rollupDailyUptime, pruneHealthHistory } from "../src/health-prober.ts";
import { apiEnv } from "./helpers/worker-env.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const now = 1790090000000;
const day = {
  date: "2026-09-22",
  start: Date.parse("2026-09-22T00:00:00Z"),
  end: Date.parse("2026-09-23T00:00:00Z"),
};
const store = () => createD1Store(db);
const sql = () => ({
  nativeD1: store(),
  async unsafe() {
    throw new Error("Postgres must not run");
  },
});
const env = () =>
  apiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: OBSERVATION_TABLES.join(","),
    HYPERDRIVE: undefined,
  });
const probe = (
  surface_id = "alias",
  surface_key: string | null = "key-a",
  at = now,
) => ({
  surface_id,
  surface_key,
  checked_at_ms: at,
  netuid: 1,
  kind: "http",
  status: "ok",
  classification: "ok",
  latency_ms: 20,
  status_code: 200,
  last_ok_ms: at,
});
const status = (id: string) =>
  db
    .prepare("SELECT * FROM surface_status WHERE surface_id=?")
    .bind(id)
    .first();
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const s of readFileSync(
    new URL("../migrations/d1/0008_observations.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (s.trim()) await db.prepare(s).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const table of OBSERVATION_TABLES)
    await db.prepare(`DELETE FROM ${table}`).run();
});
test("stable-key aliases move atomically while older history and measured last_ok survive", async () => {
  assert.equal((await persistProbesToNeon(sql(), [probe()], now)).ok, true);
  assert.equal(
    (
      await persistProbesToNeon(
        sql(),
        [
          {
            ...probe("alias", "key-b", now + 1),
            status: "failed",
            last_ok_ms: null,
          },
        ],
        now + 1,
      )
    ).ok,
    true,
  );
  assert.equal((await status("history:key-a"))?.last_ok, now);
  assert.equal((await status("alias"))?.surface_key, "key-b");
  await persistProbesToNeon(
    sql(),
    [probe("renamed", "key-a", now + 2)],
    now + 2,
  );
  assert.equal(await status("history:key-a"), null);
  assert.equal((await status("renamed"))?.surface_key, "key-a");
  await persistProbesToNeon(sql(), [probe("alias", "key-a", now - 1)], now + 3);
  assert.equal((await status("alias"))?.surface_key, "key-b");
  assert.equal((await status("renamed"))?.last_checked, now + 2);
  await persistProbesToNeon(
    sql(),
    [
      {
        ...probe("renamed", "key-a", now + 3),
        status: "failed",
        last_ok_ms: null,
      },
    ],
    now + 3,
  );
  assert.equal((await status("renamed"))?.last_ok, now + 2);
  await persistProbesToNeon(
    sql(),
    [{ ...probe("renamed", "key-a", now + 4), last_ok_ms: now - 10 }],
    now + 4,
  );
  assert.equal((await status("renamed"))?.last_ok, now + 2);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_checks").first("n"),
    6,
  );
});
test("keyless status can be displaced, null last_ok stays unknown, and equal-time raw retries do not duplicate checks", async () => {
  await persistProbesToNeon(
    sql(),
    [{ ...probe("legacy", null), last_ok_ms: null, status: "failed" }],
    now,
  );
  await persistProbesToNeon(
    sql(),
    [
      {
        ...probe("legacy", "key-c", now + 1),
        last_ok_ms: null,
        status: "failed",
      },
    ],
    now + 1,
  );
  assert.equal((await status("legacy"))?.surface_key, "key-c");
  assert.equal((await status("legacy"))?.last_ok, null);
  await persistProbesToNeon(
    sql(),
    [probe("legacy", "key-c", now + 2)],
    now + 2,
  );
  assert.equal((await status("legacy"))?.last_ok, now + 2);
  await persistProbesToNeon(
    sql(),
    [probe("legacy", "key-c", now + 2)],
    now + 2,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_checks").first("n"),
    3,
  );
  await persistProbesToNeon(
    sql(),
    [
      {
        ...probe("no-key", null),
        url: "https://example.com",
        provider: "fixture",
        consecutive_failures: 2,
      },
    ],
    now,
  );
  assert.equal((await status("no-key"))?.consecutive_failures, 2);
  assert.equal((await persistProbesToNeon(sql(), [], now)).reason, "no_rows");
});
test("daily rollups retain aliases, null subnet failures, success-only percentiles and idempotent replacement", async () => {
  const probes = Array.from({ length: 20 }, (_, i) => ({
    ...probe("a", "stable-a", day.start + i),
    latency_ms: i + 1,
  }));
  probes.push({
    ...probe("a", "stable-a", day.start + 20),
    status: "failed",
    latency_ms: 99999,
    classification: "timeout",
  });
  await persistProbesToNeon(sql(), probes, now);
  await persistProbesToNeon(
    sql(),
    [
      {
        ...probe("other", null, day.start + 1),
        netuid: null,
        status: "failed",
        classification: "timeout",
        last_ok_ms: null,
      },
    ],
    now,
  );
  assert.equal((await rollupUptimeDailyToNeon(sql(), [day], now)).ok, true);
  assert.equal((await rollupFailureReasonsToNeon(sql(), [day], now)).ok, true);
  const a = await db
    .prepare("SELECT * FROM surface_uptime_daily WHERE surface_id='a'")
    .first();
  assert.equal(a?.samples, 21);
  assert.equal(a?.ok_count, 20);
  assert.equal(a?.avg_latency_ms, 11);
  assert.equal(a?.p50_latency_ms, 10);
  assert.equal(a?.p95_latency_ms, 19);
  assert.equal(a?.p99_latency_ms, 20);
  assert.equal(a?.status, "degraded");
  await rollupUptimeDailyToNeon(sql(), [day], now + 1);
  await rollupFailureReasonsToNeon(sql(), [day], now + 1);
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM surface_uptime_daily")
      .first("n"),
    2,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM surface_failure_daily WHERE netuid IS NULL",
      )
      .first("n"),
    1,
  );
  const read = observationsReadDb(env());
  assert.ok(read);
  assert.equal((await read.query("SELECT * FROM surface_status")).length, 2);
});
test("a failed status update rolls back the raw checks, and a failed rollup restores the previous day", async () => {
  await persistProbesToNeon(sql(), [probe()], now);
  await rollupUptimeDailyToNeon(sql(), [day], now);
  await db
    .prepare(
      "CREATE TRIGGER reject_status BEFORE INSERT ON surface_status WHEN NEW.surface_id='reject' BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  const bad = await persistProbesToNeon(
    sql(),
    [probe("new", "new", now + 1), probe("reject", "reject", now + 1)],
    now,
  );
  assert.equal(bad.ok, false);
  assert.equal(await status("new"), null);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_checks").first("n"),
    1,
  );
  await db.prepare("DROP TRIGGER reject_status").run();
  await db
    .prepare(
      "CREATE TRIGGER reject_rollup BEFORE INSERT ON surface_uptime_daily BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  assert.equal(
    (await rollupUptimeDailyToNeon(sql(), [day], now + 1)).ok,
    false,
  );
  assert.equal(
    await db
      .prepare("SELECT updated_at FROM surface_uptime_daily")
      .first("updated_at"),
    now,
  );
  await db.prepare("DROP TRIGGER reject_rollup").run();
});
test("subnet snapshots preserve nullable flags and provenance, and pruning is scoped", async () => {
  const row = {
    netuid: 1,
    snapshot_date: day.date,
    captured_at: now,
    emission_enabled: false,
    subtoken_enabled: true,
    pipeline_block: 9000000,
    pipeline_block_hash: "hash",
  };
  assert.equal((await upsertSubnetSnapshotsToNeon(sql(), [row])).ok, true);
  assert.equal(
    (
      await upsertSubnetSnapshotsToNeon(sql(), [
        { ...row, emission_enabled: null },
      ])
    ).ok,
    true,
  );
  const actual = await db.prepare("SELECT * FROM subnet_snapshots").first();
  assert.equal(actual?.emission_enabled, null);
  assert.equal(actual?.subtoken_enabled, 1);
  assert.equal(actual?.pipeline_block_hash, "hash");
  assert.equal(
    (await upsertSubnetSnapshotsToNeon(sql(), [])).reason,
    "no_rows",
  );
  await persistProbesToNeon(
    sql(),
    [probe("old", "old", now - 1), probe("new", "new", now)],
    now,
  );
  assert.equal((await pruneChecksNeon(sql(), now)).ok, true);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_checks").first("n"),
    1,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_status").first("n"),
    2,
  );
});
test("hourly rollup and prune entry points select D1 without Hyperdrive or ctx", async () => {
  await persistProbesToNeon(sql(), [probe()], now);
  const outcome = await rollupDailyUptime(env(), { now: () => now });
  assert.equal(outcome.checks_rolled, true);
  await pruneHealthHistory(env(), {
    now: () => now + 2000,
    retentionMs: 1000,
    pruneRawChecks: true,
  });
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_checks").first("n"),
    0,
  );
});
test("missing probe metadata remains null, and oversized captures cannot partially commit", async () => {
  const minimal = { surface_id: "minimal", checked_at_ms: now };
  assert.equal((await persistProbesToNeon(sql(), [minimal], now)).ok, true);
  const actual = await status("minimal");
  for (const name of [
    "surface_key",
    "netuid",
    "kind",
    "status",
    "classification",
    "latency_ms",
    "status_code",
    "last_ok",
  ])
    assert.equal(actual?.[name], null);
  const tooLarge = Array.from({ length: 900 }, (_, i) =>
    probe(`id-${i}`, `key-${i}`),
  );
  const result = await persistProbesToNeon(sql(), tooLarge, now);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /atomic statement budget/);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM surface_checks").first("n"),
    1,
  );
});
test("rollups retain displaced aliases and use the latest subnet identity", async () => {
  await persistProbesToNeon(
    sql(),
    [probe("alias", "old-key", day.start + 1)],
    now,
  );
  await persistProbesToNeon(
    sql(),
    [{ ...probe("alias", "old-key", day.start + 2), netuid: 7 }],
    now,
  );
  await persistProbesToNeon(
    sql(),
    [
      {
        ...probe("alias", "new-key", day.start + 3),
        status: "failed",
        latency_ms: null,
      },
    ],
    now,
  );
  assert.equal((await rollupUptimeDailyToNeon(sql(), [day], now)).ok, true);
  const old = await db
    .prepare("SELECT * FROM surface_uptime_daily WHERE surface_key='old-key'")
    .first();
  assert.equal(old?.surface_id, "history:old-key");
  assert.equal(old?.netuid, 7);
  assert.equal(old?.samples, 2);
  assert.equal(old?.uptime_ratio, 1);
  const current = await db
    .prepare("SELECT * FROM surface_uptime_daily WHERE surface_key='new-key'")
    .first();
  assert.equal(current?.surface_id, "alias");
  assert.equal(current?.status, "failed");
  assert.equal(current?.latency_samples, 0);
  assert.equal(current?.p95_latency_ms, null);
});
