import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetNeuronHistoryQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { classNames, formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { SubnetNeuronHistoryPoint } from "@/lib/metagraphed/types";

type Win = "7d" | "30d" | "90d" | "1y" | "all";
const WINDOWS: Win[] = ["7d", "30d", "90d", "1y", "all"];

function scoreStr(v?: number) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(3);
}

/**
 * Per-UID on-chain history (#1302). Mirrors SubnetHistoryChart: a window
 * selector drives a daily snapshot series; each metric (emission, incentive,
 * consensus, dividends, stake, rank) renders as a labelled Sparkline row.
 * Consumes the already-wired subnetNeuronHistoryQuery.
 */
export function NeuronHistoryChart({ netuid, uid }: { netuid: number; uid: number }) {
  const [win, setWin] = useState<Win>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetNeuronHistoryQuery(netuid, uid, win));
  const points = useMemo<SubnetNeuronHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const series = useMemo(() => {
    const pick = (key: keyof SubnetNeuronHistoryPoint) =>
      points
        .map((p) => p[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return {
      stake: pick("stake_tao"),
      emission: pick("emission_tao"),
      incentive: pick("incentive"),
      consensus: pick("consensus"),
      dividends: pick("dividends"),
      rank: pick("rank"),
    };
  }, [points]);

  const hasData = Object.values(series).some((s) => s.length > 0);

  const windowSelector = (
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
            "px-2.5 py-1 mg-type-label uppercase rounded transition-colors",
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
        <span className="mg-type-micro text-ink-muted">UID {uid} history</span>
        {windowSelector}
      </div>
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="per-UID history" />
      ) : !hasData ? (
        <EmptyState
          title="No per-UID history"
          description="Daily snapshots for this neuron will appear here once enough chain history has accumulated."
        />
      ) : (
        <Panel as="div" dense bodyClassName="space-y-3">
          {series.stake.length > 0 ? (
            <HistoryRow
              label="Stake"
              series={series.stake}
              color="var(--accent)"
              format={formatTao}
            />
          ) : null}
          {series.emission.length > 0 ? (
            <HistoryRow
              label="Emission"
              series={series.emission}
              color="var(--health-warn)"
              format={formatTao}
            />
          ) : null}
          {series.incentive.length > 0 ? (
            <HistoryRow
              label="Incentive"
              series={series.incentive}
              color="var(--chart-1)"
              format={scoreStr}
            />
          ) : null}
          {series.consensus.length > 0 ? (
            <HistoryRow
              label="Consensus"
              series={series.consensus}
              color="var(--chart-3)"
              format={scoreStr}
            />
          ) : null}
          {series.dividends.length > 0 ? (
            <HistoryRow
              label="Dividends"
              series={series.dividends}
              color="var(--health-ok)"
              format={scoreStr}
            />
          ) : null}
          {series.rank.length > 0 ? (
            <HistoryRow label="Rank" series={series.rank} color="var(--chart-6)" />
          ) : null}
        </Panel>
      )}
    </div>
  );
}

function HistoryRow({
  label,
  series,
  color,
  format,
}: {
  label: string;
  series: number[];
  color: string;
  format?: (v: number) => string;
}) {
  const last = series[series.length - 1];
  const display =
    last == null ? "—" : format ? format(last) : Number.isFinite(last) ? formatNumber(last) : "—";
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 mg-type-label uppercase text-ink-muted">{label}</span>
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
        {display}
      </span>
    </div>
  );
}
