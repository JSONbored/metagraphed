// Window boundaries that do not depend on the store's SQL dialect (#9798).
//
// WHY THIS EXISTS. Three neuron_daily routes anchored their window on
// `date(MAX(snapshot_date), '-N days')`. That function is SQLite's; Postgres
// has no equivalent, so on Neon the subquery yielded nothing, `>=` matched
// nothing, and the routes returned a schema-stable 200 with ZERO rows --
// `/subnets/{netuid}/history` went 28 -> 0 and `/subnets/movers` 5 -> 0 (#9792).
// Not an error. The one shape that reads as "no data yet".
//
// The neurons family moves store by choosing a runner, and the runners really
// are interface-compatible -- `toPositionalPlaceholders` handles `?` -> `$n`.
// What is NOT compatible is the function library, and nothing was checking it.
//
// THE FIX IS TO REMOVE THE DIALECT FROM THE QUESTION rather than to translate
// it. The anchor is `MAX(snapshot_date)` shifted by N days: reading a max is
// portable, binding a date literal is portable, and the shift is arithmetic
// that belongs in TypeScript. Once it happens here there is no date function
// left in the SQL for two dialects to disagree about.
//
// NOT `windowCutoffDate`, which the history routes use and which shifts from
// `Date.now()`. That difference is deliberate and load-bearing: these three
// anchor on the newest row the table actually HAS, so a producer that has
// fallen a day behind still yields a full window instead of a short one.

/** Milliseconds in a day. Snapshot dates are whole days, so this never straddles a DST change. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`, the stored shape of every `snapshot_date` in the neurons family. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shift an ISO `YYYY-MM-DD` date by a whole number of days.
 *
 * Returns null rather than throwing or producing `"Invalid Date"` for anything
 * that is not a date, because the input is a value READ BACK FROM THE STORE:
 * an empty table yields SQL NULL, which arrives here as null/undefined. A
 * caller that gets null must treat the window as unbounded or empty on its own
 * terms -- exactly what the `date(...)` subquery's NULL used to do -- rather
 * than binding the string "Invalid Date" into a query.
 *
 * Parsed as UTC (the `Z`) so the result never depends on where the Worker ran.
 * Without it, `new Date("2026-08-07")` is UTC but `new Date(y, m, d)` is local,
 * and a boundary computed in one and compared against the other slips a day
 * for half the world.
 */
export function shiftIsoDate(date: unknown, days: number): string | null {
  if (typeof date !== "string" || !ISO_DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  // NOT unreachable: the regex counts digits, not calendars, so "2026-13-01"
  // and "2026-01-32" reach here and Date.parse returns NaN for both. (It does
  // NOT reject every impossible date -- "2026-02-31" silently rolls over to
  // March 3rd, which is why this guard is a backstop and not the validator.)
  if (!Number.isFinite(ms)) return null;
  if (!Number.isFinite(days)) return null;
  return new Date(ms + Math.trunc(days) * DAY_MS).toISOString().slice(0, 10);
}
