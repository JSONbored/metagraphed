// Measure real SQLite trigger work on disposable D1 databases in native CI.
// A direct-row cap does not bound the existing per-row projection scans.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import { recordLaneVerdict } from "../src/lane-health.ts";
import {
  captureSubnetBurnHistory,
  BURN_HISTORY_PRUNE_MAX_ROWS,
  BURN_HISTORY_RETENTION_MS,
} from "../src/subnet-burn-history.ts";

const NOW = 1790000000000;
const ddl = (name: string) =>
  readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8");
const freshRuntime = () =>
  new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });

for (const samples of [10000, 130000]) {
  test(`lane retention measures ${samples} retained samples with all native projection triggers`, async () => {
    const runtime = freshRuntime();
    try {
      const db = await runtime.getD1Database("DB");
      // Seed before installing projections, then apply their real migrations.
      // 10k covers 104 days at 15m; 130k covers 90.3 days at 1m.
      // Both include an expired backlog and end at NOW, without future rows.
      const tickMs = samples === 10000 ? 900000 : 60000;
      for (const sql of ddl("0001_lane_health.sql").split(
        "-- statement-breakpoint",
      ))
        await db.prepare(sql).run();
      await db
        .prepare(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO lane_health(lane,verdict,checked_at)
        SELECT 'budget',CASE WHEN i%3=0 THEN 'stale' WHEN i%3=1 THEN 'ok' ELSE 'unknown' END,?+i*? FROM n`,
        )
        .bind(samples, NOW - samples * tickMs, tickMs)
        .run();
      for (const name of [
        "0002_lane_health_current.sql",
        "0003_lane_health_history_indexes.sql",
      ])
        for (const sql of ddl(name).split("-- statement-breakpoint"))
          await db.prepare(sql).run();
      const store = createD1Store(db);
      let pruneSql = "";
      let pruneValues: unknown[] = [];
      let meta: D1Result["meta"] | undefined;
      assert.equal(
        await recordLaneVerdict(
          {
            ...store,
            query: async () => {
              throw new Error("capacity fixture");
            },
            run: async (sql, values = []) => {
              pruneSql = sql;
              pruneValues = values;
              const result = await db
                .prepare(sql)
                .bind(...values)
                .run();
              meta = result.meta;
              return { changes: result.meta.changes };
            },
          },
          {
            lane: "budget",
            verdict: "stale",
            age_ms: null,
            detail: null,
            checked_at: NOW,
          },
          { confirm: true },
        ),
        false,
      );
      assert(meta);
      assert.equal(
        meta.changes,
        200,
        "direct delete work is capped, despite the insertion failure",
      );
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${pruneSql}`)
        .bind(...pruneValues)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join("\n");
      assert.match(details, /idx_lane_health_lane_checked/);
      assert.doesNotMatch(details, /USE TEMP B-TREE/);
      // Explicitly budget trigger amplification for the measured fixture size.
      // This is not a claim that trigger reads are independent of history size.
      assert(meta.rows_read <= 200 * (samples * 3 + 100), JSON.stringify(meta));
      assert(meta.rows_written <= 200 * 20, JSON.stringify(meta));
      console.info(
        "retention_work",
        JSON.stringify({
          family: "lane_health",
          samples,
          direct_limit: 200,
          ...meta,
        }),
      );
      assert.equal(
        (await store.first<{ n: number }>(
          "SELECT count(*) AS n FROM lane_health WHERE lane='budget'",
        ))!.n,
        samples - 200,
      );
      const mismatch = await store.first<{
        n: number;
      }>(`SELECT count(*) AS n FROM (
        SELECT checked_at,previous_at,LAG(checked_at) OVER(ORDER BY checked_at) AS expected FROM lane_health_clocks WHERE lane='budget') WHERE previous_at IS NOT expected`);
      assert.equal(mismatch!.n, 0);
    } finally {
      await runtime.dispose();
    }
  }, 120000);
}

