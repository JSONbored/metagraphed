import { Suspense, useMemo, useState, type ReactNode } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Scale, Users, BarChart3 } from "lucide-react";
import {
  subnetConcentrationQuery,
  subnetConcentrationHistoryQuery,
  subnetPerformanceQuery,
  subnetPerformanceHistoryQuery,
} from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { TableState } from "@/components/metagraphed/table-state";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { classNames } from "@/lib/metagraphed/format";
import { PROFILE_KPI_GRID_CLASS } from "@/components/metagraphed/profile-kpi-grid";
import type {
  ConcentrationMetrics,
  ConcentrationHistoryPoint,
  PerformanceHistoryPoint,
} from "@/lib/metagraphed/types";

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
      <div className={PROFILE_KPI_GRID_CLASS}>
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
      <div className="rounded-xl border border-border bg-card p-4 grid grid-cols-2 gap-3 min-[400px]:grid-cols-4">
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
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted truncate">
        {label}
      </div>
      <div className="mt-1 min-w-0 truncate font-display text-base font-semibold tabular-nums text-ink-strong leading-none min-[400px]:text-lg">
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
    <div
      role="tablist"
      aria-label="Concentration window"
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
    <div className="grid grid-cols-1 gap-1 min-[400px]:grid-cols-[minmax(0,7rem)_1fr_auto] min-[400px]:items-center min-[400px]:gap-3">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-muted">{label}</span>
      <div className="min-w-0">
        <Sparkline
          values={series}
          color={color}
          width={220}
          height={28}
          formatValue={format}
          ariaLabel={label}
        />
      </div>
      <span className="min-w-0 font-display text-sm font-semibold tabular-nums text-ink-strong min-[400px]:text-right">
        {last != null ? format(last) : "—"}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* #3477: reward-distribution tab — the reward-flow twin of the panel above.  */
/* -------------------------------------------------------------------------- */

/**
 * Reward distribution for one subnet — the reward-flow twin of {@link
 * ConcentrationLoader}. /performance is the SAME Gini / Nakamoto / HHI / top-
 * share scorecard as /concentration, computed over incentive + dividends
 * instead of stake + emission, plus the 0-1 trust / consensus / validator-trust
 * score spread. Reuses the same KPI tiles, share bars, and drift sparklines.
 */
function PerformanceLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetPerformanceQuery(netuid));
  const meta = data.meta;
  const p = data.data;
  const incentive = p.incentive;
  const dividends = p.dividends;

  const hasMetrics = Boolean(incentive?.gini != null || dividends?.gini != null);
  if (!hasMetrics) {
    return (
      <TableState
        variant="empty"
        title="No reward-distribution metrics"
        description="Incentive- and dividend-distribution metrics (Gini, HHI, Nakamoto coefficient) plus the 0-1 trust/consensus score spread are computed from the metagraph snapshot and will appear here once captured."
        generatedAt={meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI tiles — incentive-weighted (the headline reward distribution). */}
      <div className={PROFILE_KPI_GRID_CLASS}>
        <StatTile
          icon={Scale}
          eyebrow="Incentive Gini"
          value={numStr(incentive?.gini)}
          hint={dividends?.gini != null ? `dividends ${numStr(dividends.gini)}` : undefined}
          tone={giniTone(incentive?.gini)}
        />
        <StatTile
          icon={Users}
          eyebrow="Nakamoto"
          value={incentive?.nakamoto_coefficient ?? "—"}
          hint="miners to 51%"
          tone={nakamotoTone(incentive?.nakamoto_coefficient)}
        />
        <StatTile
          icon={BarChart3}
          eyebrow="Incentive HHI"
          value={numStr(incentive?.hhi)}
          hint={
            incentive?.hhi_normalized != null
              ? `norm ${numStr(incentive.hhi_normalized)}`
              : undefined
          }
          tone={giniTone(incentive?.hhi)}
        />
      </div>

      {/* Top-percentile reward share — incentive vs dividends side by side. */}
      <div className="grid gap-4 md:grid-cols-2">
        <SharePanel title="Incentive to top %" metrics={incentive} accent="var(--accent)" />
        <SharePanel title="Dividends to top %" metrics={dividends} accent="var(--health-warn)" />
      </div>

      {/* Score spread — 0-1 trust / consensus / validator-trust medians. */}
      <div className="rounded-xl border border-border bg-card p-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Trust median" value={numStr(p.trust?.p50)} />
        <Fact label="Consensus median" value={numStr(p.consensus?.p50)} />
        <Fact label="Val-trust median" value={numStr(p.validator_trust?.p50)} />
        <Fact label="Active neurons" value={p.active_count ?? p.neuron_count ?? "—"} />
      </div>

      {/* Reward-Gini drift over a window. */}
      <RewardDriftCard netuid={netuid} />
    </div>
  );
}

