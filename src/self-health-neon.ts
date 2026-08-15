// Self-health served from Neon, where the prober now writes (#9836).
//
// ORDER OF TIERS, and why this one goes first. The route tried the box's
// Postgres tier (gone since #9193), then the lakehouse cold tier -- which holds
// a FROZEN copy of the daily rollup ending 2026-08-02 and no ticks at all. That
// fallback stays, because those 90 days are real history nothing else has, but
// it must be asked SECOND: it can only ever answer `current_ok: null`, and once
// the prober is running there is a current reading to give.
//
// TWO QUERIES, NOT A JOIN. `days` is a 90-day window over the rollup and
// `latest` is one row per component from the ticks; joining them would multiply
// the daily rows by the tick count. They also have different retentions, which
// is the whole reason they are separate tables.
import { utcWindowCutoffDay } from "./health-serving.ts";
import {
  buildSelfHealth,
  type SelfHealthDailyRow,
  type SelfHealthLatestRow,
} from "./self-health.ts";
import type { PgSql } from "./pg-sql.ts";

/** The window /api/v1/self-health publishes. */
export const SELF_HEALTH_WINDOW_DAYS = 90;

/**
 * The self-health payload from Neon, or null when it holds no rollup at all.
 *
 * Null rather than an empty payload, so the caller falls through to the
 * lakehouse's preserved history instead of publishing an empty 90 days over the
 * top of it. An empty rollup with live ticks is not a state that occurs: the
 * prober writes both in the same tick.
 */
export async function loadSelfHealthNeon(
  sql: PgSql | null | undefined,
  now: () => number = Date.now,
): Promise<ReturnType<typeof buildSelfHealth> | null> {
  if (!sql?.unsafe) return null;
  const cutoff = utcWindowCutoffDay(now(), SELF_HEALTH_WINDOW_DAYS);
  try {
    // The type parameter at the READ, not a cast after it (#10261's shape).
    // `validate:untyped-db-reads` counts reads that say
    // `Record<string, unknown>`; a post-hoc `as unknown as` was invisible to
    // that ratchet while making exactly the claim it exists to measure.
    const daily = await sql.unsafe<SelfHealthDailyRow>(
      `SELECT day::text AS day, component, checks, ok_count
         FROM self_health_daily
        WHERE day >= $1::date
        ORDER BY day ASC`,
      [cutoff],
    );
    if (!Array.isArray(daily) || daily.length === 0) return null;

    // DISTINCT ON is the newest tick per component -- the reading the route
    // publishes as `current`. A plain MAX(checked_at_ms) would give the
    // timestamp without the ok/status/latency that go with it.
    const latest = await sql.unsafe<SelfHealthLatestRow>(
      `SELECT DISTINCT ON (component)
              component, ok, http_status, latency_ms, checked_at_ms
         FROM self_health_checks
        ORDER BY component, checked_at_ms DESC`,
      [],
    );

    return buildSelfHealth(daily, Array.isArray(latest) ? latest : []);
  } catch (err) {
    // A failed read falls through to the lakehouse rather than failing the
    // route: stale history is a better answer than none, and the tier that
    // answered is visible in the payload's own shape.
    console.error("[self-health-neon] read failed:", err);
    return null;
  }
}
