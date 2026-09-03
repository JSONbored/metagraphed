import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import type { SurfaceUptimeDaily } from "../generated/db/types.ts";
import {
  persistProbesToNeon,
  rollupUptimeDailyToNeon,
} from "../src/observations-neon.ts";

let db: PGlite;
const sql = {
  async unsafe(text: string, values: unknown[] = []) {
    return (await db.query(text, values)).rows;
  },
};
const day = { date: "2026-09-03", start: 0, end: 10_000 };
const probe = (id: string, key: string | null, at: number, ok = true) => ({
  surface_id: id,
  surface_key: key,
  netuid: 28,
  kind: "data-artifact",
  status: ok ? "ok" : "failed",
  classification: ok ? "success" : "timeout",
  checked_at_ms: at,
  last_ok_ms: ok ? at : null,
  latency_ms: ok ? 10 : 100,
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    fs.readFileSync("migrations/neon/0002_probe_observations.sql", "utf8"),
  );
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec(
    "TRUNCATE surface_checks, surface_status, surface_uptime_daily",
  );
});

test("an occupied alias can be reassigned without losing stable-key last_ok or checks", async () => {
  assert.equal(
    (
      await persistProbesToNeon(
        sql,
        [probe("old", "key-a", 100), probe("new", "key-b", 100)],
        100,
      )
    ).ok,
    true,
  );
  assert.equal(
    (await persistProbesToNeon(sql, [probe("new", "key-a", 200, false)], 200))
      .ok,
    true,
  );
  const status = (
    await db.query(
      "SELECT surface_id,surface_key,last_ok FROM surface_status WHERE surface_key='key-a'",
    )
  ).rows;
  assert.deepEqual(status, [
    { surface_id: "new", surface_key: "key-a", last_ok: 100 },
  ]);
  assert.equal(
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int n FROM surface_checks",
      )
    ).rows[0]!.n,
    3,
  );
});

test("swapping display aliases and replaying a sweep preserves both current identities", async () => {
  await persistProbesToNeon(
    sql,
    [probe("one", "key-a", 100), probe("two", "key-b", 100)],
    100,
  );
  const changed = [probe("two", "key-a", 200), probe("one", "key-b", 200)];
  for (let i = 0; i < 2; i++)
    assert.equal((await persistProbesToNeon(sql, changed, 200)).ok, true);
  assert.deepEqual(
    (
      await db.query(
        "SELECT surface_id,surface_key FROM surface_status ORDER BY surface_key",
      )
    ).rows,
    [
      { surface_id: "two", surface_key: "key-a" },
      { surface_id: "one", surface_key: "key-b" },
    ],
  );
  assert.equal(
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int n FROM surface_checks",
      )
    ).rows[0]!.n,
    4,
  );
});

test("an older rename cannot evict the other key currently holding its requested alias", async () => {
  await persistProbesToNeon(
    sql,
    [probe("current", "key-a", 300), probe("occupied", "key-b", 100)],
    300,
  );
  assert.equal(
    (await persistProbesToNeon(sql, [probe("occupied", "key-a", 200)], 400)).ok,
    true,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT surface_id,surface_key FROM surface_status ORDER BY surface_key",
      )
    ).rows,
    [
      { surface_id: "current", surface_key: "key-a" },
      { surface_id: "occupied", surface_key: "key-b" },
    ],
  );
});

test("last_ok never moves backwards when a new failed probe carries an older cached success", async () => {
  await persistProbesToNeon(sql, [probe("current", "key-a", 300)], 300);
  await persistProbesToNeon(
    sql,
    [{ ...probe("current", "key-a", 400, false), last_ok_ms: 100 }],
    400,
  );
  assert.deepEqual(
    (await db.query("SELECT last_checked,last_ok,status FROM surface_status"))
      .rows,
    [{ last_checked: 400, last_ok: 300, status: "failed" }],
  );
});

test("a rejected status update rolls back alias eviction while keeping the measured check", async () => {
  await persistProbesToNeon(
    sql,
    [probe("old", "key-a", 100), probe("new", "key-b", 100)],
    100,
  );
  const previous = (
    await db.query("SELECT * FROM surface_status ORDER BY surface_key")
  ).rows;
  await db.exec(
    "ALTER TABLE surface_status ADD CONSTRAINT test_provider CHECK (provider <> 'reject')",
  );
  try {
    assert.equal(
      (
        await persistProbesToNeon(
          sql,
          [{ ...probe("new", "key-a", 200), provider: "reject" }],
          200,
        )
      ).ok,
      false,
    );
    assert.deepEqual(
      (await db.query("SELECT * FROM surface_status ORDER BY surface_key"))
        .rows,
      previous,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM surface_checks",
        )
      ).rows[0]!.n,
      3,
    );
  } finally {
    await db.exec("ALTER TABLE surface_status DROP CONSTRAINT test_provider");
  }
});

