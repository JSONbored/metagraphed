import { formatNumber, formatTao } from "./format";
import type { SubnetHistoryPoint } from "./types";

/**
 * Metric picker + overlay-model helpers for the compare drawer's chart tab
 * (#6885). Kept pure so tests can drive it without React or a QueryClient —
 * the component only owns fetching and rendering.
 */

/** Metrics matching the per-subnet SubnetHistoryChart's rows. */
export type OverlayMetric = "neurons" | "validators" | "stake" | "emission";

export const OVERLAY_METRICS: readonly OverlayMetric[] = [
  "neurons",
  "validators",
  "stake",
  "emission",
] as const;

export const OVERLAY_METRIC_LABEL: Record<OverlayMetric, string> = {
  neurons: "Neurons",
  validators: "Validators",
  stake: "Total stake",
  emission: "Total emission",
};

const METRIC_KEY: Record<OverlayMetric, keyof SubnetHistoryPoint> = {
  neurons: "neuron_count",
  validators: "validator_count",
  stake: "total_stake_tao",
  emission: "total_emission_tao",
};

/** Chart color tokens, mirroring providers.index.tsx's palette usage. */
export const OVERLAY_COLORS: readonly string[] = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

export function overlayColor(index: number): string {
  return OVERLAY_COLORS[Math.abs(index) % OVERLAY_COLORS.length]!;
}

export interface OverlayInputSeries {
  netuid: number;
  points: SubnetHistoryPoint[];
}

export interface OverlaySeriesPoint {
  t: number;
  v: number;
}

export interface OverlaySeries {
  netuid: number;
  points: OverlaySeriesPoint[];
}

export interface OverlayModel {
  series: OverlaySeries[];
  tMin: number;
  tMax: number;
  vMin: number;
  vMax: number;
}

function parseSnapshotDate(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Build the overlay model from per-subnet history: pick the requested metric,
 * coerce to finite numbers, sort each series by snapshot date, and compute a
 * shared x/y range so every series scales to the same axes. Series with no
 * finite points are still returned (empty points array) so the legend row
 * stays lined up with the input order.
 */
export function buildOverlayModel(
  inputs: readonly OverlayInputSeries[],
  metric: OverlayMetric,
): OverlayModel {
  const key = METRIC_KEY[metric];
  const series: OverlaySeries[] = inputs.map((input) => {
    const pts: OverlaySeriesPoint[] = [];
    for (const p of input.points) {
      const t = parseSnapshotDate(p.snapshot_date);
      const raw = p[key];
      if (t == null) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      pts.push({ t, v: raw });
    }
    pts.sort((a, b) => a.t - b.t);
    return { netuid: input.netuid, points: pts };
  });

  let tMin = Number.POSITIVE_INFINITY;
  let tMax = Number.NEGATIVE_INFINITY;
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;
  for (const s of series) {
    for (const p of s.points) {
      if (p.t < tMin) tMin = p.t;
      if (p.t > tMax) tMax = p.t;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
  }

  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    tMin = 0;
    tMax = 0;
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
    vMin = 0;
    vMax = 0;
  }

  return { series, tMin, tMax, vMin, vMax };
}

/** Metric-aware value formatter for the legend and tooltips. */
export function formatOverlayValue(metric: OverlayMetric, v: number): string {
  if (metric === "stake" || metric === "emission") return formatTao(v);
  return formatNumber(v);
}

/**
 * Total point count across every series — a simple "has any data" signal the
 * component uses to switch between the empty-state and the chart.
 */
export function overlayTotalPoints(model: OverlayModel): number {
  let n = 0;
  for (const s of model.series) n += s.points.length;
  return n;
}
