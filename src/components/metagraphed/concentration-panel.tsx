import { useMemo, useState, type ReactNode } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Scale, Users, BarChart3 } from "lucide-react";
import {
  subnetConcentrationQuery,
  subnetConcentrationHistoryQuery,
} from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { TableState } from "@/components/metagraphed/table-state";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { classNames } from "@/lib/metagraphed/format";
import type { ConcentrationMetrics, ConcentrationHistoryPoint } from "@/lib/metagraphed/types";

type Win = "7d" | "30d" | "90d";
const WINDOWS: Win[] = ["7d", "30d", "90d"];

function numStr(v?: number | null, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

// A higher Gini / HHI means more concentration (worse decentralization); a
// higher Nakamoto coefficient means more resilient. Map each to a tone so the
// KPI border/icon reads the right way.
function giniTone(g?: number): "ok" | "warn" | "down" | "default" {
  if (g == null) return "default";
  if (g >= 0.85) return "down";
  if (g >= 0.6) return "warn";
  return "ok";
}
function nakamotoTone(n?: number): "ok" | "warn" | "down" | "default" {
  if (n == null) return "default";
  if (n <= 1) return "down";
  if (n <= 3) return "warn";
  return "ok";
}

/**
 * Stake/emission concentration for one subnet: Gini / Nakamoto / HHI KPI tiles,
 * a top-1/5/10/20% share bar chart, and Gini-drift sparklines over a window.
 */
export function ConcentrationLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetConcentrationQuery(netuid));
  const meta = data.meta;
  const c = data.data;
  const stake = c.stake;
  const emission = c.emission;

  const hasMetrics = Boolean(stake?.gini != null || emission?.gini != null);
  if (!hasMetrics) {
    return (
      <TableState
        variant="empty"
        title="No concentration metrics"
        description="Stake- and emission-distribution metrics (Gini, HHI, Nakamoto coefficient) are computed from the metagraph snapshot and will appear here once captured."
        generatedAt={meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI tiles — stake-weighted by default (the headline distribution). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          icon={Scale}
          eyebrow="Stake Gini"
          value={numStr(stake?.gini)}
          hint={emission?.gini != null ? `emission ${numStr(emission.gini)}` : undefined}
          tone={giniTone(stake?.gini)}
        />
        <StatTile
          icon={Users}
          eyebrow="Nakamoto"
          value={stake?.nakamoto_coefficient ?? "—"}
          hint="entities to 51%"
          tone={nakamotoTone(stake?.nakamoto_coefficient)}
        />
        <StatTile
          icon={BarChart3}
          eyebrow="Stake HHI"
          value={numStr(stake?.hhi)}
          hint={stake?.hhi_normalized != null ? `norm ${numStr(stake.hhi_normalized)}` : undefined}
          tone={giniTone(stake?.hhi)}
        />
      </div>

      {/* Top-percentile share — stake vs emission side by side. */}
      <div className="grid gap-4 md:grid-cols-2">
        <SharePanel title="Stake held by top %" metrics={stake} accent="var(--accent)" />
        <SharePanel title="Emission to top %" metrics={emission} accent="var(--health-warn)" />
      </div>

      {/* Holders / entity context strip. */}
      <div className="rounded-xl border border-border bg-card p-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Stake holders" value={stake?.holders ?? "—"} />
        <Fact label="Emission holders" value={emission?.holders ?? "—"} />
        <Fact label="Entities" value={c.entity_count ?? "—"} />
        <Fact
          label="UIDs / entity"
          value={c.uids_per_entity != null ? c.uids_per_entity.toFixed(2) : "—"}
        />
      </div>

      {/* Gini drift over a window. */}
      <DriftCard netuid={netuid} />
    </div>
  );
}

function SharePanel({
  title,
  metrics,
  accent,
}: {
  title: string;
  metrics?: ConcentrationMetrics;
  accent: string;
}) {
  const bars = [
    { label: "Top 1%", value: pctToBar(metrics?.top_1pct_share), color: accent },
    { label: "Top 5%", value: pctToBar(metrics?.top_5pct_share), color: accent },
    { label: "Top 10%", value: pctToBar(metrics?.top_10pct_share), color: accent },
    { label: "Top 20%", value: pctToBar(metrics?.top_20pct_share), color: accent },
  ];
  const allEmpty = bars.every((b) => b.value === 0);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {title}
      </div>
      {allEmpty ? (
        <p className="font-mono text-[11px] text-ink-muted">Not enough data yet.</p>
      ) : (
        <BarMini data={bars} max={100} />
      )}
    </div>
  );
}

// BarMini renders integer values; convert a 0..1 share to a 0..100 percentage.
function pctToBar(v?: number | null): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </div>
      <div className="mt-1 font-display text-lg font-semibold tabular-nums text-ink-strong leading-none">
        {value}
      </div>
    </div>
  );
}

function DriftCard({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("30d");
  const { data: res, isLoading } = useQuery(subnetConcentrationHistoryQuery(netuid, win));
  const points = useMemo<ConcentrationHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const series = useMemo(() => {
    // History points arrive newest-first; reverse so the sparkline reads L→R in
    // time. Null metrics (early window) are filtered per-series, not per-point.
    const ordered = [...points].reverse();
    const pick = (key: keyof ConcentrationHistoryPoint) =>
      ordered
        .map((p) => p[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return {
      stakeGini: pick("stake_gini"),
      emissionGini: pick("emission_gini"),
      stakeTop10: pick("stake_top_10pct_share"),
      emissionTop10: pick("emission_top_10pct_share"),
    };
  }, [points]);

  const hasData =
    series.stakeGini.length +
      series.emissionGini.length +
      series.stakeTop10.length +
      series.emissionTop10.length >
    0;

  const toggle = (
    <div className="inline-flex rounded-md border border-border bg-surface/40 p-0.5">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => setWin(w)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            w === win ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Concentration drift
        </span>
        {toggle}
      </div>
      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : !hasData ? (
        <EmptyState
          title="No drift history"
          description="Daily concentration snapshots will appear here once enough chain history has accumulated."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          {series.stakeGini.length > 0 ? (
            <DriftRow
              label="Stake Gini"
              series={series.stakeGini}
              color="var(--health-warn)"
              format={(v) => v.toFixed(3)}
            />
          ) : null}
          {series.emissionGini.length > 0 ? (
            <DriftRow
              label="Emission Gini"
              series={series.emissionGini}
              color="var(--accent)"
              format={(v) => v.toFixed(3)}
            />
          ) : null}
          {series.stakeTop10.length > 0 ? (
            <DriftRow
              label="Stake top 10%"
              series={series.stakeTop10}
              color="var(--chart-1)"
              format={(v) => `${(v * 100).toFixed(1)}%`}
            />
          ) : null}
          {series.emissionTop10.length > 0 ? (
            <DriftRow
              label="Emission top 10%"
              series={series.emissionTop10}
              color="var(--chart-3)"
              format={(v) => `${(v * 100).toFixed(1)}%`}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function DriftRow({
  label,
  series,
  color,
  format,
}: {
  label: string;
  series: number[];
  color: string;
  format: (v: number) => string;
}) {
  const last = series[series.length - 1];
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <Sparkline
          values={series}
          color={color}
          width={220}
          height={28}
          formatValue={format}
          ariaLabel={label}
        />
      </div>
      <span className="w-20 shrink-0 text-right font-display text-sm font-semibold tabular-nums text-ink-strong">
        {last != null ? format(last) : "—"}
      </span>
    </div>
  );
}
