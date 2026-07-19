import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { compareQuery, subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { classNames, formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

// #6885: overlay several selected subnets' /history on ONE chart, one series per
// subnet, so the compare drawer can show trends over time (not just the instant
// side-by-side metrics in CompareGrid). Reuses the /subnets/{netuid}/history
// endpoint and the same window + metric set the single-subnet SubnetHistoryChart
// exposes; the tiny multi-line SVG mirrors Sparkline's coordinate math rather
// than pulling in a charting library (the app ships none).

type Win = "7d" | "30d" | "90d" | "1y" | "all";
const WINDOWS: Win[] = ["7d", "30d", "90d", "1y", "all"];

const METRICS = [
  { key: "total_stake_tao", label: "Total stake", format: formatTao },
  { key: "total_emission_tao", label: "Total emission", format: formatTao },
  { key: "neuron_count", label: "Neurons", format: formatNumber },
  { key: "validator_count", label: "Validators", format: formatNumber },
] as const satisfies ReadonlyArray<{
  key: keyof SubnetHistoryPoint;
  label: string;
  format: (v: number) => string;
}>;
type MetricKey = (typeof METRICS)[number]["key"];

// On-token series palette, cycled per subnet (same convention as the masthead
// event-category stack). Up to the compare cap; wraps if ever exceeded.
const SERIES_COLORS = [
  "var(--accent)",
  "var(--health-ok)",
  "var(--health-warn)",
  "var(--ink-strong)",
  "var(--health-down)",
  "var(--ink-muted)",
] as const;

const W = 560;
const H = 200;
const PAD = { top: 10, right: 10, bottom: 10, left: 10 };

type Series = { netuid: number; name: string; color: string; points: Array<[number, number]> };

// Map each subnet's history to (timestamp, value) pairs for the chosen metric,
// then project every series onto ONE shared time-x / value-y domain so the lines
// are directly comparable. Subnets registered later simply start further right.
function buildSeries(
  netuids: number[],
  histories: Array<SubnetHistoryPoint[] | undefined>,
  names: Map<number, string>,
  metric: MetricKey,
): { series: Series[]; hasData: boolean } {
  const raw = netuids.map((netuid, i) => {
    const pts = (histories[i] ?? [])
      .map((p) => {
        const t = Date.parse(String(p.snapshot_date));
        const v = p[metric];
        return typeof v === "number" && Number.isFinite(v) && Number.isFinite(t)
          ? ([t, v] as [number, number])
          : null;
      })
      .filter((x): x is [number, number] => x !== null);
    return {
      netuid,
      name: names.get(netuid) ?? `Subnet ${netuid}`,
      color: SERIES_COLORS[i % SERIES_COLORS.length]!,
      points: pts,
    };
  });

  const all = raw.flatMap((s) => s.points);
  if (all.length === 0) return { series: [], hasData: false };
  let tMin = all[0]![0];
  let tMax = all[0]![0];
  let vMin = all[0]![1];
  let vMax = all[0]![1];
  for (const [t, v] of all) {
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const tSpan = tMax - tMin || 1;
  const vSpan = vMax - vMin || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const series = raw
    .filter((s) => s.points.length > 0)
    .map((s) => ({
      ...s,
      points: s.points.map(
        ([t, v]) =>
          [
            PAD.left + ((t - tMin) / tSpan) * innerW,
            PAD.top + (1 - (v - vMin) / vSpan) * innerH,
          ] as [number, number],
      ),
    }));
  return { series, hasData: true };
}

export function SubnetsOverlayChart({ netuids }: { netuids: number[] }) {
  const [win, setWin] = useState<Win>("90d");
  const [metric, setMetric] = useState<MetricKey>("total_stake_tao");

  const historyResults = useQueries({
    queries: netuids.map((netuid) => subnetHistoryQuery(netuid, win)),
  });
  const { data: compareData } = useQuery({ ...compareQuery(netuids), retry: 0 });

  const names = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of compareData?.data?.subnets ?? [])
      m.set(s.netuid, s.name ?? `Subnet ${s.netuid}`);
    return m;
  }, [compareData]);

  const isLoading = historyResults.some((r) => r.isLoading);
  const histories = historyResults.map((r) => r.data?.data?.points);
  const { series, hasData } = useMemo(
    () => buildSeries(netuids, histories, names, metric),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [netuids, JSON.stringify(histories.map((h) => h?.length ?? 0)), names, metric],
  );

  const activeMetric = METRICS.find((m) => m.key === metric)!;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Overlay metric" className="inline-flex flex-wrap gap-1">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={m.key === metric}
              onClick={() => setMetric(m.key)}
              className={classNames(
                "rounded border px-2 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors",
                m.key === metric
                  ? "border-accent/40 bg-accent/10 text-accent-text"
                  : "border-border bg-card text-ink-muted hover:text-ink-strong",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div
          role="tablist"
          aria-label="History window"
          className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={w === win}
              onClick={() => setWin(w)}
              className={classNames(
                "rounded px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors",
                w === win ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-52 w-full" />
      ) : !hasData ? (
        <EmptyState
          title="No overlapping history"
          description="Daily snapshots will appear here once enough chain history has accumulated for the selected subnets."
        />
      ) : (
        <>
          <div className="rounded-xl border border-border bg-card p-3">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="block h-52 w-full"
              role="img"
              aria-label={`${activeMetric.label} over time, one line per selected subnet`}
            >
              {series.map((s) => (
                <polyline
                  key={s.netuid}
                  points={s.points.map(([x, y]) => `${x},${y}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {series.map((s) => (
              <li key={s.netuid} className="inline-flex items-center gap-1.5 text-[11px]">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-sm"
                  style={{ background: s.color }}
                />
                <span className="font-medium text-ink-strong">{s.name}</span>
                <span className="font-mono text-ink-muted">#{s.netuid}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
