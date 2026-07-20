import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

// #6885: overlay model for the compare drawer's multi-subnet history chart. Pure
// so the metric-extraction / series-alignment logic is unit-tested independent of
// the React chart. Reuses the same metric keys subnet-history-chart.tsx already
// exposes per subnet — no new metric is invented.

export type OverlayMetric =
  "neuron_count" | "validator_count" | "total_stake_tao" | "total_emission_tao";

export const OVERLAY_METRICS: { key: OverlayMetric; label: string; isTao: boolean }[] = [
  { key: "total_stake_tao", label: "Total stake", isTao: true },
  { key: "total_emission_tao", label: "Total emission", isTao: true },
  { key: "neuron_count", label: "Neurons", isTao: false },
  { key: "validator_count", label: "Validators", isTao: false },
];

// The app's dedicated 6-slot chart palette (--chart-1..6 in ui-kit's theme), so
// each overlaid subnet series gets a distinct, theme-aware color. Cycles if there
// are more subnets than colors (the compare cap keeps this small in practice).
export const OVERLAY_SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export function overlaySeriesColor(index: number): string {
  return OVERLAY_SERIES_COLORS[index % OVERLAY_SERIES_COLORS.length]!;
}

export interface SubnetHistory {
  netuid: number;
  points: SubnetHistoryPoint[];
}

export interface OverlaySeries {
  netuid: number;
  color: string;
  /** Finite metric values in chronological order (oldest→newest), API order preserved. */
  values: number[];
  /** The most recent finite value, or null when the series is empty. */
  last: number | null;
}

/**
 * Build one overlay series per subnet for the chosen metric. Subnets with no
 * finite values for that metric are dropped (so an empty subnet never renders a
 * flat/blank line); the returned array preserves input order for stable colors.
 */
export function buildOverlaySeries(
  histories: readonly SubnetHistory[],
  metric: OverlayMetric,
): OverlaySeries[] {
  const out: OverlaySeries[] = [];
  histories.forEach((h, i) => {
    const values = (h.points ?? [])
      .map((p) => p[metric])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length === 0) return;
    out.push({
      netuid: h.netuid,
      color: overlaySeriesColor(i),
      values,
      last: values[values.length - 1] ?? null,
    });
  });
  return out;
}

/** Shared [min,max] domain across every overlaid series, so they're comparable on
 *  one axis. Returns null when there's nothing to plot. */
export function overlayDomain(
  series: readonly OverlaySeries[],
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}
