// Date-window arithmetic done in TypeScript, because SQL dialects disagree
// about it (#9791).
//
// Three `neuron_daily` window queries anchored their floor with SQLite's
// `date(MAX(snapshot_date), '-30 days')`. When #9784 moved those routes onto
// Neon the function did not exist, the subquery yielded nothing, `>=` matched
// nothing, and two public routes returned a schema-stable EMPTY result at
// 200 OK:
//
//     /api/v1/subnets/movers        5 rows -> 0
//     /api/v1/subnets/{netuid}/history  28 rows -> 0
//
// Nothing errored. That is the shape of the failure: a dialect gap does not
// throw, it silently returns nothing, and an empty list is a valid response.
//
// ## Why the boundary belongs in TypeScript, not in either database
//
// `createD1Sql` and `createPgSql` are interface-compatible, so a query moves
// stores by choosing a runner. That is true of the BINDING and false of the
// SQL: `toPositionalPlaceholders` translates `?` to `$n` and nothing translates
// SQLite's function library. A boundary computed here and passed as a bound
// parameter is portable by construction -- it removes the dialect question
// rather than answering it twice.
//
// ## The cost is one extra round trip, and it is worth it
//
// The old form nested `MAX()` inside the filter, so one statement did both.
// The portable form asks for the max first. It cannot be folded back into one
// statement without re-introducing database-side date arithmetic, and the
// alternative -- deriving the floor from an unfiltered MIN/MAX pair -- gives
// the WRONG start date whenever the range has a gap. `neuron_daily` currently
// has exactly such a gap: 2026-08-06 is missing entirely (#9781).

/** Days in a UTC calendar day. Dates here are 'YYYY-MM-DD' with no time part,
 * so arithmetic is exact and DST cannot apply. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A 'YYYY-MM-DD' string, the form `snapshot_date` columns hold. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `date(day, '-N days')`, in TypeScript.
 *
 * Matches SQLite's semantics for the one form this replaces: a bare
 * 'YYYY-MM-DD' and a whole number of days. Returns null for anything that is
 * not that, so a malformed column value produces "no window" rather than a
 * silently wrong one -- an unparseable date must not become 1970-01-01, which
 * would widen the window to everything.
 */
export function subtractUtcDays(day: unknown, days: number): string | null {
  if (typeof day !== "string" || !ISO_DAY.test(day)) return null;
  if (!Number.isInteger(days) || days < 0) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return null;
  return new Date(at - days * DAY_MS).toISOString().slice(0, 10);
}

/** The minimal runner shape these helpers need.
 *
 * NOT generic. `createD1Sql` and `createPgSql` both return
 * `Record<string, unknown>[]`, and a generic `<T>` here would claim this
 * function can produce any row type the caller names -- which neither runner
 * can honour, and which TypeScript correctly rejects at the call site. The
 * concrete shape is read back with a cast at the two places it matters. */
export interface DayBoundsSql {
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record<string, unknown>[]>;
}

export interface DayBounds {
  startDate: string | null;
  endDate: string | null;
}

/**
 * The first and last `snapshot_date` inside the trailing `days` window.
 *
 * Two statements, deliberately. The first finds the newest day the table
 * actually holds; the second finds the real bounds at or after
 * `newest - days`. `startDate` is therefore the smallest date PRESENT in the
 * window, which is not the same as the window's floor whenever a day is
 * missing -- and one is (#9781).
 *
 * `netuid` scopes both statements when given, so a per-subnet window anchors
 * on that subnet's own newest day rather than the table's.
 */
export async function neuronDailyWindow(
  sql: DayBoundsSql,
  days: number,
  netuid: number | null = null,
): Promise<DayBounds> {
  const newest =
    netuid == null
      ? await sql`SELECT MAX(snapshot_date) AS mx FROM neuron_daily`
      : await sql`SELECT MAX(snapshot_date) AS mx FROM neuron_daily WHERE netuid = ${netuid}`;
  const floor = subtractUtcDays(newest[0]?.mx, days);
  // No rows, or a value that is not a day: no window. The callers already
  // treat a null start/end as "not enough history", which is the honest
  // answer and the same one the old query produced on an empty table.
  if (floor == null) return { startDate: null, endDate: null };

  const bounds =
    netuid == null
      ? await sql`
          SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date
          FROM neuron_daily
          WHERE snapshot_date >= ${floor}`
      : await sql`
          SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date
          FROM neuron_daily
          WHERE netuid = ${netuid} AND snapshot_date >= ${floor}`;
  return {
    startDate: (bounds[0]?.start_date ?? null) as string | null,
    endDate: (bounds[0]?.end_date ?? null) as string | null,
  };
}
