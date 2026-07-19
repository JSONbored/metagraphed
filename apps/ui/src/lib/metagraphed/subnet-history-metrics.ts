import { healthColorVar } from "@/lib/health-tokens";
import { formatTao } from "@/lib/metagraphed/format";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

/**
 * Shared vocabulary for the /subnets/{netuid}/history series (#1302), extracted
 * from subnet-history-chart.tsx so the single-subnet chart and the compare
 * drawer's multi-subnet overlay (#6885) can never disagree about which windows
 * and metrics exist. The single-subnet chart colours each metric differently;
 * the overlay colours each SUBNET differently (SUBNET_SERIES_COLORS below),
 * since there the metric is fixed and the subnet is the varying dimension.
 */

// Lowercase windows, mirroring the /history API + the inline toggle conventions
// used by health-trends.tsx. "all" maps to the API's widest supported window.
export type SubnetHistoryWindow = "7d" | "30d" | "90d" | "1y" | "all";
export const SUBNET_HISTORY_WINDOWS: readonly SubnetHistoryWindow[] = [
  "7d",
  "30d",
  "90d",
  "1y",
  "all",
];

export type SubnetHistoryMetricKey = "neurons" | "validators" | "stake" | "emission";

/** A numeric field of SubnetHistoryPoint the chart can plot. */
type SubnetHistoryField =
  "neuron_count" | "validator_count" | "total_stake_tao" | "total_emission_tao";

export interface SubnetHistoryMetric {
  key: SubnetHistoryMetricKey;
  label: string;
  field: SubnetHistoryField;
  /** Per-metric colour, used by the single-subnet chart only. */
  color: string;
  /**
   * Value formatter. Deliberately optional: the count metrics render through
   * the Sparkline/legend default so their display is unchanged by this
   * extraction — only the τ-denominated metrics override it.
   */
  format?: (v: number) => string;
}

export const SUBNET_HISTORY_METRICS: readonly SubnetHistoryMetric[] = [
  { key: "neurons", label: "Neurons", field: "neuron_count", color: "var(--accent)" },
  {
    key: "validators",
    label: "Validators",
    field: "validator_count",
    color: healthColorVar("ok"),
  },
  {
    key: "stake",
    label: "Total stake",
    field: "total_stake_tao",
    color: healthColorVar("warn"),
    format: formatTao,
  },
  {
    key: "emission",
    label: "Total emission",
    field: "total_emission_tao",
    color: "var(--accent)",
    format: formatTao,
  },
];

/**
 * Categorical series colours for the overlay, one per selected subnet. Follows
 * the `--chart-N` token convention (styles.css) and the existing modulo idiom
 * (explorer.tsx's CALL_MIX_PALETTE, providers.index.tsx's kindPalette). Four
 * entries covers useCompareSelection's MAX of 4; the modulo keeps it correct if
 * that cap ever rises.
 */
export const SUBNET_SERIES_COLORS: readonly string[] = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
];

export function subnetSeriesColor(index: number): string {
  return SUBNET_SERIES_COLORS[index % SUBNET_SERIES_COLORS.length]!;
}

/** Pull the finite values of one metric out of a subnet's history points. */
export function pickMetricValues(
  points: readonly SubnetHistoryPoint[],
  field: SubnetHistoryField,
): number[] {
  return points
    .map((p) => p[field])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export interface SubnetHistoryInput {
  netuid: number;
  points: readonly SubnetHistoryPoint[];
}

export interface OverlaySeries {
  netuid: number;
  color: string;
  /**
   * SVG path data in the requested viewBox. Empty string when this subnet has
   * no finite value for the metric — the legend still lists it, so the user can
   * see that the subnet was included but had nothing to plot.
   */
  path: string;
  /** Most recent finite value, for the legend readout. */
  last: number | null;
}

export interface OverlayGeometry {
  /** Union of snapshot dates across all subnets, ascending — the shared x axis. */
  dates: readonly string[];
  series: readonly OverlaySeries[];
  /** Shared y domain, so the series are directly comparable against each other. */
  min: number;
  max: number;
}

const PAD = 2;

/**
 * Project several subnets' history onto ONE set of shared axes.
 *
 * x is the union of snapshot dates (subnets registered at different times have
 * different-length series, so indexing each series by its own position would
 * silently misalign them in time). y is a single domain spanning every series,
 * which is what makes the overlay a real comparison rather than four
 * independently-normalised lines that imply a similarity that isn't there.
 *
 * A subnet missing a date the union has leaves a gap: the path starts a new
 * subpath rather than interpolating across it, so absent data never renders as
 * a straight line that looks like real measurement.
 *
 * Returns null when no subnet has a single finite value for the metric.
 */
export function buildOverlayGeometry(
  inputs: readonly SubnetHistoryInput[],
  field: SubnetHistoryField,
  width: number,
  height: number,
): OverlayGeometry | null {
  const valueByDate = inputs.map((input) => {
    const map = new Map<string, number>();
    for (const p of input.points) {
      const v = p[field];
      if (typeof p.snapshot_date === "string" && typeof v === "number" && Number.isFinite(v)) {
        map.set(p.snapshot_date, v);
      }
    }
    return map;
  });

  const dateSet = new Set<string>();
  for (const map of valueByDate) for (const date of map.keys()) dateSet.add(date);
  // ISO-8601 dates sort correctly as plain strings.
  const dates = [...dateSet].sort();
  if (dates.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const map of valueByDate) {
    for (const v of map.values()) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const span = max - min;
  const innerHeight = height - PAD * 2;
  const step = dates.length > 1 ? width / (dates.length - 1) : 0;
  const round = (n: number) => Math.round(n * 100) / 100;

  const series = inputs.map((input, i) => {
    const map = valueByDate[i]!;
    // Contiguous runs of present dates; a missing date closes the current run.
    const runs: Array<Array<[number, number]>> = [];
    let run: Array<[number, number]> = [];
    let last: number | null = null;

    for (let di = 0; di < dates.length; di += 1) {
      const v = map.get(dates[di]!);
      if (v === undefined) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      last = v;
      // A flat series (span 0) sits on the vertical centre rather than pinned to
      // an edge, matching how a single-value Sparkline reads.
      const x = dates.length > 1 ? di * step : width / 2;
      const y = span === 0 ? height / 2 : height - PAD - ((v - min) / span) * innerHeight;
      run.push([round(x), round(y)]);
    }
    if (run.length > 0) runs.push(run);

    // A lone point is emitted as a zero-length line so stroke-linecap="round"
    // renders it as a dot — a bare moveto would draw nothing at all.
    const path = runs
      .map((r) =>
        r.length === 1
          ? `M${r[0]![0]} ${r[0]![1]}L${r[0]![0]} ${r[0]![1]}`
          : r.map(([x, y], j) => `${j === 0 ? "M" : "L"}${x} ${y}`).join(""),
      )
      .join("");

    return { netuid: input.netuid, color: subnetSeriesColor(i), path, last };
  });

  return { dates, series, min, max };
}
