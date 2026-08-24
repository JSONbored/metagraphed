import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { classNames } from "@/lib/format";
import { CopyButton } from "../copy-button";
import { Skeleton } from "../skeleton";
import { TimeAgo } from "../time-ago";
import { Definition } from "../interaction/definition";
import { useEntityMark } from "../interaction/active-entity";
import { DataTableMenu } from "./data-table-menu";
import type { SectionNavLink } from "../document/section-nav";
import {
  defaultVisibleKeys,
  nextSort,
  pageCount,
  pageSlice,
  pageWindow,
  pickMobileMode,
  rangeLabel,
  resolveVisibleKeys,
  shouldBoundViewport,
  sortRows,
  toCsv,
  truncateIdentifier,
  type CellValue,
  type SortState,
} from "./data-table-logic";

/**
 * The one table (#11610). Every list in the app is this component: the
 * caption row carries the count, the search box, up to three filters and the
 * table menu (columns · CSV · copy link); the head pins inside a bounded
 * viewport when the list is long; rows are entity marks, so hovering one
 * lights the same key in any chart on the page; below 640px a narrow table
 * becomes label/value cards and a wide one scrolls.
 *
 * One DOM in every mode — the cards are CSS, not a second render — so the
 * server-rendered HTML always contains every row and every row link.
 */
export type DataTableKind =
  | "text"
  | "number"
  | "identifier"
  | "status"
  | "time"
  | "delta"
  | "link"
  | "tint";

export interface DataTableColumn<Row> {
  key: string;
  label: string;
  align?: "left" | "right";
  width?: number | string;
  sortable?: boolean;
  /** Hidden until the reader turns it on in the table menu. */
  demote?: boolean;
  /**
   * Let this cell wrap onto more lines.
   *
   * Cells do NOT wrap by default (#11695): a take RANGE ("9.0%-18.0%") breaks
   * at its dash, and every multi-hotkey operator's row came out a third taller
   * than its neighbours -- a table whose row height depends on which operator
   * you are looking at reads as a rendering fault rather than as data. Uniform
   * rows are the rhythm the reference tables have.
   *
   * The opt-out is the flag rather than the default because it is the rare
   * case -- one prose column in the app -- and the attribute is emitted per
   * CELL. Defaulting the other way put `data-nowrap="true"` on 604 cells of
   * /validators, 10.8 KB of served HTML, and broke that route's payload
   * ratchet.
   */
  wrap?: boolean;
  kind?: DataTableKind;
  /** The sortable / exportable / default-rendered value. */
  value?: (row: Row) => CellValue;
  /** Formats `value` for display; defaults to the kind's own formatting. */
  format?: (value: CellValue, row: Row) => string;
  /** Full control of the cell. */
  render?: (row: Row) => ReactNode;
  /** `kind: "link"` — where the cell's text points. */
  href?: (row: Row) => string | undefined;
  /** `kind: "tint"` — 0…1; paints the cell's background. */
  tint?: (row: Row) => number | null | undefined;
  /** A `?` after the header label. */
  definition?: string;
}

export interface DataTableProps<Row> {
  rows: readonly Row[];
  columns: ReadonlyArray<DataTableColumn<Row>>;
  rowKey: (row: Row) => string;
  /** Names the table and the CSV file; shown in the caption row. */
  caption: string;
  /** Hide the caption text but keep it for assistive tech. */
  captionHidden?: boolean;
  /** The full result size when it is larger than `rows` (server paging). */
  total?: number;
  /** Controlled sort. Omit both to let the table sort itself. */
  sort?: SortState | null;
  onSort?: (sort: SortState | null) => void;
  /** Controlled paging. Omit both to let the table page itself. */
  page?: number;
  onPage?: (page: number) => void;
  pageSize?: number;
  /**
   * Rows-per-page choices, offered in the table menu. Pass `onPageSize` with
   * them; without a handler the control is left out rather than rendered
   * inert, because a switch that does nothing is worse than no switch.
   */
  pageSizes?: readonly number[];
  onPageSize?: (size: number) => void;
  /** `false` renders every row (a crawlable index); the viewport still bounds it. */
  paginate?: boolean;
  /** Whole-row link. */
  rowHref?: (row: Row) => string | undefined;
  /** Renders `rowHref` / `kind: "link"` cells; pass the app's router Link. */
  link?: SectionNavLink;
  onRowActivate?: (row: Row) => void;
  /** Rendered under a row when it is expanded. */
  expand?: (row: Row) => ReactNode;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** At most three; more belong behind the menu. */
  filters?: ReactNode;
  loading?: boolean;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  /** Shown instead of rows when the query failed. */
  error?: ReactNode;
  dense?: boolean;
  mobile?: "cards" | "scroll";
  /** Entity-mark namespace, so two tables on a page do not collide. */
  source?: string;
  /** Persists the column selection; omit to keep it per-mount. */
  storageKey?: string;
  /** Copied by the menu's "Copy link"; defaults to the current URL. */
  shareUrl?: string;
  className?: string;
  id?: string;
}

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const DefaultLink: SectionNavLink = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

