// Measure the whole receiver request, including its 50 serial insert/prune pairs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const NOW = 1790000000000;
const secret = "fixture-packet-health-secret";
const ddl = (name: string) =>
  readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8");
for (const reject of [false, true]) {
  test(`full 50-row packet bounds trigger work with rejected inserts=${reject}`, async () => {
    const runtime = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('fixture')}}",
      compatibilityDate: "2026-06-06",
      d1Databases: ["DB"],
    });
    try {
      const db = await runtime.getD1Database("DB");
      const apply = async (name: string) => {
        for (const sql of ddl(name).split("-- statement-breakpoint"))
          await db.prepare(sql).run();
      };
      await apply("0001_lane_health.sql");
      await db
        .prepare(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<132000)
        INSERT INTO lane_health(lane,verdict,checked_at) SELECT 'packet',CASE WHEN i%3=0 THEN 'stale' WHEN i%3=1 THEN 'ok' ELSE 'unknown' END,?+i*60000 FROM n`,
        )
        .bind(NOW - 132000 * 60000)
        .run();
      await apply("0002_lane_health_current.sql");
      await apply("0003_lane_health_history_indexes.sql");
      if (reject)
        await db
          .prepare(
            "CREATE TRIGGER reject_packet BEFORE INSERT ON lane_health WHEN NEW.lane='packet' BEGIN SELECT RAISE(FAIL,'SQLITE_FULL fixture'); END",
          )
          .run();
      const body = JSON.stringify({
        rows: Array.from({ length: 50 }, () => ({
          lane: "packet",
          verdict: "ok",
          age_ms: 0,
          detail: null,
          checked_at: NOW,
        })),
      });
      const metrics: { sql: string; meta: D1Result["meta"] }[] = [];
      let attempts = 0;
      let failedCalls = 0;
      const wrap = (
        sql: string,
        statement: D1PreparedStatement,
      ): D1PreparedStatement =>
        ({
          bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
          all: async <T>() => {
            attempts++;
            try {
              const result = await statement.all<T>();
              metrics.push({ sql, meta: result.meta });
              return result;
            } catch (error) {
              failedCalls++;
              throw error;
            }
          },
          run: async () => {
            attempts++;
            try {
              const result = await statement.run();
              metrics.push({ sql, meta: result.meta });
              return result;
            } catch (error) {
              failedCalls++;
              throw error;
            }
          },
        }) as D1PreparedStatement;
      const binding = {
        prepare: (sql: string) => wrap(sql, db.prepare(sql)),
        batch: db.batch.bind(db),
      } as D1Database;
      const results: {
        phase: string;
        rows_read: number;
        rows_written: number;
        calls: number;
        duration: number;
      }[] = [];
      for (const phase of ["before", "after"]) {
        if (phase === "after")
          await apply("0043_lane_health_retention_trigger_bounds.sql");
        metrics.length = 0;
        attempts = 0;
        failedCalls = 0;
        const oldCount = await db
          .prepare("SELECT count(*) AS n FROM lane_health")
          .first<number>("n");
        const start = performance.now();
        const response = await worker.fetch(
          new Request(
            "https://fixture/api/v1/internal/poller-lane-health-sync",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-poller-lane-health-sync-token": secret,
              },
              body,
            },
          ),
          dataApiEnv({
            D1_STATE: binding,
            D1_STATE_TABLES: "lane_health",
            D1_EXPORT_REVISIONS: "enabled",
            POLLER_LANE_HEALTH_SYNC_SECRET: secret,
          }),
          { waitUntil() {} } as unknown as ExecutionContext,
        );
        const elapsed = performance.now() - start;
        assert.equal(response.status, reject ? 503 : 200);
        const receipt = (await response.json()) as Record<string, unknown>;
        assert.equal(receipt.lane_health_written, reject ? 0 : 50);
        assert.equal(receipt.lane_health_expected, 50);
        assert.equal(
          receipt.request_sha256,
          createHash("sha256").update(body).digest("hex"),
        );
        const newCount = await db
          .prepare("SELECT count(*) AS n FROM lane_health")
          .first<number>("n");
        assert.equal(
          newCount,
          oldCount! + (reject ? 0 : 50) - 1000,
          "50 bounded sweeps each remove 20 history rows, without replay",
        );
        const sweeps = metrics.filter((r) =>
          r.sql.startsWith("DELETE FROM lane_health"),
        );
        assert.equal(sweeps.length, 50);
        assert.equal(
          metrics.length,
          reject ? 50 : 100,
          "failed calls are not replayed",
        );
        assert.equal(
          attempts,
          100,
          "exactly 50 insertion attempts and 50 housekeeping attempts",
        );
        assert.equal(failedCalls, reject ? 50 : 0);
        const measured = {
          phase,
          attempted_calls: attempts,
          failed_calls_without_metadata: failedCalls,
          metadata_scope: reject
            ? "successful statements only; failed insertion work is not reported by D1"
            : "all request statements",
          rows_read: metrics.reduce((n, r) => n + r.meta.rows_read, 0),
          rows_written: metrics.reduce((n, r) => n + r.meta.rows_written, 0),
          calls: metrics.length,
          duration: elapsed,
        };
        results.push(measured);
        console.info(
          "retention_packet_work",
          JSON.stringify({
            packet_rows: 50,
            rejected: reject,
            direct_deletions: 1000,
            retained_samples: 132000,
            ...measured,
          }),
        );
        if (phase === "after") {
          assert(measured.rows_read <= 50000, JSON.stringify(measured));
          assert(measured.rows_written <= 10000, JSON.stringify(measured));
        }
      }
      assert(results[0].rows_read > results[1].rows_read * 100);
      const current = await db
        .prepare(
          "SELECT verdict,checked_at FROM lane_health_current WHERE lane='packet'",
        )
        .first();
      assert.deepEqual(
        current,
        { verdict: "stale", checked_at: NOW },
        "the existing latest stale tie survives successful ok reports too",
      );
    } finally {
      await runtime.dispose();
    }
  }, 180000);
}
