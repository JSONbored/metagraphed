// Execute the real retention SQL against both owners. Capacity/ack failures are
// injected at the writer boundary; only disposable native CI databases are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, test } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import { laneHealthStore, pgLaneHealthDb } from "../src/lane-health-store.ts";
import {
  recordLaneVerdict,
  loadLatestLaneHealth,
  LANE_HEALTH_RETENTION_MS,
} from "../src/lane-health.ts";
import {
  captureSubnetBurnHistory,
  BURN_HISTORY_PRUNE_MAX_ROWS,
} from "../src/subnet-burn-history.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

const NOW = 1790000000000;
const cutoff = NOW - LANE_HEALTH_RETENTION_MS;
const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const pg = new PGlite();
const verdict = (lane: string) => ({
  lane,
  verdict: "ok" as const,
  age_ms: null,
  detail: null,
  checked_at: NOW,
});
const burn = (netuids: number[]) => async () => ({
  schema_version: 1,
  subnets: netuids.map((netuid) => ({ netuid, burn_tao: 1 })),
});

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const name of [
    "0001_lane_health.sql",
    "0002_lane_health_current.sql",
    "0003_lane_health_history_indexes.sql",
    "0039_lane_health_retention_trigger_bounds.sql",
  ]) {
    for (const sql of migration(`d1/${name}`).split("-- statement-breakpoint"))
      await db.prepare(sql).run();
  }
  for (const sql of migration("d1/0009_subnet_identity_state.sql").split(
    "-- statement-breakpoint",
  )) {
    if (
      /CREATE TABLE subnet_burn_history\(|CREATE INDEX idx_subnet_burn_history_observed/.test(
        sql,
      )
    )
      await db.prepare(sql).run();
  }
  await pg.exec(migration("neon/0006_lane_health.sql"));
  const burnDdl = migration("neon/0003_append_only_histories.sql");
  await pg.exec(
    burnDdl.slice(
      burnDdl.indexOf("CREATE TABLE IF NOT EXISTS subnet_burn_history"),
      burnDdl.indexOf(
        "--",
        burnDdl.indexOf("ON subnet_burn_history (observed_at)"),
      ),
    ),
  );
});
afterAll(async () => {
  await runtime.dispose();
  await pg.close();
});

const d1Store = () => createD1Store(db);
const pgHealth = () =>
  pgLaneHealthDb("postgresql://example/db", {
    clientFactory: () => ({
      connect: async () => {},
      end: async () => {},
      query: async (text, values) => pg.query(text, values),
    }),
  });

