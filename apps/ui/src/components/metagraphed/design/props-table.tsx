import { DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import type { PropRow } from "./primitive-props";

/**
 * A primitive's props, as the one table (#11627).
 *
 * The `Component` column appears only when a section documents more than one
 * component; a column whose every cell repeats the section heading is noise,
 * and the sections that document a family (`Raw` / `RawRow` / `RawCode`, the
 * five ranking charts) are exactly the ones that need it.
 *
 * `kind: "text"` throughout, deliberately: `identifier` hangs a copy button off
 * every cell, and a props table with 30 copy buttons documents nothing.
 */
export function PropsTable({ rows, caption }: { rows: readonly PropRow[]; caption: string }) {
  const components = new Set(rows.map((row) => row.component));
  const columns: DataTableColumn<PropRow>[] = [
    ...(components.size > 1
      ? [
          {
            key: "component",
            label: "Component",
            width: 190,
            value: (row: PropRow) => row.component,
          },
        ]
      : []),
    { key: "prop", label: "Prop", width: 150, value: (row) => row.prop },
    { key: "type", label: "Type", width: 240, value: (row) => row.type },
    {
      key: "required",
      label: "Required",
      width: 90,
      value: (row) => (row.required ? "yes" : "—"),
    },
    { key: "what", label: "What it does", value: (row) => row.what },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(row) => row.key}
      caption={caption}
      // Every row of every props table on the page, at once: this is a
      // reference, and a reader looking for `formatSecondary` should find it
      // with the browser's own search rather than by paging.
      paginate={false}
      dense
      mobile="cards"
      source={`props-${caption.replace(/\s+/g, "-").toLowerCase()}`}
    />
  );
}
