/**
 * Pure geometry for `LineWithWindow` (#11608): the full-history path, the
 * window sub-path, the end marker and the window delta, computed once from
 * `{ t, v }` points into the chart's 1200×370 coordinate space (the reference
 * draws into a fixed viewBox and lets the svg scale).
 */
export interface LinePoint {
  /** Epoch milliseconds. */
  t: number;
  v: number;
}

export interface LineWindow {
  from: number;
  to: number;
}

export const LINE_VIEWBOX = { width: 1200, height: 370 } as const;
/** Room for the line and labels; the larger top inset keeps peaks out of the summary band. */
const PAD_TOP = 20;
const PAD_BOTTOM = 8;
/**
 * The last point lands at 94% of the width (the reference's
 * `--momentum-end-x: 94%`): the right 6% is the gutter the delta chip hangs
 * in, so the chip never leaves the plot.
 */
export const PLOT_RIGHT = 0.94;

export interface PlacedPoint extends LinePoint {
  x: number;
  y: number;
}

/** Scales points into the viewBox; equal time spacing is NOT assumed. */
export function placePoints(
  points: readonly LinePoint[],
  box = LINE_VIEWBOX,
  { zeroBaseline = false }: { zeroBaseline?: boolean } = {},
): PlacedPoint[] {
  if (points.length === 0) return [];
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (zeroBaseline && min >= 0) min = 0;
  const range = max - min || 1;
  return points.map((p) => ({
    ...p,
    x:
      points.length === 1
        ? (box.width * PLOT_RIGHT) / 2
        : ((p.t - t0) / span) * box.width * PLOT_RIGHT,
    y:
      box.height -
      PAD_BOTTOM -
      ((p.v - min) / range) * (box.height - PAD_TOP - PAD_BOTTOM),
  }));
}

/**
 * A smooth path through the points (Catmull-Rom → cubic Bézier, tension
 * 0.2), the way the reference's `C` commands read. One point → a dot-length
 * move; two → a straight segment.
 */
export function smoothPath(points: readonly PlacedPoint[]): string {
  if (points.length === 0) return "";
  const f = (n: number) => (Math.round(n * 100) / 100).toString();
  if (points.length === 1) return `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  let d = `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  const k = 0.2;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) * k;
    const c1y = p1.y + (p2.y - p0.y) * k;
    const c2x = p2.x - (p3.x - p1.x) * k;
    const c2y = p2.y - (p3.y - p1.y) * k;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

/** The points inside the window, inclusive, in order. */
export function windowPoints<T extends LinePoint>(
  points: readonly T[],
  window: LineWindow,
): T[] {
  return points.filter((p) => p.t >= window.from && p.t <= window.to);
}

export interface WindowDelta {
  /** First and last values inside the window. */
  start: number;
  end: number;
  /** Fractional change, e.g. 0.89 for +89%; null when the start is 0 or the window is empty. */
  ratio: number | null;
  /** "+89%" / "−12%" / "—". */
  label: string;
  state: "positive" | "negative" | "flat" | "empty";
}

export function windowDelta(
  points: readonly LinePoint[],
  window: LineWindow,
): WindowDelta {
  const inside = windowPoints(points, window);
  if (inside.length === 0)
    return { start: 0, end: 0, ratio: null, label: "—", state: "empty" };
  const start = inside[0]!.v;
  const end = inside[inside.length - 1]!.v;
  if (start === 0)
    return {
      start,
      end,
      ratio: null,
      label: "—",
      state: end > 0 ? "positive" : "flat",
    };
  const ratio = (end - start) / Math.abs(start);
  const pct = Math.round(ratio * 100);
  const label = pct === 0 ? "0%" : pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
  return {
    start,
    end,
    ratio,
    label,
    state: pct > 0 ? "positive" : pct < 0 ? "negative" : "flat",
  };
}

/** Month labels along the x-axis: one per calendar month boundary, as a % offset. */
export function monthTicks(
  points: readonly LinePoint[],
): Array<{ label: string; pct: number }> {
  if (points.length < 2) return [];
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = t1 - t0 || 1;
  const out: Array<{ label: string; pct: number }> = [];
  const d = new Date(t0);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() <= t1) {
    out.push({
      label: d
        .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
        .toUpperCase(),
      pct: ((d.getTime() - t0) / span) * 100 * PLOT_RIGHT,
    });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
