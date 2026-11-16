import type { LaneHealthDb } from "./lane-health.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";

const readiness = `SELECT COUNT(*) = 4 AND bool_and(tgenabled IN ('O', 'A')) AS ready
  FROM pg_catalog.pg_trigger
  WHERE NOT tgisinternal AND (
    (tgrelid = to_regclass('app.lane_health') AND tgname IN ('lane_health_lock', 'lane_health_identity', 'lane_health_maintain')) OR
    (tgrelid = to_regclass('app.lane_health_clocks') AND tgname = 'lane_health_clock_gap')
  )`;

/** The native lane family shares its process pool and retains the existing SQL
 * entry points. Schema selection belongs to this lease, never the next caller. */
export function createPgLaneHealth(
  runtime: Pick<PgStoreRuntime, "transaction">,
): LaneHealthDb {
  const withStore = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
    runtime.transaction(async (tx) => {
      await tx.run("SET LOCAL search_path = app, pg_catalog, pg_temp");
      if (!(await tx.first<{ ready: boolean }>(readiness))?.ready) {
        throw new Error("Lane-health PostgreSQL projection is not activated");
      }
      return operation(tx);
    });
  return {
    historyRowId: "source_row_id",
    retentionReady: () =>
      runtime.transaction(async (tx) =>
        Boolean((await tx.first<{ ready: boolean }>(readiness))?.ready),
      ),
    query: (text, values = []) => withStore((tx) => tx.query(text, values)),
    run: (text, values = []) => withStore((tx) => tx.run(text, values)),
    latest: () =>
      withStore((tx) =>
        tx.query(
          "SELECT lane, verdict, age_ms, detail, checked_at FROM lane_health_current",
        ),
      ),
    maxGaps: (sinceMs, minimumSamples) =>
      withStore((tx) =>
        tx.query(
          `SELECT lane, sampled - 1 AS n, max_gap::double precision AS max_gap FROM (
        SELECT c.lane,
          (SELECT COUNT(*) FROM (SELECT 1 FROM lane_health h
            WHERE h.lane = c.lane AND h.checked_at > ? LIMIT ?) AS samples) AS sampled,
          (SELECT gap FROM lane_health_clocks g WHERE g.lane = c.lane
            AND g.previous_at > ? ORDER BY gap DESC NULLS LAST, checked_at DESC LIMIT 1) AS max_gap
        FROM lane_health_current c
      ) AS cadence WHERE sampled > 1`,
          [sinceMs, minimumSamples, sinceMs],
        ),
      ),
    verdictRuns: (verdict) =>
      withStore((tx) =>
        tx.query(
          `SELECT h.lane, MIN(h.checked_at) AS since, COUNT(*) AS ticks
        FROM lane_health_verdict_latest c JOIN lane_health h
          ON h.lane = c.lane AND h.verdict = c.verdict
          AND h.checked_at > COALESCE((SELECT MAX(x.checked_at)
            FROM lane_health_verdict_latest x
            WHERE x.lane = c.lane AND x.verdict <> c.verdict), 0)
        WHERE c.verdict = ? GROUP BY h.lane`,
          [verdict],
        ),
      ),
  };
}
