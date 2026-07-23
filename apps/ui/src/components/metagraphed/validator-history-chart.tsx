import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { validatorHistoryQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { healthColorVar } from "@/lib/health-tokens";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { ValidatorHistoryPoint } from "@/lib/metagraphed/types";

// Lowercase windows, matching the /history API's window enum.
type Win = "7d" | "30d" | "90d" | "1y" | "all";
const WINDOWS: Win[] = ["7d", "30d", "90d", "1y", "all"];

function taoStr(v?: number) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  return `${v.toFixed(v < 10 ? 3 : 2)} τ`;
}

function rewardsStr(v?: number) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(4)} τ/1k`;
}

/** Staked-over-time + rewards-per-1000-TAO daily history for one validator
 * (#4337/7.3), reusing the neuron_daily rollup. Mirrors subnet-history-chart.tsx's
 * window selector + stacked HistoryRow pattern. Renders null-safe empty state when
 * the validator has no history yet (e.g. a freshly-registered hotkey). */
export function ValidatorHistoryChart({ hotkey }: { hotkey: string }) {
  const [win, setWin] = useState<Win>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(validatorHistoryQuery(hotkey, win));
  const points = useMemo<ValidatorHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const series = useMemo(() => {
    const pick = (key: keyof ValidatorHistoryPoint) =>
      points
        .map((p) => p[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return {
      stake: pick("total_stake_tao"),
      rewards: pick("rewards_per_1000_tao"),
    };
  }, [points]);

  const hasData = series.stake.length + series.rewards.length > 0;

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
      <div className="flex items-center justify-end">{windowSelector}</div>
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="validator history" />
      ) : !hasData ? (
        <EmptyState
          title="No history yet"
          description="Daily snapshots will appear here once enough chain history has accumulated for this validator."
        />
      ) : (
        <Panel as="div" dense bodyClassName="space-y-3">
          {series.stake.length > 0 ? (
            <HistoryRow
              label="Staked"
              series={series.stake}
              color={healthColorVar("warn")}
              format={taoStr}
            />
          ) : null}
          {series.rewards.length > 0 ? (
            <HistoryRow
              label="Rewards / 1k τ"
              series={series.rewards}
              color="var(--accent)"
              format={rewardsStr}
            />
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
  const last = series[series.length - 1]!;
  const display = format ? format(last) : Number.isFinite(last) ? formatNumber(last) : "—";
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <Sparkline values={series} color={color} width={220} height={28} formatValue={format} />
      </div>
      <span className="w-20 shrink-0 text-right font-display text-sm font-semibold tabular-nums text-ink-strong">
        {display}
      </span>
    </div>
  );
}