function RewardDriftCard({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("30d");
  const { data: res, isLoading } = useQuery(subnetPerformanceHistoryQuery(netuid, win));
  const points = useMemo<PerformanceHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const series = useMemo(() => {
    // History points arrive newest-first; reverse so the sparkline reads L→R in
    // time. Null metrics (early window) are filtered per-series, not per-point.
    const ordered = [...points].reverse();
    const pick = (key: keyof PerformanceHistoryPoint) =>
      ordered
        .map((point) => point[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return {
      incentiveGini: pick("incentive_gini"),
      dividendsGini: pick("dividends_gini"),
      incentiveTop10: pick("incentive_top_10pct_share"),
      dividendsTop10: pick("dividends_top_10pct_share"),
    };
  }, [points]);

  const hasData =
    series.incentiveGini.length +
      series.dividendsGini.length +
      series.incentiveTop10.length +
      series.dividendsTop10.length >
    0;

  const toggle = (
    <div
      role="tablist"
      aria-label="Concentration window"
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
          Reward drift
        </span>
        {toggle}
      </div>
      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : !hasData ? (
        <EmptyState
          title="No reward-drift history"
          description="Daily reward-distribution snapshots will appear here once enough chain history has accumulated."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          {series.incentiveGini.length > 0 ? (
            <DriftRow
              label="Incentive Gini"
              series={series.incentiveGini}
              color="var(--health-warn)"
              format={(v) => v.toFixed(3)}
            />
          ) : null}
          {series.dividendsGini.length > 0 ? (
            <DriftRow
              label="Dividends Gini"
              series={series.dividendsGini}
              color="var(--accent)"
              format={(v) => v.toFixed(3)}
            />
          ) : null}
          {series.incentiveTop10.length > 0 ? (
            <DriftRow
              label="Incentive top 10%"
              series={series.incentiveTop10}
              color="var(--chart-1)"
              format={(v) => `${(v * 100).toFixed(1)}%`}
            />
          ) : null}
          {series.dividendsTop10.length > 0 ? (
            <DriftRow
              label="Dividends top 10%"
              series={series.dividendsTop10}
              color="var(--chart-3)"
              format={(v) => `${(v * 100).toFixed(1)}%`}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

type DistView = "distribution" | "rewards";

/**
 * The subnet concentration panel with a stake/emission ↔ rewards tab toggle
 * (#3477). "Stake & emission" is the existing {@link ConcentrationLoader};
 * "Rewards" is the reward-flow {@link PerformanceLoader}. The toggle sits
 * outside the Suspense boundary so it stays interactive while the selected
 * view's snapshot loads.
 */
export function DistributionPanel({ netuid }: { netuid: number }) {
  const [view, setView] = useState<DistView>("distribution");
  const tabs: { id: DistView; label: string }[] = [
    { id: "distribution", label: "Stake & emission" },
    { id: "rewards", label: "Rewards" },
  ];

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-border bg-surface/40 p-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            className={classNames(
              "px-3 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
              view === t.id ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        {view === "distribution" ? (
          <ConcentrationLoader netuid={netuid} />
        ) : (
          <PerformanceLoader netuid={netuid} />
        )}
      </Suspense>
    </div>
  );
}
