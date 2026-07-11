import { useMemo, useState, type ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Boxes, Layers, ShieldCheck } from "lucide-react";
import { subnetMetagraphQuery } from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import { TableState } from "@/components/metagraphed/table-state";
import { NeuronTable, taoCompact } from "@/components/metagraphed/neuron-table";
import { FreshnessIndicator } from "@/components/metagraphed/freshness";
import { classNames } from "@/lib/metagraphed/format";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

const TOP_N = 12;

/**
 * Metagraph table + stake-distribution chart for one subnet. A validator-permit
 * filter toggle narrows the 256-row set; rows drill into the per-UID snapshot
 * via `onSelect` (the parent owns the `?uid=` search param).
 */
export function MetagraphTableLoader({
  netuid,
  onSelect,
  selectedUid,
}: {
  netuid: number;
  onSelect?: (uid: number) => void;
  selectedUid?: number | null;
}) {
  const { data } = useSuspenseQuery(subnetMetagraphQuery(netuid));
  const meta = data.meta;
  const neurons = data.data.neurons;
  const [permitOnly, setPermitOnly] = useState(false);

  const filtered = useMemo(
    () => (permitOnly ? neurons.filter((n) => n.validator_permit) : neurons),
    [neurons, permitOnly],
  );

  // Stake distribution across the top-N UIDs (desc), so the chart stays legible
  // for a full 256-neuron metagraph.
  const stakeBars = useMemo(() => {
    return [...filtered]
      .filter((n) => typeof n.stake_tao === "number" && n.stake_tao > 0)
      .sort((a, b) => (b.stake_tao ?? 0) - (a.stake_tao ?? 0))
      .slice(0, TOP_N)
      .map((n) => ({
        label: `#${n.uid}`,
        value: Number((n.stake_tao ?? 0).toFixed(0)),
        color: n.validator_permit ? "var(--accent)" : "var(--chart-1)",
      }));
  }, [filtered]);

  const summary = useMemo(() => deriveSummary(neurons), [neurons]);

  if (neurons.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No metagraph snapshot"
        description="No live neuron snapshot is indexed for this subnet yet — stake, emission, rank, and validator permits will appear here once the metagraph is captured."
        generatedAt={meta?.generated_at}
      />
    );
  }

  const freshnessBadge = <DailyRollupFreshness at={meta?.generated_at} />;

  return (
    <div className="space-y-4">
      {/* KPI strip — neuron + validator counts and the dominant-UID stake share. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          icon={Boxes}
          eyebrow="Neurons"
          value={summary.neuronCount}
          hint={data.data.neuron_count ? `cap ${data.data.neuron_count}` : undefined}
        />
        <StatTile
          icon={ShieldCheck}
          eyebrow="Validators"
          value={summary.validatorCount}
          hint="with permit"
          tone="accent"
        />
        <StatTile
          icon={Layers}
          eyebrow="Top-UID stake"
          value={summary.topShare == null ? "—" : `${(summary.topShare * 100).toFixed(0)}%`}
          hint="of total"
          tone={summary.topShare != null && summary.topShare > 0.5 ? "warn" : "default"}
        />
      </div>

      {/* Stake distribution across the leading UIDs. */}
      {stakeBars.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <StakeDistributionHeader
            count={stakeBars.length}
            peakValue={stakeBars[0]?.value}
            freshness={freshnessBadge}
          />
          <BarMini data={stakeBars} />
        </div>
      ) : (
        <div className="flex justify-end rounded-xl border border-border bg-card px-4 py-3">
          {freshnessBadge}
        </div>
      )}

      {/* Permit filter + sortable neuron table. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {filtered.length} of {neurons.length} neurons
        </span>
        <button
          type="button"
          onClick={() => setPermitOnly((v) => !v)}
          aria-pressed={permitOnly}
          className={classNames(
            "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors",
            permitOnly
              ? "border-accent/40 bg-accent-surface text-accent-text"
              : "border-border bg-surface/40 text-ink-muted hover:text-ink-strong",
          )}
        >
          <ShieldCheck className="size-3" aria-hidden />
          Validators only
        </button>
      </div>

      <NeuronTable
        netuid={netuid}
        rows={filtered}
        defaultField="stake_tao"
        onSelect={onSelect}
        selectedUid={selectedUid}
      />
    </div>
  );
}

function DailyRollupFreshness({ at }: { at?: string | null }) {
  return (
    <div className="flex items-center gap-2 self-start shrink-0">
      <span className="inline-flex items-center rounded-full border border-border bg-surface/50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted">
        Daily rollup
      </span>
      <FreshnessIndicator at={at} />
    </div>
  );
}

function StakeDistributionHeader({
  count,
  peakValue,
  freshness,
}: {
  count: number;
  peakValue?: number;
  freshness: ReactNode;
}) {
  return (
    <header className="mb-3 space-y-2 border-b border-border/60 pb-3 sm:space-y-0">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="mg-label">Stake distribution</p>
          <p className="mt-1 font-mono text-[11px] leading-snug text-ink-subtle">
            Top {count} UIDs
            {peakValue != null ? (
              <>
                <span aria-hidden className="mx-1.5 text-ink-subtle/40">
                  ·
                </span>
                Peak <span className="text-ink-muted">{taoCompact(peakValue)} τ</span>
              </>
            ) : null}
          </p>
        </div>
        {freshness}
      </div>
    </header>
  );
}

function deriveSummary(neurons: MetagraphNeuron[]) {
  let total = 0;
  let top = 0;
  let validatorCount = 0;
  for (const n of neurons) {
    if (n.validator_permit) validatorCount += 1;
    const s = typeof n.stake_tao === "number" && Number.isFinite(n.stake_tao) ? n.stake_tao : 0;
    total += s;
    if (s > top) top = s;
  }
  return {
    neuronCount: neurons.length,
    validatorCount,
    topShare: total > 0 ? top / total : null,
  };
}
