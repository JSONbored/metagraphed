// The selected D1 owner supplies both daily history and actual probe ticks.
// Unselected deployments retain the historical lakehouse rollup with no
// invented current reading. A selected store failure never revives R2 SQL.

import { createD1Sql, selectedD1Store } from "./d1-store.ts";
import { SELF_HEALTH_TABLES } from "./self-health-store.ts";
import { loadSelfHealthNeon } from "./self-health-neon.ts";
import { r2SqlQuery } from "./r2-sql.ts";
import { utcWindowCutoffDay } from "./health-serving.ts";
import { buildSelfHealth, type SelfHealthDailyRow } from "./self-health.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

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
  env: R2SqlEnv | null | undefined,
  nowMs: number = Date.now(),
): Promise<ReturnType<typeof buildSelfHealth> | null> {
  try {
    const store = selectedD1Store(env, SELF_HEALTH_TABLES);
    if (store) return await loadSelfHealthNeon(createD1Sql(store), () => nowMs);
  } catch {
    return null;
  }
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
