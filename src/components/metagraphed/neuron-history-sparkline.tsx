import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetNeuronHistoryQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import type { SubnetNeuronHistoryPoint } from "@/lib/metagraphed/types";

/**
 * Per-UID on-chain history (#1302), MVP. A compact dual sparkline of a single
 * neuron's emission + incentive over a window — built to drop into a row-click
 * drawer/modal once the subnet page grows a neurons/metagraph table. There is no
 * per-UID route yet, so this is exported as a standalone, reusable component.
 */
export function NeuronHistorySparkline({
  netuid,
  uid,
  window = "90d",
}: {
  netuid: number;
  uid: number;
  window?: string;
}) {
  const { data: res, isLoading } = useQuery(subnetNeuronHistoryQuery(netuid, uid, window));
  const points = useMemo<SubnetNeuronHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const emission = useMemo(
    () =>
      points
        .map((p) => p.emission_tao)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    [points],
  );
  const incentive = useMemo(
    () =>
      points
        .map((p) => p.incentive)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    [points],
  );

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (emission.length + incentive.length === 0) {
    return (
      <EmptyState
        title="No history for this neuron"
        description="Per-UID daily snapshots will appear once enough chain history has accumulated."
      />
    );
  }

  return (
    <div className="space-y-3">
      {emission.length > 0 ? (
        <NeuronRow label="Emission" series={emission} color="var(--accent, #7aa2ff)" suffix=" τ" />
      ) : null}
      {incentive.length > 0 ? (
        <NeuronRow label="Incentive" series={incentive} color="var(--health-ok, #4ade80)" />
      ) : null}
    </div>
  );
}

function NeuronRow({
  label,
  series,
  color,
  suffix,
}: {
  label: string;
  series: number[];
  color: string;
  suffix?: string;
}) {
  const last = series[series.length - 1]!;
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <Sparkline
          values={series}
          color={color}
          width={200}
          height={28}
          formatValue={(v) => `${v < 10 ? v.toFixed(4) : v.toFixed(2)}${suffix ?? ""}`}
        />
      </div>
      <span className="w-24 shrink-0 text-right font-display text-sm font-semibold tabular-nums text-ink-strong">
        {Number.isFinite(last)
          ? `${last < 10 ? last.toFixed(4) : last.toFixed(2)}${suffix ?? ""}`
          : "—"}
      </span>
    </div>
  );
}
