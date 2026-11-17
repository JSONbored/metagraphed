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

/**
 * `YYYY-MM-DD`, the stored shape of every `snapshot_date` in the neurons
 * family. Exported for the callers that need the RegExp itself -- a zod
 * `.regex()` and `workers/request-params.ts`'s DAY_PATTERN -- while everything
 * asking a yes/no question uses `isIsoDay` below.
 */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this string a stored day?
 *
 * Exported because the identical literal was written out in seven other
 * modules, each asking this exact question of a `snapshot_date` or a `day`.
 * They cannot drift while they are byte-identical, but they are also the only
 * places that DON'T carry the caveat below, and that is the real cost of a
 * copy: the knowledge lives with one of them.
 *
 * SHAPE, NOT CALENDAR. This counts digits. `2026-13-01` and `2026-01-32` pass
 * it and only fail later (`Date.parse` returns NaN for both); `2026-02-31`
 * passes and silently rolls over to March 3rd if a caller parses it. A caller
 * that needs a real date must parse, not just match -- `shiftIsoDate` below
 * does exactly that, and its NaN guard is a backstop for precisely this.
 */
export function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && ISO_DAY.test(value);
}

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
  if (typeof date !== "string" || !ISO_DAY.test(date)) return null;
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
/**
 * One aggregate cell as a day string, or null.
 *
 * Narrowing rather than asserting `as string | null`: the runner's rows are
 * `unknown`-valued, and a driver that hands back a Date, a number or a Buffer
 * for an aggregate would have been asserted into a string and bound into the
 * next query. This makes that case null, which every caller already handles.
 */
function dayCell(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

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
      startDate: dayCell(all?.[0]?.start_date),
      endDate: dayCell(all?.[0]?.end_date),
    };
  }
  const anchor = await runner(
    `SELECT MAX(snapshot_date) AS end_date FROM neuron_daily${scope}`,
    scopeParams,
  );
  const endDate = dayCell(anchor?.[0]?.end_date);
  // An empty (or subnet-less) relation has no window at all, and no second
  // read is worth spending on it.
  if (endDate === null) return { startDate: null, endDate: null };
  // A NON-ISO stored anchor yields no cutoff, and then the window is the whole
  // range rather than nothing. That is the source behaviour, shared by
  // `createPgNeuronDailyViewStore.window` and pinned as parity between the two
  // in tests/pg-neuron-daily-view.pg18.ts -- a refusal here instead looks like
  // an empty store to every caller, which is the #9792 shape this module
  // exists to prevent, not a safer answer. Worth noting rather than changing
  // unilaterally: a caller asking for 7 days gets everything in this case, and
  // narrowing that is a decision for all three components at once.
  const cutoff = shiftIsoDate(endDate, -days);
  const start = await runner(
    "SELECT MIN(snapshot_date) AS start_date FROM neuron_daily" +
      (netuid === undefined && cutoff === null
        ? ""
        : ` WHERE${netuid === undefined ? "" : " netuid = ?"}` +
          (cutoff === null
            ? ""
            : `${netuid === undefined ? "" : " AND"} snapshot_date >= ?`)),
    [...scopeParams, ...(cutoff === null ? [] : [cutoff])],
  );
  return {
    startDate: dayCell(start?.[0]?.start_date),
    endDate,
  };
}
