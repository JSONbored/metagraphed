// #6885: pure series-building for the compare drawer's multi-subnet history
// overlay. Aligns N subnets' /subnets/{netuid}/history point arrays (which can
// differ in length and date coverage) onto one shared, sorted date axis for a
// single chosen metric, and computes the shared min/max so every line is drawn
// to the same scale. Kept side-effect-free and separate from the SVG component
// so this alignment logic is unit-testable without rendering (the repo's
// convention for router/query-bound chart components — see
// validator-dominance-ranking.ts).
import type { SubnetHistoryPoint } from "./types";

export type OverlayMetric = "neurons" | "validators" | "stake" | "emission";

// The same four metrics subnet-history-chart.tsx already surfaces, mapped to
// their SubnetHistoryPoint fields. `tao` marks a τ-denominated value so the UI
// formats it with formatTao rather than formatNumber.
export const OVERLAY_METRICS: {
  key: OverlayMetric;
  label: string;
  field: keyof SubnetHistoryPoint;
  tao: boolean;
}[] = [
  { key: "stake", label: "Total stake", field: "total_stake_tao", tao: true },
  {
    key: "emission",
    label: "Total emission",
    field: "total_emission_tao",
    tao: true,
  },
  { key: "neurons", label: "Neurons", field: "neuron_count", tao: false },
  { key: "validators", label: "Validators", field: "validator_count", tao: false },
];

export interface OverlaySeries {
  netuid: number;
  color: string;
  // One entry per shared date (OverlayChartData.dates), null where this subnet
  // has no snapshot on that date so the line can break rather than interpolate.
  values: (number | null)[];
  hasData: boolean;
  // The subnet's most recent finite value for the metric (for the legend), or
  // null when it has none.
  lastValue: number | null;
}

export interface OverlayChartData {
  dates: string[];
  series: OverlaySeries[];
  min: number;
  max: number;
  empty: boolean;
}

/**
 * Align each subnet's history points onto a shared sorted date axis for one
 * metric, colouring series by their position in `colors` (cycled). `min`/`max`
 * span every finite value across all subnets; `empty` is true when no subnet
 * has a single finite value for the metric (a cold overlay renders nothing).
 */
export function buildOverlaySeries(
  histories: { netuid: number; points: SubnetHistoryPoint[] }[],
  metric: OverlayMetric,
  colors: string[],
): OverlayChartData {
  const def = OVERLAY_METRICS.find((m) => m.key === metric) ?? OVERLAY_METRICS[0];
  const field = def.field;

  const dateSet = new Set<string>();
  for (const history of histories) {
    for (const point of history.points) {
      if (typeof point.snapshot_date === "string") {
        dateSet.add(point.snapshot_date);
      }
    }
  }
  const dates = [...dateSet].sort();

  let min = Infinity;
  let max = -Infinity;

  const series: OverlaySeries[] = histories.map((history, index) => {
    const byDate = new Map<string, number>();
    for (const point of history.points) {
      const value = point[field];
      if (
        typeof point.snapshot_date === "string" &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        byDate.set(point.snapshot_date, value);
      }
    }

    let hasData = false;
    let lastValue: number | null = null;
    const values = dates.map((date) => {
      const value = byDate.get(date);
      if (value === undefined) return null;
      hasData = true;
      lastValue = value;
      if (value < min) min = value;
      if (value > max) max = value;
      return value;
    });

    return {
      netuid: history.netuid,
      color: colors[index % colors.length],
      values,
      hasData,
      lastValue,
    };
  });

  const empty = !series.some((s) => s.hasData);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }

  return { dates, series, min, max, empty };
}
