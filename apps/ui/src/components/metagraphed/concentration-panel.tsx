import { Suspense, useMemo, useState, type ReactNode } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import {
  subnetConcentrationQuery,
  subnetConcentrationHistoryQuery,
  subnetPerformanceQuery,
  subnetPerformanceHistoryQuery,
} from "@/lib/metagraphed/queries";
import { BarMini, FactStrip, FactCell, RangeControl } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import {
  MetricHistory,
  toLinePoints,
  type MetricHistorySeries,
} from "@/components/metagraphed/metric-history";
import { classNames } from "@/lib/metagraphed/format";
import { Panel } from "@/components/metagraphed/primitives";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";
import type {
  ConcentrationMetrics,
  ConcentrationHistoryPoint,
  PerformanceHistoryPoint,
} from "@/lib/metagraphed/types";

// The route's own published windows (#10994).
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/subnets/{netuid}/concentration/history"].window;
type Win = (typeof WINDOWS)[number];

function numStr(v?: number | null, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

// A higher Gini / HHI means more concentration (worse decentralization); a
// higher Nakamoto coefficient means more resilient. Map each to a tone so the
// KPI border/icon reads the right way.
/**
 * Stake/emission concentration for one subnet: Gini / Nakamoto / HHI KPI tiles,
 * a top-1/5/10/20% share bar chart, and Gini-drift sparklines over a window.
 */
export function ConcentrationLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetConcentrationQuery(netuid));
  const c = data.data;
  const stake = c.stake;
  const emission = c.emission;

  const hasMetrics = Boolean(stake?.gini != null || emission?.gini != null);
  if (!hasMetrics) {
    return (
      <EmptyState
        title="No concentration metrics"
        description="Stake- and emission-distribution metrics (Gini, HHI, Nakamoto coefficient) are computed from the metagraph snapshot and will appear here once captured."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI tiles — stake-weighted by default (the headline distribution). */}
      <FactStrip>
        <FactCell
          label="Stake Gini"
          value={numStr(stake?.gini)}
          hint={emission?.gini != null ? `emission ${numStr(emission.gini)}` : undefined}
        />
        <FactCell
          label="Nakamoto"
          value={stake?.nakamoto_coefficient ?? "—"}
          hint="entities to 51%"
        />
        <FactCell
          label="Stake HHI"
          value={numStr(stake?.hhi)}
          hint={stake?.hhi_normalized != null ? `norm ${numStr(stake.hhi_normalized)}` : undefined}
        />
      </FactStrip>

      {/* Top-percentile share — stake vs emission side by side. */}
      <div className="grid gap-4 md:grid-cols-2">
        <SharePanel title="Stake held by top %" metrics={stake} accent="var(--accent)" />
        <SharePanel title="Emission to top %" metrics={emission} accent="var(--health-warn)" />
      </div>

      {/* Holders / entity context strip. */}
      <Panel bodyClassName="grid grid-cols-2 gap-3 min-[400px]:grid-cols-4">
        <Fact label="Stake holders" value={stake?.holders ?? "—"} />
        <Fact label="Emission holders" value={emission?.holders ?? "—"} />
        <Fact label="Entities" value={c.entity_count ?? "—"} />
        <Fact
          label="UIDs / entity"
          value={c.uids_per_entity != null ? c.uids_per_entity.toFixed(2) : "—"}
        />
      </Panel>

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
    <Panel>
      <div className="mb-3 text-13 text-ink-muted">{title}</div>
      {allEmpty ? (
        <p className="text-11 text-ink-muted">Not enough data yet.</p>
      ) : (
        <BarMini data={bars} max={100} />
      )}
    </Panel>
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
      <div className="text-13 text-ink-muted truncate">{label}</div>
      <div className="mt-1 min-w-0 truncate font-display text-16 font-semibold tabular-nums text-ink-strong leading-none min-[400px]:text-16">
        {value}
      </div>
    </div>
  );
}