test("an expired latest-timestamp tie pile needs only an indexed range seek", async () => {
  const runtime = freshRuntime();
  try {
    const db = await runtime.getD1Database("DB");
    for (const sql of ddl("0001_lane_health.sql").split(
      "-- statement-breakpoint",
    ))
      await db.prepare(sql).run();
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO lane_health(lane,verdict,checked_at) SELECT 'ties','stale',1 FROM n`,
      )
      .run();
    const store = createD1Store(db);
    let reads = 0;
    assert.equal(
      await recordLaneVerdict(
        {
          ...store,
          query: async () => {
            throw new Error("refused");
          },
          run: async (sql, values = []) => {
            const result = await db
              .prepare(sql)
              .bind(...values)
              .run();
            reads = result.meta.rows_read;
            assert.equal(result.meta.changes, 0);
            return { changes: 0 };
          },
        },
        {
          lane: "ties",
          verdict: "ok",
          age_ms: null,
          detail: null,
          checked_at: NOW,
        },
        { confirm: true },
      ),
      false,
    );
    assert(reads < 20, `latest ties scanned ${reads} rows`);
    assert.equal(
      (await store.first<{ n: number }>(
        "SELECT count(*) AS n FROM lane_health WHERE lane='ties'",
      ))!.n,
      10000,
    );
    console.info(
      "retention_work",
      JSON.stringify({
        family: "lane_health",
        case: "all-latest-ties",
        samples: 10000,
        rows_read: reads,
        changes: 0,
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

test("burn expiry keeps up with 396-row captures against a 380k-row fixture", async () => {
  const runtime = freshRuntime();
  try {
    const db = await runtime.getD1Database("DB");
    for (const sql of ddl("0009_subnet_identity_state.sql").split(
      "-- statement-breakpoint",
    ))
      if (
        /CREATE TABLE subnet_burn_history\(|CREATE INDEX idx_subnet_burn_history_observed/.test(
          sql,
        )
      )
        await db.prepare(sql).run();
    const cutoff = NOW - BURN_HISTORY_RETENTION_MS;
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<395),t(j) AS (VALUES(0) UNION ALL SELECT j+1 FROM t WHERE j<959)
      INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao) SELECT i,?+(j-8)*900000,1 FROM n CROSS JOIN t`,
      )
      .bind(cutoff)
      .run();
    const store = createD1Store(db);
    const metrics: D1Result["meta"][] = [];
    let sweepSql = "";
    let sweepValues: unknown[] = [];
    let stamp = NOW;
    for (let tick = 0; tick < 2; tick++) {
      const result = await captureSubnetBurnHistory({} as never, {
        db: {
          ...store,
          run: async (sql, values = []) => {
            sweepSql = sql;
            sweepValues = values;
            const r = await db
              .prepare(sql)
              .bind(...values)
              .run();
            metrics.push(r.meta);
            return { changes: r.meta.changes };
          },
        },
        now: () => stamp,
        load: (async () => ({
          schema_version: 1,
          subnets: Array.from({ length: 396 }, (_, netuid) => ({
            netuid,
            burn_tao: 1,
          })),
        })) as never,
      });
      assert.equal(result.ok, true);
      assert.equal(result.captured, 396);
      assert.equal(result.pruned, true);
      stamp += 900000;
    }
    for (const meta of metrics) {
      assert(meta.changes <= BURN_HISTORY_PRUNE_MAX_ROWS);
      assert(
        meta.changes > 396,
        "expiry drains faster than the qualified input rate",
      );
      assert(
        meta.rows_read <= BURN_HISTORY_PRUNE_MAX_ROWS * 5,
        JSON.stringify(meta),
      );
      assert(
        meta.rows_written <= BURN_HISTORY_PRUNE_MAX_ROWS * 4,
        JSON.stringify(meta),
      );
      console.info(
        "retention_work",
        JSON.stringify({
          family: "subnet_burn_history",
          samples: 396 * 960,
          capture_rows: 396,
          direct_limit: BURN_HISTORY_PRUNE_MAX_ROWS,
          ...meta,
        }),
      );
    }
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${sweepSql}`)
      .bind(...sweepValues)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    assert.match(details, /idx_subnet_burn_history_observed/);
    assert.doesNotMatch(details, /USE TEMP B-TREE/);
    assert.equal(
      (await store.first<{ n: number }>(
        "SELECT count(*) AS n FROM subnet_burn_history WHERE observed_at=?",
        [cutoff + 900000],
      ))!.n,
      396,
      "the strict cutoff survives both sweeps",
    );
  } finally {
    await runtime.dispose();
  }
}, 120000);
