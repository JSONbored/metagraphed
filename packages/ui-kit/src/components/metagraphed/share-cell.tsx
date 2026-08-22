import { classNames } from "@/lib/format";

/**
 * A share, as a rail and a number in one table cell.
 *
 * Borrowed geometry: a fixed-width track with a solid fill, then the exact
 * percentage right of it. A percentage column alone makes a reader compare
 * digits down a column; the rail turns the same column into a shape you can
 * scan, without spending a second column on it.
 *
 * The track is fixed-width on purpose. A rail that sizes to its cell cannot be
 * compared between rows, which is the only thing it is for.
 */
export function ShareCell({
  share,
  label,
  className,
}: {
  /** 0–1. Values outside the range are clamped rather than overflowing. */
  share: number | null | undefined;
  /** Formatted percentage. Falls back to a derived one. */
  label?: string;
  className?: string;
}) {
  const value =
    typeof share === "number" && Number.isFinite(share)
      ? Math.min(1, Math.max(0, share))
      : null;

  if (value === null) {
    return (
      <span className={classNames("mg-share-cell-empty", className)}>—</span>
    );
  }

  return (
    <span className={classNames("mg-share-cell", className)}>
      <span className="mg-share-cell-track" aria-hidden="true">
        <span
          className="mg-share-cell-fill"
          style={{ width: `${value * 100}%` }}
        />
      </span>
      <span className="mg-share-cell-value">
        {label ?? `${(value * 100).toFixed(1)}%`}
      </span>
    </span>
  );
}
