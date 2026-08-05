import type { ColumnDef } from "./use-column-visibility";

/**
 * Builds a <colgroup> that pins a table's column widths.
 *
 * Virtualized tables cannot use `table-layout: auto`: the browser derives
 * column widths from the rows currently in the DOM, and a virtualizer
 * replaces those rows on every scroll, so the columns keep being re-measured
 * and everything -- including the pinned header -- slides sideways while the
 * reader scrolls. Measured before this: 43px of drift on /subnets, 123px on
 * /validators.
 *
 * `table-layout: fixed` stops that, but only if the columns have declared
 * widths; without them the browser splits the table evenly and a checkbox
 * column gets as much room as a name. Percentages (rather than pixels) keep
 * the proportions when the table is stretched wider than its minimum, and
 * pairing them with a `min-width` on the table keeps horizontal scrolling
 * working when the container is narrower than the columns need.
 */
export function TableColGroup({ widths }: { widths: number[] }) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  return (
    <colgroup>
      {widths.map((w, i) => (
        // Positional by definition: a <col> IS its index in the row.
        <col
          key={`col-${i}`}
          style={{ width: `${((w / total) * 100).toFixed(3)}%` }}
        />
      ))}
    </colgroup>
  );
}

/** Weights for the visible subset, falling back to an even share. */
export function columnWidths(
  columns: readonly ColumnDef[],
  isVisible: (id: string) => boolean,
  leading: number[] = [],
): number[] {
  return [
    ...leading,
    ...columns.filter((c) => isVisible(c.id)).map((c) => c.width ?? 100),
  ];
}
