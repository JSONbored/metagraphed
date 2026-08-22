/**
 * Pure logic behind `DataTable` (#11610): sorting, paging, the pager window,
 * identifier truncation, CSV, column visibility and the responsive mode.
 * Kept out of the component so the rules get direct coverage.
 */

export type SortDirection = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDirection;
}

export type CellValue = string | number | null | undefined;

/** `asc` on the first click of an unsorted column, then it flips; null = unsorted. */
export function nextSort(
  current: SortState | null,
  key: string,
): SortState | null {
  if (!current || current.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return null;
}

export function isMissing(value: CellValue): boolean {
  return value === null || value === undefined || value === "";
}

/** Ascending: numbers numerically, strings naturally. Missing sinks (see `sortRows`). */
export function compareValues(a: CellValue, b: CellValue): number {
  if (isMissing(a) || isMissing(b))
    return isMissing(a) && isMissing(b) ? 0 : isMissing(a) ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en-US", { numeric: true });
}

/** Stable: equal rows keep their incoming order, so a re-sort never shuffles. */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: SortState | null,
  valueOf: (row: Row, key: string) => CellValue,
): Row[] {
  if (!sort) return [...rows];
  const decorated = rows.map((row, index) => ({
    row,
    index,
    value: valueOf(row, sort.key),
  }));
  decorated.sort((x, y) => {
    // An unknown sinks in BOTH directions -- it is not "smallest", so the
    // direction flip must not lift it to the top.
    if (isMissing(x.value) || isMissing(y.value)) {
      if (!isMissing(x.value)) return -1;
      if (!isMissing(y.value)) return 1;
      return x.index - y.index;
    }
    const diff = compareValues(x.value, y.value);
    if (diff !== 0) return sort.dir === "asc" ? diff : -diff;
    return x.index - y.index;
  });
  return decorated.map((d) => d.row);
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function pageSlice<Row>(
  rows: readonly Row[],
  page: number,
  pageSize: number,
): Row[] {
  if (pageSize <= 0) return [...rows];
  const start = Math.max(0, (page - 1) * pageSize);
  return rows.slice(start, start + pageSize);
}

/** `1–50 of 1,021`, or `1 of 1` for a single short page. */
export function rangeLabel(
  page: number,
  pageSize: number,
  total: number,
): string {
  if (total <= 0) return "0";
  const start = Math.min(total, (page - 1) * pageSize + 1);
  const end = Math.min(total, page * pageSize);
  const n = (v: number) => v.toLocaleString("en-US");
  return `${n(start)}–${n(end)} of ${n(total)}`;
}

/**
 * `1 2 3 … 12` — first, last, and a window around the current page, with
 * `null` marking each elision. Never longer than 7 slots.
 */
export function pageWindow(page: number, pages: number): Array<number | null> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const window = new Set<number>([1, pages, page]);
  for (const p of [page - 1, page + 1]) if (p > 1 && p < pages) window.add(p);
  if (page <= 3) for (const p of [2, 3, 4]) window.add(p);
  if (page >= pages - 2)
    for (const p of [pages - 3, pages - 2, pages - 1]) window.add(p);
  const sorted = [...window]
    .filter((p) => p >= 1 && p <= pages)
    .sort((a, b) => a - b);
  const out: Array<number | null> = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous && p - previous > 1) out.push(null);
    out.push(p);
    previous = p;
  }
  return out;
}

/** `5GsbTg…SFpZX9` — the middle of a long identifier is never the readable part. */
export function truncateIdentifier(value: string, head = 6, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** RFC 4180 field: quoted only when it has to be, quotes doubled. */
export function csvField(value: CellValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv<Row>(
  rows: readonly Row[],
  columns: ReadonlyArray<{ key: string; label: string }>,
  valueOf: (row: Row, key: string) => CellValue,
): string {
  const lines = [columns.map((c) => csvField(c.label)).join(",")];
  for (const row of rows)
    lines.push(columns.map((c) => csvField(valueOf(row, c.key))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Cards for a table narrow enough to read as label/value pairs; scroll otherwise. */
export function pickMobileMode(columnCount: number): "cards" | "scroll" {
  return columnCount <= 6 ? "cards" : "scroll";
}

/** Demoted columns are hidden until the reader asks for them. */
export function defaultVisibleKeys(
  columns: ReadonlyArray<{ key: string; demote?: boolean }>,
): string[] {
  return columns.filter((c) => !c.demote).map((c) => c.key);
}

/**
 * A stored column selection is only honoured for keys the table still has,
 * and an empty result falls back to the default (a stale key list must not
 * render a table with no columns).
 */
export function resolveVisibleKeys(
  columns: ReadonlyArray<{ key: string; demote?: boolean }>,
  stored: readonly string[] | null,
): string[] {
  if (!stored) return defaultVisibleKeys(columns);
  const known = new Set(columns.map((c) => c.key));
  const kept = stored.filter((key) => known.has(key));
  return kept.length > 0 ? kept : defaultVisibleKeys(columns);
}

/** Long lists scroll inside the table instead of the page, so the head can pin. */
export function shouldBoundViewport(
  renderedRows: number,
  threshold = 20,
): boolean {
  return renderedRows > threshold;
}
