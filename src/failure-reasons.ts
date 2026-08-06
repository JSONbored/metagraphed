// GET /api/v1/health/failure-reasons (#9622): WHY surfaces fail, and whether
// the mix is changing.
//
// `surface_checks.classification` is the only record of why a probe failed --
// live, transient, rate-limited, redirected, dead, timeout, content-mismatch,
// unsupported, auth-required, across 1,263,089 checks measured 2026-08-06 --
// and nothing served that distribution. /health/history/{date} accepts
// ?classification= as a FILTER over a dated snapshot ("which surfaces were dead
// on day D"), which is a different question from "why are surfaces failing".
//
// ## THIS READS THE ROLLUP, NOT THE RAW TABLE, AND THAT IS THE POINT
//
// The raw table is pruned at 30 days and its reasons were going nowhere: the
// existing daily rollup keeps samples/ok_count/uptime_ratio and NO
// classification, so it records the rate of failure and discards the reason.
// 0025 adds surface_failure_daily and backfills it, so this route is both cheap
// (7,312 rows for 26 days, against a 7-day raw GROUP BY that reads 955,783 rows
// in 1.14s) and no longer capped at the retention window.
//
// ## `live` IS IN THE MIX BECAUSE A RATE NEEDS ITS DENOMINATOR
//
// The rollup counts successful probes too. Serving only the failures would give
// a caller counts with no scale -- 400 timeouts is a different story against
// 500 checks than against 500,000 -- and a caller who fetched the total
// separately would be free to pair it with a different window. `share` is
// computed against every check in the same window, and `failure_share` against
// the failing ones only, so both questions are answered without either being
// reconstructed from the other.
//
// ## THE DEPTH IS PUBLISHED
//
// The rollup begins where the raw window did when 0025 ran, so a wide window
// returns everything that exists rather than what was asked for.
// `oldest_day`/`newest_day` say what was actually covered, and `days_covered`
// is counted from the rows rather than from the requested window -- a day the
// prober did not run is absent, not zero.

import {
  FAILURE_REASONS_WINDOW_DAYS,
  FAILURE_REASONS_WINDOWS,
} from "./route-limits.ts";

export { FAILURE_REASONS_WINDOW_DAYS, FAILURE_REASONS_WINDOWS };

type Row = Record<string, unknown>;

export interface FailureReasonsDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

export const FAILURE_REASONS_TABLE = "surface_failure_daily";

/**
 * The classifications a probe can carry, from health-probe-core's own
 * vocabulary.
 *
 * Published as an enum rather than passed through, for the reason knownAction
 * exists in src/surface-history.ts: an unrecognised string would either break a
 * typed client or teach a consumer a vocabulary this API does not define.
 */
export const FAILURE_CLASSIFICATIONS = [
  "live",
  "redirected",
  "transient",
  "rate-limited",
  "timeout",
  "dead",
  "content-mismatch",
  "unsupported",
  "auth-required",
] as const;

/**
 * Which classifications count as a failure.
 *
 * `redirected` is NOT one: a surface that answers from a new location is
 * serving, and statusForClassification treats it alongside `live`. Counting it
 * as a failure here would contradict the health status the same probe produced.
 */
export const SUCCEEDING_CLASSIFICATIONS = ["live", "redirected"] as const;

/**
 * One window of the rollup, oldest day first.
 *
 * The netuid and kind filters are applied in SQL rather than after the read:
 * the network-wide window is ~280 rows a day, and a per-subnet caller should
 * not pay for all of them.
 */
