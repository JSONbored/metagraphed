import { classNames } from "@/lib/format";
import { windowDelta, type LinePoint } from "./line-geometry";

/**
 * The window's change as the reference's leader-card chip: `+89%` in the
 * good colour, `−12%` in the bad one, `—` muted when the start is zero or
 * the series is empty. This is what a table cell or a list row shows
 * instead of a 44×14 sparkline nobody can read (#11608): the number that
 * the sparkline was trying to say.
 */
export interface TrendDeltaProps {
  /** Oldest → newest. */
  values: readonly number[];
  /** Accessible name prefix, e.g. "7d price"; the chip reads "7d price +4%". */
  label: string;
  className?: string;
}

export function trendDeltaOf(values: readonly number[]) {
  const points: LinePoint[] = values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .map((v, i) => ({ t: i, v }));
  return windowDelta(points, {
    from: 0,
    to: Math.max(0, points.length - 1),
  });
}

export function TrendDelta({ values, label, className }: TrendDeltaProps) {
  const delta = trendDeltaOf(values);
  return (
    <span
      className={classNames("mg-line-delta", className)}
      data-state={delta.state}
      aria-label={`${label} ${delta.label}`}
    >
      {delta.label}
    </span>
  );
}
