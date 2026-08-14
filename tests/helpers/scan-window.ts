// A lakehouse double that honours the scan window (#11131).
//
// The scattered-key reads on `chain.account_events` no longer issue one
// unbounded query: they widen an `observed_at` window until the page fills,
// because an unbounded scan of that table measured 1,933.6 MB across 48 files
// against 2.9 MB across 18 with a two-day bound.
//
// A stub that ignores the bound and replays its whole fixture for every window
// reports the SAME rows collected once per step -- one transfer of 25 TAO read
// as 100, one event read as four. That is a fact about the stub, not about the
// reader. Honouring the range is what makes these tests evidence that the walk
// reassembles exactly the rows the unbounded query returned.
//
// A query with no window is passed through untouched, so the readers that take
// an explicit window from their caller (chain-events, the blocks seam) are
// unaffected -- this models the bound a query actually carries, never one it
// ought to have.

/**
 * The `observed_at` bound in a query, or null when it has none.
 *
 * BOTH HALVES ARE OPTIONAL and each absence means something:
 *  - no ceiling  -> the NEWEST read. The capture lane writes behind wall clock,
 *    so clamping it would hide the rows a newest-first feed exists to show.
 *  - no floor    -> the FINAL read, which takes everything below the probes in
 *    one query instead of widening. A model that only recognised the two-sided
 *    form would pass that query's rows through unfiltered and report the probe's
 *    rows a second time -- 25 TAO read as 50.
 */
export function scanWindow(
  sql: string,
): { floor: number; ceiling: number } | null {
  const floor = /observed_at >= (\d+)/.exec(sql);
  const ceiling = /observed_at <= (\d+)/.exec(sql);
  if (!floor && !ceiling) return null;
  return {
    floor: floor ? Number(floor[1]) : Number.NEGATIVE_INFINITY,
    ceiling: ceiling ? Number(ceiling[1]) : Number.POSITIVE_INFINITY,
  };
}

/**
 * The rows a bounded query would actually see, honouring its LIMIT.
 *
 * `observedOf` reads the timestamp from a row, for aggregates that carry it
 * under another name (a GROUP BY row's newest observation is `lo`, not
 * `observed_at`).
 */
export function visibleInWindow<Row>(
  sql: string,
  rows: readonly Row[],
  observedOf: (row: Row) => unknown = (row) =>
    (row as { observed_at?: unknown })?.observed_at,
): Row[] {
  const window = scanWindow(sql);
  const kept = !window
    ? [...rows]
    : rows.filter((row) => {
        const observed = observedOf(row);
        // A ROW WITH NO TIMESTAMP SITS AT THE NEWEST EDGE, not in every window.
        //
        // Some fixtures are deliberately field-less -- `[{}]`, to assert that a
        // row missing everything degrades each field to null. Passing those
        // through unconditionally puts them in EVERY slice, so the walk collects
        // one row four times and the test reads as a paging bug. Treating an
        // absent timestamp as +Infinity puts it in exactly the slice with no
        // ceiling, which is the newest one: the row comes back once, which is
        // what the fixture is saying.
        const n =
          observed == null ? Number.POSITIVE_INFINITY : Number(observed);
        return n >= window.floor && n <= window.ceiling;
      });
  const limit = Number(/LIMIT (\d+)\s*$/.exec(sql)?.[1] ?? kept.length);
  return kept.slice(0, limit);
}
