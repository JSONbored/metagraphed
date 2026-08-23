import { useMemo, useState } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { subnetYieldQuery, subnetYieldHistoryQuery } from "@/lib/metagraphed/queries";
import {
  fmtYield,
  FactStrip,
  FactCell,
  RangeControl,
  CompositionBreakdown,
  MarkerRail,
  DataTable,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { RouterLink } from "@/components/metagraphed/router-link";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import {
  MetricHistory,
  toLinePoints,
  type MetricHistorySeries,
} from "@/components/metagraphed/metric-history";
import { Panel } from "@/components/metagraphed/primitives";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import type { SubnetYieldNeuron, YieldHistoryPoint } from "@/lib/metagraphed/types";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";
import { formatNumber } from "@/lib/metagraphed/format";

// The route's own published windows (#10994).
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/subnets/{netuid}/yield/history"].window;
type Win = (typeof WINDOWS)[number];
const TOP_N = 15;

function VsMedian({ vs }: { vs: SubnetYieldNeuron["vs_median"] }) {
  if (vs === "above")
    return (
      <span className="inline-flex items-center gap-0.5 text-health-ok">
        <ArrowUpRight className="size-3" aria-hidden />
        <span className="sr-only">above median</span>
      </span>
    );
  if (vs === "below")
    return (
      <span className="inline-flex items-center gap-0.5 text-ink-muted">
        <ArrowDownRight className="size-3" aria-hidden />
        <span className="sr-only">below median</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-0.5 text-ink-subtle-text">
      <Minus className="size-3" aria-hidden />
      <span className="sr-only">at median</span>
    </span>
  );
}

const tao = (value: unknown) => taoCompact(typeof value === "number" ? value : null);

const YIELD_COLUMNS: Array<DataTableColumn<SubnetYieldNeuron>> = [
  { key: "uid", label: "UID", kind: "number", align: "left", sortable: true, value: (n) => n.uid },
  {
    key: "hotkey",
    label: "Hotkey",
    value: (n) => n.hotkey ?? null,
    render: (n) => (
      <AddressDisplay
        ss58={n.hotkey}
        fallback={<>—</>}
        compact
        valueClassName="text-ink-muted hover:text-ink"
      />
    ),
  },
  {
    key: "role",
    label: "Role",
    value: (n) => (n.role === "validator" ? "Validator" : "Miner"),
    render: (n) =>
      n.role === "validator" ? (
        <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-13 text-accent-text">
          Validator
        </span>
      ) : (
        <span className="text-13 text-ink-muted">Miner</span>
      ),
  },
  {
    key: "stake",
    label: "Stake τ",
    kind: "number",
    sortable: true,
    value: (n) => n.stake_tao,
    format: tao,
  },
  {
    key: "emission",
    label: "Emission τ",
    kind: "number",
    sortable: true,
    value: (n) => n.emission_tao,
    format: tao,
  },
  {
    key: "yield",
    label: "Yield",
    kind: "number",
    sortable: true,
    value: (n) => n.yield,
    format: (v) => fmtYield(typeof v === "number" ? v : null),
  },
  {
    key: "vs_median",
    label: "vs median",
    align: "left",
    value: (n) => n.vs_median ?? null,
    render: (n) => <VsMedian vs={n.vs_median} />,
  },
];

/**
 * Per-UID emission yield for one subnet — the return-rate twin of the
 * Concentration panel. Distribution summary (subnet aggregate, mean, median,
 * p25/p75/p90), a validator/miner split, the ranked per-UID leaderboard (top
 * yielders), and the daily yield-distribution drift. Mirrors the concentration/
 * metagraph render primitives (FactCell / MarkerRail / LineWithWindow / table).
 */
export function YieldLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetYieldQuery(netuid));
  const meta = data.meta;
  const y = data.data;
  const neurons = y.neurons;

  const hasData = neurons.length > 0 || y.subnet_yield != null;
  if (!hasData) {
    return (
      <EmptyState
        title="No yield data"
        description="Per-UID emission yield (emission ÷ stake) is computed live from the neuron snapshot and will appear here once the subnet has stake and emission on-chain."
        lastChecked={meta?.generated_at}
      />
    );
  }

  // The API ranks high→low already; re-sort defensively (null yields sink).
  // Plain const (not useMemo) — this runs after the early return above, so a
  // hook here would violate the rules of hooks.
  const ranked = [...neurons]
    .sort((a, b) => (b.yield ?? Number.NEGATIVE_INFINITY) - (a.yield ?? Number.NEGATIVE_INFINITY))
    .slice(0, TOP_N);

  const split = [
    { key: "validators", label: "Validators", value: y.validator_count ?? 0 },
    { key: "miners", label: "Miners", value: y.miner_count ?? 0 },
  ].filter((b) => b.value > 0);
  const percentiles = [
    { key: "p25", label: "p25", value: y.p25_yield ?? null },
    { key: "median", label: "Median", value: y.median_yield ?? null },
    { key: "p75", label: "p75", value: y.p75_yield ?? null },
    { key: "p90", label: "p90", value: y.p90_yield ?? null },
  ];
  const percentileMax = Math.max(
    0,
    ...percentiles.map((p) => (p.value != null && Number.isFinite(p.value) ? p.value : 0)),
  );

  return (
    <div className="space-y-4">
      {/* KPI tiles — the headline return + central tendency. */}
      <FactStrip>
        <FactCell label="Subnet yield" value={fmtYield(y.subnet_yield)} hint="emission ÷ stake" />
        <FactCell
          label="Median yield"
          value={fmtYield(y.median_yield)}
          hint={y.mean_yield != null ? `mean ${fmtYield(y.mean_yield)}` : undefined}
        />
        <FactCell
          label="Validators / miners"
          value={`${y.validator_count ?? "—"} / ${y.miner_count ?? "—"}`}
          hint={`${y.neuron_count ?? neurons.length} UIDs`}
        />
      </FactStrip>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Validator / miner split">
          {split.length ? (
            <CompositionBreakdown
              segments={split}
              formatValue={(v) => formatNumber(v)}
              legendCols={3}
              ariaLabel="Validator / miner split"
            />
          ) : (
            <p className="text-11 text-ink-muted">Not enough data yet.</p>
          )}
        </Panel>
        <Panel title="Yield spread">
          {percentileMax > 0 ? (
            <MarkerRail
              items={percentiles}
              max={percentileMax}
              formatValue={fmtYield}
              columns={{
                ratio: "Yield",
                name: "Percentile",
                scale: `0–${fmtYield(percentileMax)}`,
              }}
              ariaLabel="Yield percentiles across UIDs"
            />
          ) : (
            <p className="text-11 text-ink-muted">Not enough data yet.</p>
          )}
        </Panel>
      </div>

      {/* Per-UID yield leaderboard (top yielders). */}
      <div className="space-y-2">
        <DataTable
          rows={ranked}
          columns={YIELD_COLUMNS}
          rowKey={(n) => String(n.uid)}
          caption="Top yielders"
          link={RouterLink}
          storageKey="subnet-yield"
          // Seven columns: below 640px the yield and vs-median cells -- the two
          // the section exists for -- fall off a horizontal scroll nobody makes.
          mobile="cards"
        />
        <p className="text-13 text-ink-muted">
          top {ranked.length} of {neurons.length} by yield · subnet {netuid}
        </p>
      </div>

      {/* Daily yield-distribution drift. */}
      <YieldDriftCard netuid={netuid} />
    </div>
  );
}