test("failed D1 verdicts expire at most 20 rows while preserving the last severity ties and projections", async () => {
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<45)
    INSERT INTO lane_health(lane,verdict,checked_at) SELECT 'failed','ok',?-i FROM n`,
    )
    .bind(cutoff - 1)
    .run();
  await db
    .prepare(
      "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('failed','ok',?),('failed','stale',?),('other','stale',?)",
    )
    .bind(cutoff - 1, cutoff - 1, cutoff - 999)
    .run();
  await db
    .prepare(
      "CREATE TRIGGER refuse_health BEFORE INSERT ON lane_health WHEN NEW.lane='failed' BEGIN SELECT RAISE(FAIL,'SQLITE_FULL fixture'); END",
    )
    .run();
  try {
    const store = laneHealthStore({
      D1_STATE: db,
      D1_STATE_TABLES: "lane_health",
    })!;
    for (const remaining of [27, 7, 2, 2]) {
      assert.equal(
        await recordLaneVerdict(store, verdict("failed"), { confirm: true }),
        false,
      );
      assert.equal(
        (await db
          .prepare("SELECT count(*) AS n FROM lane_health WHERE lane='failed'")
          .first<{ n: number }>())!.n,
        remaining,
      );
      const latest = await loadLatestLaneHealth(store);
      assert.equal(latest.failed.verdict, "stale");
      assert.equal(latest.failed.checked_at, cutoff - 1);
    }
    const rows = await db
      .prepare(
        "SELECT verdict,checked_at FROM lane_health WHERE lane='failed' ORDER BY verdict",
      )
      .all();
    assert.deepEqual(rows.results, [
      { verdict: "ok", checked_at: cutoff - 1 },
      { verdict: "stale", checked_at: cutoff - 1 },
    ]);
    assert.equal(
      (await db
        .prepare("SELECT count(*) AS n FROM lane_health WHERE lane='other'")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT checked_at,occurrences,previous_at FROM lane_health_clocks WHERE lane='failed'",
          )
          .all()
      ).results,
      [{ checked_at: cutoff - 1, occurrences: 2, previous_at: null }],
    );
    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT verdict,checked_at FROM lane_health_verdict_latest WHERE lane='failed' ORDER BY verdict",
          )
          .all()
      ).results,
      rows.results,
    );
  } finally {
    await db.prepare("DROP TRIGGER refuse_health").run();
  }
});

test("lost verdict acknowledgement does not replay and cleanup retains the strict cutoff", async () => {
  const store = d1Store();
  await store.run(
    "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('lost','stale',?),('lost','unknown',?),('lost','ok',?)",
    [cutoff - 1, cutoff, cutoff + 1],
  );
  let attempts = 0;
  const failures: string[] = [];
  assert.equal(
    await recordLaneVerdict(
      {
        ...store,
        query: async (sql, values) => {
          attempts++;
          await store.query(sql, values);
          throw new Error("lost reply");
        },
      },
      verdict("lost"),
      { confirm: true, onFailure: (reason) => failures.push(reason) },
    ),
    false,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(failures, ["insert_error"]);
  assert.deepEqual(
    await store.query(
      "SELECT checked_at FROM lane_health WHERE lane='lost' ORDER BY checked_at",
    ),
    [{ checked_at: cutoff }, { checked_at: cutoff + 1 }, { checked_at: NOW }],
  );
});

test("PostgreSQL uses a statement-local ctid and retains all latest ties after rejection", async () => {
  await pg.query(
    "INSERT INTO lane_health(lane,verdict,checked_at) SELECT 'pg-failed','ok',$1::bigint-i FROM generate_series(1,25) i",
    [cutoff - 1],
  );
  await pg.query(
    "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('pg-failed','ok',$1),('pg-failed','stale',$1),('pg-boundary','unknown',$2)",
    [cutoff - 1, cutoff],
  );
  const store = pgHealth();
  let attempts = 0;
  const failed = {
    ...store,
    query: async () => {
      attempts++;
      throw new Error("full");
    },
  };
  assert.equal(
    await recordLaneVerdict(failed, verdict("pg-failed"), { confirm: true }),
    false,
  );
  assert.equal(
    (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM lane_health WHERE lane='pg-failed'",
      )
    ).rows[0].n,
    7,
  );
  assert.equal(
    await recordLaneVerdict(failed, verdict("pg-failed"), { confirm: true }),
    false,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(
    (
      await pg.query(
        "SELECT verdict,checked_at::text FROM lane_health WHERE lane='pg-failed' ORDER BY verdict",
      )
    ).rows,
    [
      { verdict: "ok", checked_at: String(cutoff - 1) },
      { verdict: "stale", checked_at: String(cutoff - 1) },
    ],
  );
  assert.equal(
    await recordLaneVerdict(store, verdict("pg-boundary"), { confirm: true }),
    true,
  );
  assert.equal(
    (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM lane_health WHERE lane='pg-boundary'",
      )
    ).rows[0].n,
    2,
  );
});

test("failed burn transaction is atomic, expires only the bounded old slice and never replays", async () => {
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao) SELECT 1,?-i,1 FROM n`,
    )
    .bind(BURN_HISTORY_PRUNE_MAX_ROWS, cutoff - 1)
    .run();
  await db
    .prepare("INSERT INTO subnet_burn_history VALUES (1,?,0),(1,?,2)")
    .bind(cutoff, cutoff + 1)
    .run();
  await db
    .prepare(
      "CREATE TRIGGER refuse_burn BEFORE INSERT ON subnet_burn_history WHEN NEW.netuid=9999 BEGIN SELECT RAISE(FAIL,'refuse capture'); END",
    )
    .run();
  try {
    const store = d1Store();
    let attempts = 0;
    const result = await captureSubnetBurnHistory({} as never, {
      db: {
        ...store,
        transaction: async (statements) => {
          attempts++;
          return store.transaction(statements);
        },
      },
      now: () => NOW,
      load: burn([1, 9999]) as never,
    });
    assert.equal(attempts, 1);
    assert.equal(result.ok, false);
    assert.equal(result.captured, 0);
    assert.equal(result.pruned, true);
    assert.match(result.reason!, /^write_failed:/);
    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT observed_at,burn_tao FROM subnet_burn_history WHERE netuid=1 ORDER BY observed_at",
          )
          .all()
      ).results,
      [
        { observed_at: cutoff - 1, burn_tao: 1 },
        { observed_at: cutoff, burn_tao: 0 },
        { observed_at: cutoff + 1, burn_tao: 2 },
      ],
    );
    assert.equal(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM subnet_burn_history WHERE observed_at=?",
        )
        .bind(NOW)
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await db.prepare("DROP TRIGGER refuse_burn").run();
  }
});