function defaultFormat(
  kind: DataTableKind | undefined,
  value: CellValue,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "number" || kind === "tint") {
    return typeof value === "number"
      ? numberFormat.format(value)
      : String(value);
  }
  if (kind === "delta" && typeof value === "number") {
    const pct = Math.round(value * 100);
    return pct > 0 ? `+${pct}%` : pct < 0 ? `−${Math.abs(pct)}%` : "0%";
  }
  return String(value);
}

/** ok / warn / down / unknown from the vocabulary the API actually uses. */
export function statusTone(value: string): "good" | "warn" | "bad" | "muted" {
  const word = value.toLowerCase();
  if (
    [
      "ok",
      "up",
      "healthy",
      "active",
      "verified",
      "resolved",
      "passed",
    ].includes(word)
  )
    return "good";
  if (
    ["warn", "warning", "degraded", "stale", "partial", "pending"].includes(
      word,
    )
  )
    return "warn";
  if (
    ["down", "failed", "error", "offline", "rejected", "inactive"].includes(
      word,
    )
  )
    return "bad";
  return "muted";
}

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  caption,
  captionHidden,
  total,
  sort: sortProp,
  onSort,
  page: pageProp,
  onPage,
  pageSize = 50,
  pageSizes,
  onPageSize,
  paginate,
  rowHref,
  link,
  onRowActivate,
  expand,
  search,
  filters,
  loading,
  empty,
  error,
  dense,
  mobile,
  source = "table",
  storageKey,
  shareUrl,
  className,
  id,
}: DataTableProps<Row>) {
  const captionId = useId();
  const [ownSort, setOwnSort] = useState<SortState | null>(null);
  const [ownPage, setOwnPage] = useState(1);
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() =>
    defaultVisibleKeys(columns),
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // The column SET is what matters, not the render-identity of the array: a
  // caller that builds `columns` inline (most of them do) hands us a new array
  // every render, and an effect that depended on it would never settle.
  const columnSignature = columns
    .map((c) => `${c.key}:${c.demote ? 1 : 0}`)
    .join(",");
  const columnSpec = useMemo(
    () =>
      columnSignature
        .split(",")
        .filter(Boolean)
        .map((part) => {
          const [key, demoted] = part.split(":");
          return { key: key!, demote: demoted === "1" };
        }),
    [columnSignature],
  );

  // A stored selection is read after mount, so the server and the first
  // client pass always agree on which columns exist.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(`mg-columns:${storageKey}`);
      setVisibleKeys(
        resolveVisibleKeys(
          columnSpec,
          raw ? (JSON.parse(raw) as string[]) : null,
        ),
      );
    } catch {
      setVisibleKeys(defaultVisibleKeys(columnSpec));
    }
  }, [storageKey, columnSpec]);

  // A column the caller adds or removes after mount appears or disappears even
  // when nothing is stored.
  useEffect(() => {
    if (storageKey) return;
    setVisibleKeys((current) => {
      const known = new Set(columnSpec.map((c) => c.key));
      const kept = current.filter((key) => known.has(key));
      return kept.length === current.length ? current : kept;
    });
  }, [storageKey, columnSpec]);

  const sort = onSort ? (sortProp ?? null) : ownSort;
  const page = onPage ? (pageProp ?? 1) : ownPage;

  const valueOf = useCallback(
    (row: Row, key: string): CellValue => {
      const column = columns.find((c) => c.key === key);
      return column?.value ? column.value(row) : undefined;
    },
    [columns],
  );

  const shown = useMemo(
    () => columns.filter((c) => visibleKeys.includes(c.key)),
    [columns, visibleKeys],
  );

  // Server-side sort/page means the rows arrive ready; only sort here when the
  // table owns the state.
  const sorted = useMemo(
    () => (onSort ? [...rows] : sortRows(rows, sort, valueOf)),
    [rows, sort, valueOf, onSort],
  );
  const pages = pageCount(total ?? sorted.length, pageSize);
  const paging = paginate ?? (!onPage ? sorted.length > pageSize : true);
  const visibleRows = useMemo(
    () => (onPage || !paging ? sorted : pageSlice(sorted, page, pageSize)),
    [sorted, page, pageSize, onPage, paging],
  );

  const bounded = shouldBoundViewport(visibleRows.length);
  const mobileMode = mobile ?? pickMobileMode(shown.length);
  const rowCount = total ?? rows.length;

  const handleSort = (key: string) => {
    const next = nextSort(sort, key);
    if (onSort) onSort(next);
    else setOwnSort(next);
    if (onPage) onPage(1);
    else setOwnPage(1);
  };
  const goToPage = (next: number) => {
    if (onPage) onPage(next);
    else setOwnPage(next);
    viewportRef.current?.scrollTo({ top: 0 });
  };

  const csv = () => toCsv(sorted, shown, valueOf);

  const hasRows = visibleRows.length > 0;

  return (
    <div
      id={id}
      className={classNames("mg-dt", className)}
      data-mg-data-table=""
      /* One attribute on the TABLE, so the lead column can reserve the
         disclosure's gutter for every row (#11700). Doing it per row would
         mean a spacer element on each of /validators' 604, which is 19 KB of
         served HTML on a route that sits on a payload ratchet. */
      data-expandable={expand ? "true" : undefined}
      data-mobile={mobileMode}
      data-dense={dense ? "true" : undefined}
    >
      <div className="mg-dt-caption">
        <p id={captionId} className={captionHidden ? "sr-only" : "mg-dt-title"}>
          {caption}
          {rowCount > 0 ? (
            <span className="mg-dt-count">
              {" "}
              ({rowCount.toLocaleString("en-US")})
            </span>
          ) : null}
        </p>
        <div className="mg-dt-tools">
          {search ? (
            <input
              type="search"
              className="mg-dt-search"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              placeholder={search.placeholder ?? "Search"}
              aria-label={`Search ${caption}`}
            />
          ) : null}
          {filters}
          <DataTableMenu
            columns={columns}
            pageSize={pageSize}
            pageSizes={pageSizes}
            onPageSize={onPageSize}
            visibleKeys={visibleKeys}
            onVisibleKeys={(keys) => {
              setVisibleKeys(keys);
              if (storageKey && typeof window !== "undefined") {
                try {
                  window.localStorage.setItem(
                    `mg-columns:${storageKey}`,
                    JSON.stringify(keys),
                  );
                } catch {
                  /* a private window without storage still gets the change */
                }
              }
            }}
            csv={csv}
            filename={caption}
            shareUrl={shareUrl}
            label={caption}
          />
        </div>
      </div>

      <div
        ref={viewportRef}
        className={classNames(
          "mg-dt-viewport",
          bounded ? "mg-dt-viewport-bounded" : null,
        )}
      >
        <table aria-labelledby={captionId}>
          <thead>
            <tr>
              {shown.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-align={
                      column.align ??
                      (column.kind === "number" ||
                      column.kind === "delta" ||
                      column.kind === "tint"
                        ? "right"
                        : undefined)
                    }
                    aria-sort={
                      active
                        ? sort!.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    style={
                      column.width
                        ? ({
                            width:
                              typeof column.width === "number"
                                ? `${column.width}px`
                                : column.width,
                          } as CSSProperties)
                        : undefined
                    }
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        className="mg-dt-sort"
                        onClick={() => handleSort(column.key)}
                        data-active={active ? "true" : undefined}
                      >
                        {column.label}
                        <SortIcon dir={active ? sort!.dir : null} />
                      </button>
                    ) : (
                      column.label
                    )}
                    {column.definition ? (
                      <Definition term={column.definition} />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }, (_, i) => (
                <tr key={`skeleton-${i}`} className="mg-dt-skeleton">
                  {shown.map((column) => (
                    <td
                      key={column.key}
                      data-label={
                        mobileMode === "cards" ? column.label : undefined
                      }
                    >
                      <Skeleton className="h-3 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : hasRows ? (
              visibleRows.map((row) => (
                <Row
                  key={rowKey(row)}
                  row={row}
                  entityKey={rowKey(row)}
                  expansionId={`${captionId}-${rowKey(row)}`}
                  cardLabels={mobileMode === "cards"}
                  columns={shown}
                  href={rowHref?.(row)}
                  link={link}
                  onActivate={
                    onRowActivate ? () => onRowActivate(row) : undefined
                  }
                  source={source}
                  expand={expand}
                  expanded={expanded === rowKey(row)}
                  onExpand={() =>
                    setExpanded((current) =>
                      current === rowKey(row) ? null : rowKey(row),
                    )
                  }
                />
              ))
            ) : (
              <tr className="mg-dt-state">
                <td colSpan={shown.length}>
                  {error ?? empty ?? "Nothing to show."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {paging && pages > 1 ? (
        <div className="mg-dt-footer">
          <span className="mg-dt-range">
            {rangeLabel(page, pageSize, total ?? sorted.length)}
          </span>
          <nav className="mg-dt-pager" aria-label={`${caption} pages`}>
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
            >
              Previous
            </button>
            {pageWindow(page, pages).map((p, i) =>
              p === null ? (
                <span key={`gap-${i}`} aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => goToPage(p)}
                  data-current={p === page ? "true" : undefined}
                  aria-current={p === page ? "page" : undefined}
                  aria-label={`Page ${p}`}
                >
                  {p}
                </button>
              ),
            )}
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= pages}
            >
              Next
            </button>
          </nav>
        </div>
      ) : null}
    </div>
  );
}

function Row<Row_>({
  row,
  entityKey,
  expansionId,
  columns,
  cardLabels,
  href,
  link,
  onActivate,
  source,
  expand,
  expanded,
  onExpand,
}: {
  row: Row_;
  entityKey: string;
  expansionId: string;
  columns: ReadonlyArray<DataTableColumn<Row_>>;
  /** Cells print their own label only where the cards layout reads it. */
  cardLabels: boolean;
  href?: string;
  link?: SectionNavLink;
  onActivate?: () => void;
  source: string;
  expand?: (row: Row_) => ReactNode;
  expanded: boolean;
  onExpand: () => void;
}) {
  // `expand` may decline per row -- an operator with one key has nothing to
  // reveal -- and a chevron that expands nothing is a control that lies. It
  // is also 605 chevrons of markup on a table where 500 of them do nothing.
  const expansion = expand ? expand(row) : null;
  const expandable =
    expansion !== null && expansion !== undefined && expansion !== false;
  const mark = useEntityMark(entityKey, {
    source,
    label: entityKey,
    onActivate: expandable ? onExpand : onActivate,
  });
  // The row is a grouping element, not a control: it carries the active
  // state and the pointer/keyboard wiring, but `role="button"` on a <tr>
  // would strip its row semantics from assistive tech.
  const {
    role: _role,
    tabIndex: _tabIndex,
    "aria-label": _label,
    ...rowMark
  } = mark;
  void _role;
  void _tabIndex;
  void _label;
  return (
    <>
      <tr
        {...rowMark}
        className="mg-dt-row"
        data-expandable={expandable ? "true" : undefined}
        data-expanded={expanded ? "true" : undefined}
      >
        {columns.map((column, index) => (
          <Cell
            key={column.key}
            row={row}
            column={column}
            label={cardLabels ? column.label : undefined}
            /* The first cell carries the row's link, so a row is one tab stop. */
            href={index === 0 ? href : undefined}
            link={link}
            disclosure={
              index === 0 && expandable
                ? { expanded, controls: expansionId, onToggle: onExpand }
                : undefined
            }
            onActivate={
              index === 0 && !href && !expandable ? onActivate : undefined
            }
          />
        ))}
      </tr>
      {expandable && expanded ? (
        <tr className="mg-dt-expansion" id={expansionId}>
          <td colSpan={columns.length}>{expansion}</td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The sort affordance: a two-way chevron at rest, one-way when the table is
 * ordered by this column.
 *
 * Hand-drawn rather than pulled from the icon set, because it renders once per
 * sortable header on a route carrying a payload ratchet -- lucide emits
 * `xmlns`, a 24px width/height pair, a stroke triple and a class on every
 * instance, roughly three times this (#11695). What it replaced was a 3px CSS
 * triangle at 30% opacity: invisible beside 10px uppercase text, and the only
 * thing separating "sortable" from "sorted" was that opacity, so a table
 * already ordered by a column looked identical to one that was not.
 */
function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  return (
    <svg
      className="mg-dt-sort-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {dir !== "asc" ? <path d="m7 15 5 5 5-5" /> : null}
      {dir !== "desc" ? <path d="m7 9 5-5 5 5" /> : null}
    </svg>
  );
}

function Cell<Row_>({
  row,
  column,
  label,
  href,
  link,
  onActivate,
  disclosure,
}: {
  row: Row_;
  column: DataTableColumn<Row_>;
  label?: string;
  href?: string;
  link?: SectionNavLink;
  /** Renders the cell as the row's expand/collapse control. */
  disclosure?: { expanded: boolean; controls: string; onToggle: () => void };
  onActivate?: () => void;
}) {
  const raw = column.value ? column.value(row) : undefined;
  const text = column.format
    ? column.format(raw, row)
    : defaultFormat(column.kind, raw);
  const align =
    column.align ??
    (column.kind === "number" ||
    column.kind === "delta" ||
    column.kind === "tint"
      ? "right"
      : undefined);
  const tint = column.kind === "tint" ? (column.tint?.(row) ?? null) : null;

  let body: ReactNode;
  if (column.render) body = column.render(row);
  else if (column.kind === "identifier" && typeof raw === "string" && raw)
    body = (
      <span className="mg-dt-id" title={raw}>
        <span>{truncateIdentifier(raw)}</span>
        <CopyButton value={raw} label={label ?? column.label} compact />
      </span>
    );
  else if (column.kind === "status" && typeof raw === "string" && raw)
    body = (
      <span className="mg-dt-status" data-tone={statusTone(raw)}>
        <i aria-hidden="true" />
        {raw}
      </span>
    );
  else if (column.kind === "time" && typeof raw === "string" && raw)
    body = <TimeAgo at={raw} />;
  else if (column.kind === "delta" && typeof raw === "number")
    body = (
      <span
        className="mg-dt-delta"
        data-state={raw > 0 ? "up" : raw < 0 ? "down" : "flat"}
      >
        {text}
      </span>
    );
  else if (column.kind === "link") {
    const to = column.href?.(row);
    const LinkCmp = link ?? DefaultLink;
    body = to ? (
      <LinkCmp href={to} className="mg-dt-link">
        {text}
      </LinkCmp>
    ) : (
      text
    );
  } else body = text;

  const RowLink = link ?? DefaultLink;
  // A <tr> cannot take focus, so a row whose only affordance is "expand" would
  // be mouse-only. The disclosure is a real button in the first cell, which is
  // also the only element allowed to carry aria-expanded (#8821).
  //
  // When a row has BOTH a disclosure and a link, the two are separate
  // controls in the same cell rather than one that wins. The disclosure used
  // to replace the link entirely, so an expandable table rendered ZERO
  // internal anchors -- /validators served 606 rows and 10 links, which is
  // precisely the crawlability regression #11204 exists to prevent (#11616).
  const toggle =
    disclosure === undefined ? null : (
      <button
        type="button"
        className="mg-dt-disclosure"
        aria-expanded={disclosure.expanded}
        aria-controls={disclosure.expanded ? disclosure.controls : undefined}
        aria-label={disclosure.expanded ? "Collapse row" : "Expand row"}
        onClick={(event) => {
          event.stopPropagation();
          disclosure.onToggle();
        }}
      ></button>
    );

  const linked =
    href !== undefined ? (
      <RowLink href={href} className="mg-dt-rowlink">
        {body}
      </RowLink>
    ) : null;

  const content =
    disclosure !== undefined ? (
      <span className="mg-dt-rowlead">
        {toggle}
        {linked ?? (
          <button
            type="button"
            className="mg-dt-rowbutton"
            aria-expanded={disclosure.expanded}
            aria-controls={
              disclosure.expanded ? disclosure.controls : undefined
            }
            onClick={(event) => {
              event.stopPropagation();
              disclosure.onToggle();
            }}
          >
            {body}
          </button>
        )}
      </span>
    ) : linked !== null ? (
      linked
    ) : onActivate ? (
      <button type="button" className="mg-dt-rowbutton" onClick={onActivate}>
        {body}
      </button>
    ) : (
      body
    );

  return (
    <td
      data-label={label}
      data-align={align}
      /* Read back in CSS for the third ink level: a column the table itself
         calls secondary should not shout at the same volume as the figure the
         reader came for. */
      data-demote={column.demote ? "true" : undefined}
      data-wrap={column.wrap ? "true" : undefined}
      /* Only the tint kind is read back in CSS; on a 128-row table every
         other kind attribute is dead weight in the served HTML. */
      data-kind={column.kind === "tint" ? "tint" : undefined}
      style={
        tint === null
          ? undefined
          : ({ "--tint": `${Math.round(tint * 100)}%` } as CSSProperties)
      }
    >
      {content}
    </td>
  );
}
