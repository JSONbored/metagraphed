import type { LinePoint } from "@jsonbored/ui-kit";

/**
 * One `LineWithWindow` with a metric picker (#11608): the replacement for
 * the label / sparkline / last-value rows the history charts stacked per
 * metric. One big chart that answers "how did X move?" for the metric you
 * chose beats six 28px sparklines that answer nothing; the window the data
 * was fetched for is the chart's window, so the delta chip reads as the
 * change over the selected range.
 */
export interface MetricHistorySeries {
  key: string;
  label: string;
  /** What the series counts, for the summary line: "neurons", "TAO staked". */
  unit: string;
  points: LinePoint[];
  format: (v: number) => string;
}

/** A `YYYY-MM-DD` day or an ISO timestamp → epoch ms (UTC). NaN when unparseable. */
export function dayToMs(day: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00Z` : day);
}

/** Rows → chronological line points, dropping rows with no finite value or date. */
export function toLinePoints<T>(
  rows: readonly T[],
  date: (row: T) => string | null | undefined,
  value: (row: T) => unknown,
): LinePoint[] {
  const out: LinePoint[] = [];
  for (const row of rows) {
    const d = date(row);
    const v = value(row);
    if (!d || typeof v !== "number" || !Number.isFinite(v)) continue;
    const t = dayToMs(d);
    if (!Number.isFinite(t)) continue;
    out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}
