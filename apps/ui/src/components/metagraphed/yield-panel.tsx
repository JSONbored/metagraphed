import { useMemo, useState } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Percent, Activity, Users, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { subnetYieldQuery, subnetYieldHistoryQuery } from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { taoCompact } from "@/components/metagraphed/neuron-table";
import { TableState } from "@/components/metagraphed/table-state";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { YieldPercentileStrip } from "@/components/metagraphed/yield-percentile-strip";
import { PROFILE_KPI_GRID_CLASS } from "@/components/metagraphed/profile-kpi-grid";
import type { SubnetYieldNeuron, YieldHistoryPoint } from "@/lib/metagraphed/types";

type Win = "7d" | "30d" | "90d";
const WINDOWS: Win[] = ["7d", "30d", "90d"];
const TOP_N = 15;

import { fmtYield } from "@/components/metagraphed/yield-format";
function VsMedian({ vs }: { vs: SubnetYieldNeuron["vs_median"] }) {
  if (vs === "above")
    return (
      <span className="inline-flex items-center gap-0.5 text-health-ok" title="above median">
        <ArrowUpRight className="size-3" aria-hidden />
        <span className="sr-only">above median</span>
      </span>
    );
  if (vs === "below")
    return (
      <span className="inline-flex items-center gap-0.5 text-ink-muted" title="below median">
        <ArrowDownRight className="size-3" aria-hidden />
        <span className="sr-only">below median</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-0.5 text-ink-subtle-text" title="at median">
      <Minus className="size-3" aria-hidden />
      <span className="sr-only">at median</span>
    </span>
  );
}

/**
 * Per-UID emission yield for one subnet — the return-rate twin of the
 * Concentration panel. Distribution summary (subnet aggregate, mean, median,
 * p25/p75/p90), a validator/miner split, the ranked per-UID leaderboard (top
 * yielders), and the daily yield-distribution drift. Mirrors the concentration/
 * metagraph render primitives (StatTile / BarMini / Sparkline / table).
 */
