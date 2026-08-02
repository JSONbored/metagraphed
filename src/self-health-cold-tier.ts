// Self-health reads served from the lakehouse when the Postgres tier misses.
//
// ONLY THE DAILY ROLLUP SURVIVES THE BOX, and this tier says so honestly.
// The Postgres route reads two tables: self_health_daily (the never-expired
// 90-day rollup) and self_health_checks (raw ticks, pruned at ~14d, whose
// newest row per component is the "current" reading). With the box gone
// there IS no current reading -- the poller that wrote the ticks died with
// it -- so this tier serves the preserved daily history with an empty
// latest list. buildSelfHealth then reports current_ok:null ("unmeasured",
// deliberately distinct from "down") and the "degraded" verdict floor,
// which is the truthful claim: we cannot assert we are operational from a
// frozen table. Synthesizing a current reading from the last frozen tick
// would violate the probe-derived-only house rule.
//
// THE 90-DAY WINDOW IS FILTERED IN JS, equivalence argued not assumed. The
// Postgres route filters `day >= cutoff` on a native DATE; the lakehouse
// `day` column's exact type is the exporter's choice, and a mistyped SQL
// comparison would fail the whole query. For zero-padded ISO dates the
// filter IS lexicographic string comparison, so applying the identical
// `>=` on the serialized form after fetching this deliberately small,
// frozen table yields the identical row set -- same trade as the events
// tier's single-OR standing in for data-api's two-scan merge.

import { r2SqlQuery } from "./r2-sql.ts";
import { utcWindowCutoffDay } from "./health-serving.ts";
import { buildSelfHealth, type SelfHealthDailyRow } from "./self-health.ts";

/** The exact day::text shape the Postgres route selects. A cell that does
 * not serialize to this cannot be windowed or served faithfully. */
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** One lakehouse row restored to the driver shape the formatter was typed
 * against, or null when it cannot be -- postgres.js hands INTEGER back as a
 * number and `day::text` as a plain string, and buildSelfHealth is a typed
 * pure transform that (correctly) re-validates none of it. */
function restoreDailyRow(
  row: Record<string, unknown>,
): SelfHealthDailyRow | null {
  const checks = Number(row.checks);
  const okCount = Number(row.ok_count);
  if (
    typeof row.day !== "string" ||
    !DAY_SHAPE.test(row.day) ||
    typeof row.component !== "string" ||
    !Number.isFinite(checks) ||
    !Number.isFinite(okCount)
  ) {
    return null;
  }
  return { day: row.day, component: row.component, checks, ok_count: okCount };
}

/**
 * The self-health card from the preserved daily rollup. Returns null when
 * the lakehouse cannot answer (or answers in a shape that cannot be trusted),
 * so the caller keeps its schema-stable empty card.
 */
export async function loadSelfHealthColdTier(
  env: Env | null | undefined,
  nowMs: number = Date.now(),
): Promise<ReturnType<typeof buildSelfHealth> | null> {
  const rows = await r2SqlQuery(
    env,
    // No WHERE: the window filter runs below, on the serialized day (see the
    // header). The table is small by construction -- one row per component
    // per day -- so the full read is cheap and bounded.
    `SELECT day, component, checks, ok_count FROM chain.self_health_daily` +
      ` ORDER BY component, day`,
  );
  if (rows === null) return null;

  // Same inclusive 90-calendar-day floor the Postgres route derives (#8814),
  // compared exactly as `day::text >= cutoff` would compare.
  const cutoff = utcWindowCutoffDay(nowMs, 90);
  const daily: SelfHealthDailyRow[] = [];
  for (const row of rows) {
    const restored = restoreDailyRow(row);
    // One malformed cell declines the whole read: serving a partial series
    // would silently understate uptime, which is worse than the fallback.
    if (restored === null) return null;
    if (restored.day >= cutoff) daily.push(restored);
  }
  return buildSelfHealth(daily, []);
}