test("PostgreSQL burn cleanup survives a lost commit reply and keeps capture unconfirmed", async () => {
  await pg.query(
    "INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao) SELECT 1,$1::bigint-i,1 FROM generate_series(1,2100) i",
    [cutoff],
  );
  let attempts = 0;
  const result = await captureSubnetBurnHistory({} as never, {
    db: {
      run: async (sql, values) => ({
        changes:
          (await pg.query(toPositionalPlaceholders(sql), values))
            .affectedRows ?? 0,
      }),
      transaction: async (statements) => {
        attempts++;
        await pg.transaction(async (tx) => {
          for (const statement of statements)
            await tx.query(
              toPositionalPlaceholders(statement.text),
              statement.values,
            );
        });
        throw new Error("lost commit reply");
      },
    },
    now: () => NOW,
    load: burn([1]) as never,
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.captured, 0);
  assert.equal(result.pruned, true);
  assert.equal(
    (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM subnet_burn_history WHERE observed_at<$1",
        [cutoff],
      )
    ).rows[0].n,
    100,
  );
  assert.equal(
    (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM subnet_burn_history WHERE observed_at=$1",
        [NOW],
      )
    ).rows[0].n,
    1,
  );
});

test("PostgreSQL packet confirms only exact replies across 50 attempts without replay", async () => {
  await pg.query(
    "INSERT INTO lane_health(lane,verdict,checked_at) SELECT 'pg-packet','stale',$1::bigint-i FROM generate_series(1,45) i",
    [cutoff],
  );
  const native = pgHealth();
  let attempts = 0;
  let cleanups = 0;
  let confirmed = 0;
  const store = {
    ...native,
    query: async (sql: string, values?: unknown[]) => {
      attempts++;
      if (attempts > 26) throw new Error("rejected before commit");
      const rows = await native.query(sql, values);
      if (attempts === 26) throw new Error("lost committed reply");
      return rows;
    },
    run: async (sql: string, values?: unknown[]) => {
      cleanups++;
      return native.run(sql, values);
    },
  };
  for (let i = 0; i < 50; i++)
    if (await recordLaneVerdict(store, verdict("pg-packet"), { confirm: true }))
      confirmed++;
  assert.equal(confirmed, 25);
  assert.equal(attempts, 50);
  assert.equal(cleanups, 50);
  assert.equal(
    (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM lane_health WHERE lane='pg-packet' AND checked_at=$1",
        [NOW],
      )
    ).rows[0].n,
    26,
  );
  assert.equal(
    (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM lane_health WHERE lane='pg-packet' AND checked_at<$1",
        [cutoff],
      )
    ).rows[0].n,
    0,
  );
});