function YieldDriftCard({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("30d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetYieldHistoryQuery(netuid, win));
  const points = useMemo<YieldHistoryPoint[]>(() => res?.data?.points ?? [], [res?.data?.points]);

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof YieldHistoryPoint) =>
      toLinePoints(
        points,
        (p) => p.snapshot_date,
        (p) => p[key],
      );
    return [
      {
        key: "subnet",
        label: "Subnet yield",
        unit: "subnet yield",
        points: pick("subnet_yield"),
        format: fmtYield,
      },
      {
        key: "median",
        label: "Median yield",
        unit: "median yield",
        points: pick("median_yield"),
        format: fmtYield,
      },
      {
        key: "p90",
        label: "p90 yield",
        unit: "p90 yield",
        points: pick("p90_yield"),
        format: fmtYield,
      },
    ];
  }, [points]);

  const hasData = metrics.some((m) => m.points.length > 0);

  const toggle = (
    <RangeControl
      label="Yield window"
      options={WINDOWS.map((w) => ({ value: w, label: String(w) }))}
      value={win}
      onChange={setWin}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-13 text-ink-muted">Yield drift</span>
        {toggle}
      </div>
      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="yield drift" />
      ) : !hasData ? (
        <EmptyState
          title="No yield history"
          description="Daily yield-distribution snapshots will appear here once enough chain history has accumulated."
        />
      ) : (
        <MetricHistory id="subnet-yield-drift" metrics={metrics} ariaLabel="Yield drift" />
      )}
    </div>
  );
}