export function YieldLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetYieldQuery(netuid));
  const meta = data.meta;
  const y = data.data;
  const neurons = y.neurons;

  const hasData = neurons.length > 0 || y.subnet_yield != null;
  if (!hasData) {
    return (
      <TableState
        variant="empty"
        title="No yield data"
        description="Per-UID emission yield (emission ÷ stake) is computed live from the neuron snapshot and will appear here once the subnet has stake and emission on-chain."
        generatedAt={meta?.generated_at}
      />
    );
  }

  // The API ranks high→low already; re-sort defensively (null yields sink).
  // Plain const (not useMemo) — this runs after the early return above, so a
  // hook here would violate the rules of hooks.
  const ranked = [...neurons]
    .sort((a, b) => (b.yield ?? Number.NEGATIVE_INFINITY) - (a.yield ?? Number.NEGATIVE_INFINITY))
    .slice(0, TOP_N);

  const splitBars = [
    { label: "Validators", value: y.validator_count ?? 0, color: "var(--accent)" },
    { label: "Miners", value: y.miner_count ?? 0, color: "var(--chart-1)" },
  ].filter((b) => b.value > 0);

  return (
    <div className="space-y-4">
      {/* KPI tiles — the headline return + central tendency. */}
      <div className={PROFILE_KPI_GRID_CLASS}>
        <StatTile
          icon={Percent}
          eyebrow="Subnet yield"
          value={fmtYield(y.subnet_yield)}
          hint="emission ÷ stake"
          tone="accent"
        />
        <StatTile
          icon={Activity}
          eyebrow="Median yield"
          value={fmtYield(y.median_yield)}
          hint={y.mean_yield != null ? `mean ${fmtYield(y.mean_yield)}` : undefined}
        />
        <StatTile
          icon={Users}
          eyebrow="Validators / miners"
          value={`${y.validator_count ?? "—"} / ${y.miner_count ?? "—"}`}
          hint={`${y.neuron_count ?? neurons.length} UIDs`}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Validator vs miner split. */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Validator / miner split
          </div>
          {splitBars.length ? (
            <BarMini data={splitBars} />
          ) : (
            <p className="font-mono text-[11px] text-ink-muted">Not enough data yet.</p>
          )}
        </div>

        {/* Yield percentile spread — container-query layout (#3934). */}
        <YieldPercentileStrip
          p25_yield={y.p25_yield}
          median_yield={y.median_yield}
          p75_yield={y.p75_yield}
          p90_yield={y.p90_yield}
        />
      </div>

      {/* Per-UID yield leaderboard (top yielders). */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
              <tr>
                <th className="px-3 py-2.5 text-left">UID</th>
                <th className="px-3 py-2.5 text-left">Hotkey</th>
                <th className="px-3 py-2.5 text-left">Role</th>
                <th className="px-3 py-2.5 text-right">Stake τ</th>
                <th className="px-3 py-2.5 text-right">Emission τ</th>
                <th className="px-3 py-2.5 text-right">Yield</th>
                <th className="px-3 py-2.5 text-center">vs median</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((n) => (
                <tr key={n.uid} className="mg-row-hover border-t border-border/60">
                  <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink-strong">
                    {n.uid}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px]">
                    {n.hotkey ? (
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: n.hotkey }}
                        className="text-ink-muted hover:text-ink hover:underline"
                        title={n.hotkey}
                      >
                        {shortHash(n.hotkey) ?? n.hotkey}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {n.role === "validator" ? (
                      <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-accent-text">
                        Validator
                      </span>
                    ) : (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                        Miner
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                    {taoCompact(n.stake_tao)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                    {taoCompact(n.emission_tao)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                    {fmtYield(n.yield)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <VsMedian vs={n.vs_median} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border/60 bg-surface/30 px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          top {ranked.length} of {neurons.length} by yield · subnet {netuid}
        </div>
      </div>

      {/* Daily yield-distribution drift. */}
      <YieldDriftCard netuid={netuid} />
    </div>
  );
}

function YieldDriftCard({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("30d");
  const { data: res, isLoading } = useQuery(subnetYieldHistoryQuery(netuid, win));
  const points = useMemo<YieldHistoryPoint[]>(() => res?.data?.points ?? [], [res?.data?.points]);

  const series = useMemo(() => {
    // History points arrive newest-first; reverse so the sparkline reads L→R in
    // time. Null metrics (early window) are filtered per-series, not per-point.
    const ordered = [...points].reverse();
    const pick = (key: keyof YieldHistoryPoint) =>
      ordered
        .map((point) => point[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return {
      subnet: pick("subnet_yield"),
      median: pick("median_yield"),
      p90: pick("p90_yield"),
    };
  }, [points]);

  const hasData = series.subnet.length + series.median.length + series.p90.length > 0;

  const toggle = (
    <div
      role="tablist"
      aria-label="Yield window"
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
          Yield drift
        </span>
        {toggle}
      </div>
      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : !hasData ? (
        <EmptyState
          title="No yield history"
          description="Daily yield-distribution snapshots will appear here once enough chain history has accumulated."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          {series.subnet.length > 0 ? (
            <DriftRow label="Subnet yield" series={series.subnet} color="var(--accent)" />
          ) : null}
          {series.median.length > 0 ? (
            <DriftRow label="Median yield" series={series.median} color="var(--chart-1)" />
          ) : null}
          {series.p90.length > 0 ? (
            <DriftRow label="p90 yield" series={series.p90} color="var(--health-warn)" />
          ) : null}
        </div>
      )}
    </div>
  );
}

function DriftRow({ label, series, color }: { label: string; series: number[]; color: string }) {
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
          formatValue={fmtYield}
          ariaLabel={label}
        />
      </div>
      <span className="min-w-0 font-display text-sm font-semibold tabular-nums text-ink-strong min-[400px]:text-right">
        {last != null ? fmtYield(last) : "—"}
      </span>
    </div>
  );
}
