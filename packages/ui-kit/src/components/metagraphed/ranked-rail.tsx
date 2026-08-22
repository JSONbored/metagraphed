import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export interface RankedRailItem {
  /** Stable identity, also the expansion key. */
  id: string;
  /** The name being ranked. */
  label: ReactNode;
  /** Formatted headline measure, shown left of the label. */
  valueLabel: ReactNode;
  /** The measure itself, used to size the rail. Non-finite reads as absent. */
  value: number;
  /** One quiet supporting line, e.g. "86 subnets · take 9–18%". */
  meta?: ReactNode;
  /** Optional media (an operator logo), sized by the row. */
  media?: ReactNode;
  /** Expanded detail. Providing it makes the row a disclosure. */
  detail?: ReactNode;
}

/**
 * A ranked comparison of one measure across named things.
 *
 * Value first, then the name, then a rail proportional to the largest entry —
 * so the eye reads the number, the name, and the shape of the distribution in
 * that order without a table's column overhead. Rows carry no borders or
 * cards; the rail and the rhythm do the work.
 *
 * A row with `detail` becomes a real disclosure: this is how a directory shows
 * an operator's 86 subnet positions without ranking 86 rows at the top level.
 */
export function RankedRailList({
  items,
  ariaLabel,
  max,
  emptyLabel = "Nothing to rank yet.",
  className,
}: {
  items: readonly RankedRailItem[];
  ariaLabel: string;
  /** Rail scale. Defaults to the largest value present. */
  max?: number;
  emptyLabel?: string;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="mg-ranked-rail-empty" role="status">
        {emptyLabel}
      </p>
    );
  }

  // Scaled against the largest entry, not an absolute ceiling: a ranked view
  // is a comparison, and an arbitrary ceiling would flatten a tight field into
  // a row of identical stubs.
  const scale =
    max ??
    Math.max(
      0,
      ...items.map((item) => (Number.isFinite(item.value) ? item.value : 0)),
    );

  return (
    <ul
      className={classNames("mg-ranked-rail", className)}
      aria-label={ariaLabel}
    >
      {items.map((item, index) => {
        const value = Number.isFinite(item.value) ? Math.max(0, item.value) : 0;
        const fraction = scale > 0 ? value / scale : 0;

        const body = (
          <>
            <span className="mg-ranked-rail-rank" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="mg-ranked-rail-value">{item.valueLabel}</span>
            {/* ALWAYS rendered, even when empty. The row is a fixed grid, so
                a conditionally-omitted cell slid every following column left
                and broke the shared left edge the rails depend on. */}
            <span className="mg-ranked-rail-media" aria-hidden="true">
              {item.media}
            </span>
            <span className="mg-ranked-rail-body">
              <span className="mg-ranked-rail-label">{item.label}</span>
              {item.meta ? (
                <span className="mg-ranked-rail-meta">{item.meta}</span>
              ) : null}
            </span>
            <span className="mg-ranked-rail-track" aria-hidden="true">
              <span
                className="mg-ranked-rail-fill"
                style={{ width: `${Math.min(100, fraction * 100)}%` }}
              />
            </span>
          </>
        );

        return (
          <li key={item.id} className="mg-ranked-rail-item">
            {item.detail ? (
              // A native <details>, not a React-state toggle. The contents stay
              // in the server-rendered DOM whether or not anyone opens them,
              // which is what keeps every one of an operator's keys reachable
              // by a crawler — the exact regression #11231 was filed for.
              // Browsers skip layout for closed details, so the collapsed cost
              // is bytes only.
              <details className="mg-ranked-rail-details">
                <summary className="mg-ranked-rail-row mg-focus-ring">
                  {body}
                  <span className="mg-ranked-rail-caret" aria-hidden="true" />
                </summary>
                <div className="mg-ranked-rail-detail">{item.detail}</div>
              </details>
            ) : (
              <div className="mg-ranked-rail-row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
