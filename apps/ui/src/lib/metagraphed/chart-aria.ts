/** Label/value pair used by BarMini and Donut aria synthesis. */
export interface ChartAriaDatum {
  label: string;
  value: number;
}

/** Join segment labels for `role="img"` aria-labels (matches MiniStack in stat-with-spark). */
export function chartSegmentsAriaLabel(segments: ChartAriaDatum[]): string {
  return segments.map((s) => `${s.label} ${s.value}`).join(", ");
}

export function synthesizeBarMiniAriaLabel(data: ChartAriaDatum[]): string {
  if (data.length === 0) return "Bar chart with no data";
  return chartSegmentsAriaLabel(data);
}

export function synthesizeDonutAriaLabel(segments: ChartAriaDatum[]): string {
  if (segments.length === 0) return "Donut chart with no data";
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total <= 0) return "Donut chart with no data";
  return chartSegmentsAriaLabel(segments);
}
