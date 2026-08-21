// The categorical chart palette, declared once (#10987 follow-up): the
// holdings history chart and the explorer's call-mix legend each carried the
// six-swatch list privately, and a seventh chart would have made a third. The
// terminal prism now carries eleven ordered categorical series, so dense
// analytics can preserve identity without reusing mint or status colors.
export const CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
  "var(--chart-11)",
] as const;
