import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * The frame a data table sits in.
 *
 * Borrowed wholesale from the reference's node and miner tables: a bordered
 * panel whose header names the collection and counts it — `Nodes (156)` — with
 * the view's controls on the opposite edge, an optional live status line
 * beneath, then the table, then a footer for paging or provenance.
 *
 * This is the one place the flat-grouping rule is deliberately reversed. A
 * table is a single dense object with its own internal rules; without an outer
 * edge its header row reads as page furniture and its last row bleeds into
 * whatever follows. The reference frames every one of its tables for exactly
 * that reason, and its pages are otherwise as unboxed as ours.
 */
export function DataTableFrame({
  title,
  count,
  countLabel,
  controls,
  status,
  footer,
  children,
  className,
}: {
  /** What this table lists, e.g. "Validators". */
  title: ReactNode;
  /**
   * How many rows the collection has, shown beside the title.
   *
   * Pass a preformatted `countLabel` for anything user-visible in production —
   * this fallback groups with a plain regex rather than `toLocaleString`,
   * which resolves to the RUNTIME default and therefore renders differently on
   * the server and in the browser. `locale-hydration.test.ts` fails the build
   * over exactly that.
   */
  count?: number;
  /** Overrides the formatted count, for "1,015 of 2,000" style strings. */
  countLabel?: ReactNode;
  /** View switches and toggles, on the header's trailing edge. */
  controls?: ReactNode;
  /** A live/provenance line under the header — what this data is and how fresh. */
  status?: ReactNode;
  /** Paging, totals, or a source note. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classNames("mg-table-frame", className)}>
      <header className="mg-table-frame-head">
        <h3 className="mg-table-frame-title">
          {title}
          {countLabel != null ? (
            <span className="mg-table-frame-count">{countLabel}</span>
          ) : count != null ? (
            <span className="mg-table-frame-count">
              ({String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",")})
            </span>
          ) : null}
        </h3>
        {controls ? (
          <div className="mg-table-frame-controls">{controls}</div>
        ) : null}
      </header>
      {status ? <p className="mg-table-frame-status">{status}</p> : null}
      <div className="mg-table-frame-body">{children}</div>
      {footer ? <div className="mg-table-frame-foot">{footer}</div> : null}
    </section>
  );
}
