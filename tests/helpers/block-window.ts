// A lakehouse double that honours the block window (#11131).
//
// The scattered-key reads on `chain.account_events` no longer issue one
// unbounded query: they widen a `block_number` window until the page fills,
// because an unbounded scan of that table measured 577.5 MB and 3,480 R2
// requests against 0.1 MB and 9 with a bound.
//
// A stub that ignores the bound and replays its whole fixture for every window
// reports the SAME rows collected once per step -- one transfer of 25 TAO read
// as 100, one event read as four. That is a fact about the stub, not about the
// reader. Honouring the range is what makes these tests evidence that the walk
// reassembles exactly the rows the unbounded query returned.
//
// A query with no block bound is passed through untouched, so the readers that
// take an explicit window from their caller (chain-events, the blocks seam) are
// unaffected -- this models the bound a query actually carries, never one it
// ought to have.

/** The `block_number` bound in a query, or null when it has none. */
export function blockWindow(
  sql: string,
): { floor: number; ceiling: number } | null {
  const bound = /block_number >= (\d+)(?: AND block_number <= (\d+))?/.exec(
    sql,
  );
  if (!bound) return null;
  return {
    floor: Number(bound[1]),
    // The newest slice deliberately carries no ceiling, so a row that reached
    // the lakehouse before the decode watermark advanced past it is still
    // visible. Modelling that as "no upper limit" is the point.
    ceiling:
      bound[2] === undefined ? Number.POSITIVE_INFINITY : Number(bound[2]),
  };
}

/**
 * The rows a bounded query would actually see, honouring its LIMIT.
 *
 * `blockOf` reads the block from a row for aggregates that carry it under
 * another name (a GROUP BY row's newest block is `lb`, not `block_number`).
 */
export function visibleInWindow<Row>(
  sql: string,
  rows: readonly Row[],
  blockOf: (row: Row) => unknown = (row) =>
    (row as { block_number?: unknown })?.block_number,
): Row[] {
  const window = blockWindow(sql);
  const kept = !window
    ? [...rows]
    : rows.filter((row) => {
        const block = blockOf(row);
        // A ROW WITH NO BLOCK SITS AT THE NEWEST EDGE, not in every window.
        //
        // Some fixtures are deliberately field-less -- `[{}]`, to assert that a
        // row missing everything degrades each field to null. Passing those
        // through unconditionally puts them in EVERY slice, so the walk
        // collects one row four times and the test reads as a paging bug.
        // Treating an absent block as +Infinity puts it in exactly the slice
        // that has no ceiling, which is the newest one: the row comes back
        // once, which is what the fixture is saying.
        const n = block == null ? Number.POSITIVE_INFINITY : Number(block);
        return n >= window.floor && n <= window.ceiling;
      });
  const limit = Number(/LIMIT (\d+)\s*$/.exec(sql)?.[1] ?? kept.length);
  return kept.slice(0, limit);
}