test("older probes preserve a newer identity and status, including keyless delivery", async () => {
  await persistProbesToNeon(sql, [probe("new", "key-a", 300)], 300);
  await persistProbesToNeon(sql, [probe("new", "key-a", 200, false)], 400);
  await persistProbesToNeon(sql, [probe("new", "key-b", 100)], 500);
  await persistProbesToNeon(sql, [probe("plain", null, 300)], 300);
  await persistProbesToNeon(sql, [probe("plain", null, 200, false)], 400);
  assert.deepEqual(
    (
      await db.query(
        "SELECT surface_id,surface_key,status,last_checked,last_ok FROM surface_status ORDER BY surface_id",
      )
    ).rows,
    [
      {
        surface_id: "new",
        surface_key: "key-a",
        status: "ok",
        last_checked: 300,
        last_ok: 300,
      },
      {
        surface_id: "plain",
        surface_key: null,
        status: "ok",
        last_checked: 300,
        last_ok: 300,
      },
    ],
  );
});

test("reused display aliases roll up into distinct stable identities without duplicate samples", async () => {
  await persistProbesToNeon(sql, [probe("shared", "key-a", 100)], 100);
  await persistProbesToNeon(sql, [probe("shared", "key-b", 200, false)], 200);
  for (const runAt of [300, 400])
    assert.equal((await rollupUptimeDailyToNeon(sql, [day], runAt)).ok, true);
  const rows = (
    await db.query<
      Pick<
        SurfaceUptimeDaily,
        | "surface_id"
        | "surface_key"
        | "samples"
        | "ok_count"
        | "latency_samples"
      >
    >(
      "SELECT surface_id,surface_key,samples,ok_count,latency_samples FROM surface_uptime_daily ORDER BY surface_key",
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.surface_id)).size, 2);
  assert.deepEqual(
    rows.map(({ surface_id: _, ...r }) => r),
    [
      { surface_key: "key-a", samples: 1, ok_count: 1, latency_samples: 1 },
      { surface_key: "key-b", samples: 1, ok_count: 0, latency_samples: 0 },
    ],
  );
  assert.equal(rows[1]!.surface_id, "shared");
});

test("daily identity follows the latest alias and metadata while retaining all measurements", async () => {
  await persistProbesToNeon(sql, [probe("z-old", "key-a", 100)], 100);
  await persistProbesToNeon(
    sql,
    [{ ...probe("a-new", "key-a", 200, false), netuid: null }],
    200,
  );
  assert.equal((await rollupUptimeDailyToNeon(sql, [day], 300)).ok, true);
  assert.deepEqual(
    (
      await db.query(
        "SELECT surface_id,surface_key,netuid,samples,ok_count,uptime_ratio,latency_samples,p50_latency_ms FROM surface_uptime_daily",
      )
    ).rows,
    [
      {
        surface_id: "a-new",
        surface_key: "key-a",
        netuid: null,
        samples: 2,
        ok_count: 1,
        uptime_ratio: 0.5,
        latency_samples: 1,
        p50_latency_ms: 10,
      },
    ],
  );
});

test("a failed recomputation preserves the previous day atomically and leaves other days untouched", async () => {
  await persistProbesToNeon(sql, [probe("plain", null, 100)], 100);
  assert.equal(
    (
      await rollupUptimeDailyToNeon(
        sql,
        [day, { ...day, date: "2026-09-02" }],
        200,
      )
    ).ok,
    true,
  );
  const previous = (
    await db.query("SELECT * FROM surface_uptime_daily ORDER BY day")
  ).rows;
  await persistProbesToNeon(sql, [probe("plain", null, 300)], 300);
  await db.exec(
    "ALTER TABLE surface_uptime_daily ADD CONSTRAINT test_samples CHECK (samples < 2)",
  );
  try {
    assert.equal((await rollupUptimeDailyToNeon(sql, [day], 400)).ok, false);
    assert.deepEqual(
      (await db.query("SELECT * FROM surface_uptime_daily ORDER BY day")).rows,
      previous,
    );
  } finally {
    await db.exec(
      "ALTER TABLE surface_uptime_daily DROP CONSTRAINT test_samples",
    );
  }
  assert.equal((await rollupUptimeDailyToNeon(sql, [day], 500)).ok, true);
  assert.deepEqual(
    (
      await db.query(
        "SELECT day,samples FROM surface_uptime_daily ORDER BY day",
      )
    ).rows,
    [
      { day: "2026-09-02", samples: 1 },
      { day: "2026-09-03", samples: 2 },
    ],
  );
});