function DriftCard({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("30d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetConcentrationHistoryQuery(netuid, win));
  const points = useMemo<ConcentrationHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof ConcentrationHistoryPoint) =>
      toLinePoints(
        points,
        (p) => p.snapshot_date,
        (p) => p[key],
      );
    return [
      {
        key: "stakeGini",
        label: "Stake Gini",
        unit: "stake Gini",
        points: pick("stake_gini"),
        format: (v) => v.toFixed(3),
      },
      {
        key: "emissionGini",
        label: "Emission Gini",
        unit: "emission Gini",
        points: pick("emission_gini"),
        format: (v) => v.toFixed(3),
      },
      {
        key: "stakeTop10",
        label: "Stake top 10%",
        unit: "stake share of the top 10%",
        points: pick("stake_top_10pct_share"),
        format: (v) => `${(v * 100).toFixed(1)}%`,
      },
      {
        key: "emissionTop10",
        label: "Emission top 10%",
        unit: "emission share of the top 10%",
        points: pick("emission_top_10pct_share"),
        format: (v) => `${(v * 100).toFixed(1)}%`,
      },
    ];
  }, [points]);

  const hasData = metrics.some((m) => m.points.length > 0);

  const toggle = (
    <RangeControl
      label="Concentration window"
      options={WINDOWS.map((w) => ({ value: w, label: String(w) }))}
      value={win}
      onChange={setWin}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-13 text-ink-muted">Concentration drift</span>
        {toggle}
      </div>
      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="concentration drift" />
      ) : !hasData ? (
        <EmptyState
          title="No drift history"
          description="Daily concentration snapshots will appear here once enough chain history has accumulated."
        />
      ) : (
        <MetricHistory
          id="subnet-concentration-drift"
          metrics={metrics}
          ariaLabel="Concentration drift"
        />
      )}
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
  const p = data.data;
  const incentive = p.incentive;
  const dividends = p.dividends;

  const hasMetrics = Boolean(incentive?.gini != null || dividends?.gini != null);
  if (!hasMetrics) {
    return (
      <EmptyState
        title="No reward-distribution metrics"
        description="Incentive- and dividend-distribution metrics (Gini, HHI, Nakamoto coefficient) plus the 0-1 trust/consensus score spread are computed from the metagraph snapshot and will appear here once captured."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI tiles — incentive-weighted (the headline reward distribution). */}
      <FactStrip>
        <FactCell
          label="Incentive Gini"
          value={numStr(incentive?.gini)}
          hint={dividends?.gini != null ? `dividends ${numStr(dividends.gini)}` : undefined}
        />
        <FactCell
          label="Nakamoto"
          value={incentive?.nakamoto_coefficient ?? "—"}
          hint="miners to 51%"
        />
        <FactCell
          label="Incentive HHI"
          value={numStr(incentive?.hhi)}
          hint={
            incentive?.hhi_normalized != null
              ? `norm ${numStr(incentive.hhi_normalized)}`
              : undefined
          }
        />
      </FactStrip>

      {/* Top-percentile reward share — incentive vs dividends side by side. */}
      <div className="grid gap-4 md:grid-cols-2">
        <SharePanel title="Incentive to top %" metrics={incentive} accent="var(--accent)" />
        <SharePanel title="Dividends to top %" metrics={dividends} accent="var(--health-warn)" />
      </div>

      {/* Score spread — 0-1 trust / consensus / validator-trust medians. */}
      <Panel bodyClassName="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Trust median" value={numStr(p.trust?.p50)} />
        <Fact label="Consensus median" value={numStr(p.consensus?.p50)} />
        <Fact label="Val-trust median" value={numStr(p.validator_trust?.p50)} />
        <Fact label="Active neurons" value={p.active_count ?? p.neuron_count ?? "—"} />
      </Panel>

      {/* Reward-Gini drift over a window. */}
      <RewardDriftCard netuid={netuid} />
    </div>
  );
}

function RewardDriftCard({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("30d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetPerformanceHistoryQuery(netuid, win));
  const points = useMemo<PerformanceHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof PerformanceHistoryPoint) =>
      toLinePoints(
        points,
        (p) => p.snapshot_date,
        (p) => p[key],
      );
    return [
      {
        key: "incentiveGini",
        label: "Incentive Gini",
        unit: "incentive Gini",
        points: pick("incentive_gini"),
        format: (v) => v.toFixed(3),
      },
      {
        key: "dividendsGini",
        label: "Dividends Gini",
        unit: "dividends Gini",
        points: pick("dividends_gini"),
        format: (v) => v.toFixed(3),
      },
      {
        key: "incentiveTop10",
        label: "Incentive top 10%",
        unit: "incentive share of the top 10%",
        points: pick("incentive_top_10pct_share"),
        format: (v) => `${(v * 100).toFixed(1)}%`,
      },
      {
        key: "dividendsTop10",
        label: "Dividends top 10%",
        unit: "dividends share of the top 10%",
        points: pick("dividends_top_10pct_share"),
        format: (v) => `${(v * 100).toFixed(1)}%`,
      },
    ];
  }, [points]);

  const hasData = metrics.some((m) => m.points.length > 0);

  const toggle = (
    <RangeControl
      label="Concentration window"
      options={WINDOWS.map((w) => ({ value: w, label: String(w) }))}
      value={win}
      onChange={setWin}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-13 text-ink-muted">Reward drift</span>
        {toggle}
      </div>
      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="reward drift" />
      ) : !hasData ? (
        <EmptyState
          title="No reward-drift history"
          description="Daily reward-distribution snapshots will appear here once enough chain history has accumulated."
        />
      ) : (
        <MetricHistory id="subnet-reward-drift" metrics={metrics} ariaLabel="Reward drift" />
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
      <div className="inline-flex rounded border border-border bg-surface p-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            className={classNames(
              "px-3 py-1 text-11 rounded transition-colors",
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
