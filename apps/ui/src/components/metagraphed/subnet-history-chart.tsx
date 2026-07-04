import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

// Lowercase windows, mirroring the /history API + the inline toggle conventions
// used by health-trends.tsx. "all" maps to the API's widest supported window.
type Win = "7d" | "30d" | "90d" | "1y" | "all";
const WINDOWS: Win[] = ["7d", "30d", "90d", "1y", "all"];

function taoStr(v?: number) {
  if (v == null || !Number.isFinite(v)) return "—";
  // Stake/emission can span a wide range; keep it compact and readable.
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  return `${v.toFixed(v < 10 ? 3 : 2)} τ`;
}

/**
 * Per-subnet on-chain history (#1302). A window selector drives a daily snapshot
 * series; each metric renders as a labelled Sparkline row (mirrors
 * subnet-growth-card.tsx's GrowthRow). Optional detail — renders null when the
 * subnet has no history yet, so it never clutters a cold profile.
 */
export function SubnetHistoryChart({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("90d");
  const { data: res, isLoading } = useQuery(subnetHistoryQuery(netuid, win));
  const points = useMemo<SubnetHistoryPoint[]>(() => res?.data?.points ?? [], [res?.data?.points]);

  const series = useMemo(() => {
    const pick = (key: keyof SubnetHistoryPoint) =>
      points
        .map((p) => p[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return {
      neurons: pick("neuron_count"),
      validators: pick("validator_count"),
      stake: pick("total_stake_tao"),
      emission: pick("total_emission_tao"),
    };
  }, [points]);

  const hasData =
    series.neurons.length +
      series.validators.length +
      series.stake.length +
      series.emission.length >
    0;

  const windowSelector = (
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
      <div className="flex items-center justify-end">{windowSelector}</div>
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !hasData ? (
        <EmptyState
          title="No on-chain history"
          description="Daily snapshots will appear here once enough chain history has accumulated for this subnet."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          {series.neurons.length > 0 ? (
            <HistoryRow label="Neurons" series={series.neurons} color="var(--accent, #7aa2ff)" />
          ) : null}
          {series.validators.length > 0 ? (
            <HistoryRow
              label="Validators"
              series={series.validators}
              color="var(--health-ok, #4ade80)"
            />
          ) : null}
          {series.stake.length > 0 ? (
            <HistoryRow
              label="Total stake"
              series={series.stake}
              color="var(--health-warn, #fbbf24)"
              format={taoStr}
            />
          ) : null}
          {series.emission.length > 0 ? (
            <HistoryRow
              label="Total emission"
              series={series.emission}
              color="var(--accent, #7aa2ff)"
              format={taoStr}
            />
          ) : null}
        </div>
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