export async function loadFailureReasons(
  db: FailureReasonsDb | null | undefined,
  {
    window = "30d",
    netuid,
    kind,
    nowMs = Date.now(),
  }: {
    window?: string;
    netuid?: number | null;
    kind?: string | null;
    nowMs?: number;
  } = {},
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  const days = FAILURE_REASONS_WINDOW_DAYS[window];
  if (days === undefined) return null;
  const binds: unknown[] = [utcDay(nowMs - days * 86_400_000)];
  let where = "day >= ?";
  if (typeof netuid === "number") {
    where += " AND netuid = ?";
    binds.push(netuid);
  }
  if (typeof kind === "string" && kind.length > 0) {
    where += " AND kind = ?";
    binds.push(kind);
  }
  try {
    const res = await (
      db
        .prepare(
          `SELECT day, netuid, kind, classification, checks` +
            ` FROM ${FAILURE_REASONS_TABLE} WHERE ${where}` +
            ` ORDER BY day ASC`,
        )
        .bind(...binds) as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
  } catch {
    return null;
  }
}

/**
 * Shape the card. Pure, so the same rows produce the same payload wherever they
 * came from.
 *
 * An empty window is a real answer and is NOT a decline: it means the prober
 * recorded nothing in that range, which is what a narrow window over a quiet
 * period looks like. The counts are zero because they were counted, and
 * `days_covered: 0` says so.
 */
export function buildFailureReasons(
  rows: Row[] | null | undefined,
  {
    window,
    netuid,
    kind,
  }: { window?: string; netuid?: number; kind?: string } = {},
): Row {
  const entries = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      day: stringOrNull(r?.day),
      classification: knownClassification(r?.classification),
      checks: intOrNull(r?.checks),
    }))
    // A row that cannot say which day or which reason it describes cannot take
    // a position in either the series or the mix.
    .filter(
      (e): e is { day: string; classification: string; checks: number } =>
        e.day !== null && e.classification !== null && e.checks !== null,
    );

  const totalChecks = entries.reduce((sum, e) => sum + e.checks, 0);
  const failingChecks = entries
    .filter((e) => isFailure(e.classification))
    .reduce((sum, e) => sum + e.checks, 0);

  const byClassification = new Map<string, number>();
  const byDay = new Map<string, Map<string, number>>();
  for (const e of entries) {
    byClassification.set(
      e.classification,
      (byClassification.get(e.classification) ?? 0) + e.checks,
    );
    const day = byDay.get(e.day) ?? new Map<string, number>();
    day.set(e.classification, (day.get(e.classification) ?? 0) + e.checks);
    byDay.set(e.day, day);
  }

  const days = [...byDay.keys()].sort();

  return {
    schema_version: 1,
    window: window ?? null,
    netuid: netuid ?? null,
    kind: kind ?? null,
    // Counted from the ROWS, not from the requested window: a day the prober
    // did not run is absent rather than a zero, and claiming otherwise would
    // report a gap in coverage as a day of perfect health.
    days_covered: days.length,
    oldest_day: days.length ? days[0] : null,
    newest_day: days.length ? days[days.length - 1] : null,
    total_checks: totalChecks,
    failing_checks: failingChecks,
    // Failing probes over ALL probes in the same window. Computed here rather
    // than left to the caller so it cannot be paired with a different total.
    failure_rate: totalChecks > 0 ? failingChecks / totalChecks : null,
    reasons: [...byClassification.entries()]
      .map(([classification, checks]) => ({
        classification,
        is_failure: isFailure(classification),
        checks,
        // Of every probe in the window.
        share: totalChecks > 0 ? checks / totalChecks : null,
        // Of the FAILING probes only -- null for a succeeding classification,
        // where the question does not apply, rather than zero.
        failure_share:
          isFailure(classification) && failingChecks > 0
            ? checks / failingChecks
            : null,
      }))
      .sort((a, b) => b.checks - a.checks),
    // Oldest first, so a caller plotting the series does not have to reverse it.
    series: days.map((day) => {
      const counts = byDay.get(day) as Map<string, number>;
      const dayTotal = [...counts.values()].reduce((s, n) => s + n, 0);
      const dayFailing = [...counts.entries()]
        .filter(([c]) => isFailure(c))
        .reduce((s, [, n]) => s + n, 0);
      return {
        day,
        total_checks: dayTotal,
        failing_checks: dayFailing,
        failure_rate: dayTotal > 0 ? dayFailing / dayTotal : null,
        by_classification: Object.fromEntries(
          [...counts.entries()].sort((a, b) => b[1] - a[1]),
        ),
      };
    }),
  };
}

/** A decline, for the one case a read cannot answer at all. */
export function declineFailureReasons(
  reason: "unavailable",
  {
    window,
    netuid,
    kind,
  }: { window?: string; netuid?: number; kind?: string } = {},
): Row {
  return {
    schema_version: 1,
    degraded: { reason },
    window: window ?? null,
    netuid: netuid ?? null,
    kind: kind ?? null,
    // NULL, not zero: the rollup could not be read, so nothing is known about
    // how many probes ran or how many failed. A zero would assert a quiet
    // network.
    days_covered: null,
    oldest_day: null,
    newest_day: null,
    total_checks: null,
    failing_checks: null,
    failure_rate: null,
    reasons: [],
    series: [],
  };
}

function isFailure(classification: string): boolean {
  return !(SUCCEEDING_CLASSIFICATIONS as readonly string[]).includes(
    classification,
  );
}

function knownClassification(value: unknown): string | null {
  return typeof value === "string" &&
    (FAILURE_CLASSIFICATIONS as readonly string[]).includes(value)
    ? value
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 'YYYY-MM-DD' in UTC, matching the rollup's own `day` format. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
