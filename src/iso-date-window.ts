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

/**
 * The two aggregate columns an anchored-window read returns.
 *
 * A `type` and not an `interface` so it stays assignable to the
 * `Record<string, unknown>` rows the readers' own runners produce, which is
 * what lets one runner shape serve both them and a typed `sql.unsafe` call.
 * Both optional: a store that returns no row for a bare aggregate is a case
 * `readAnchoredWindow` handles rather than assumes away.
 */
export type AnchoredWindowRow = {
  start_date?: string | null;
  end_date?: string | null;
};

/** The loosest shape the anchored readers' runners share. */
export type WindowRunner = (
  sql: string,
  params: unknown[],
) => Promise<Array<Record<string, unknown>>>;

/**
 * The stored window for a neuron_daily reader, anchored on the newest row the
 * table actually HAS -- without a date function in the SQL.
 *
 * This is the conversion the module above was written for and the three
 * readers never received (#9792/#9798): `chain-turnover`, `movers` and
 * `turnover` each still asked for
 * `snapshot_date >= (SELECT date(MAX(snapshot_date), ?) ...)`, which is
 * SQLite's two-argument `date()` and does not exist in Postgres at any arity.
 * On a Postgres runner the subquery yielded nothing, `>=` matched nothing, and
 * the route answered a schema-stable 200 with zero rows -- the one shape that
 * reads as "no data yet". Shared here so the three cannot drift apart again,
 * and so it matches what `createPgNeuronDailyViewStore.window` already does
 * natively.
 *
 * Two reads rather than one, deliberately: the anchor has to be KNOWN before
 * the cutoff can be bound. `MAX(snapshot_date)` over the whole (optionally
 * subnet-scoped) relation is the same value the old outer MAX returned, since
 * the global maximum always satisfies its own cutoff.
 *
 * `days` null means the whole retained range, which needs no cutoff and stays
 * one read.
 */
export async function readAnchoredWindow(
  runner: WindowRunner,
  days: number | null,
  netuid?: number,
): Promise<{ startDate: string | null; endDate: string | null }> {
  const scope = netuid === undefined ? "" : " WHERE netuid = ?";
  const scopeParams = netuid === undefined ? [] : [netuid];
  if (days === null) {
    const all = await runner(
      "SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date" +
        ` FROM neuron_daily${scope}`,
      scopeParams,
    );
    return {
      startDate: (all?.[0]?.start_date as string | null) ?? null,
      endDate: (all?.[0]?.end_date as string | null) ?? null,
    };
  }
  const anchor = await runner(
    `SELECT MAX(snapshot_date) AS end_date FROM neuron_daily${scope}`,
    scopeParams,
  );
  const endDate = (anchor?.[0]?.end_date as string | null) ?? null;
  const cutoff = shiftIsoDate(endDate, -days);
  // A null anchor is an empty (or subnet-less) relation, and a null cutoff is
  // a stored value that is not a date. Either way there is no window to
  // report, and inventing one would be the confident answer this whole module
  // exists to stop.
  if (endDate === null || cutoff === null)
    return { startDate: null, endDate: null };
  const start = await runner(
    "SELECT MIN(snapshot_date) AS start_date FROM neuron_daily WHERE" +
      `${netuid === undefined ? "" : " netuid = ? AND"} snapshot_date >= ?`,
    [...scopeParams, cutoff],
  );
  return {
    startDate: (start?.[0]?.start_date as string | null) ?? null,
    endDate,
  };
}
