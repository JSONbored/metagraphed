import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQueries } from "@tanstack/react-query";
import { Suspense, useMemo, useState } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Activity, Boxes, Coins, Layers, UserPlus, Zap } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  ShareButton,
  ActionBar,
  ListShell,
  TimeAgo,
  StatTile,
  Sparkline,
  BarMini,
  Donut,
  CopyButton,
} from "@jsonbored/ui-kit";
import { PageMasthead, Panel } from "@/components/metagraphed/primitives";
import { EXPLORER_LEADERBOARD_IDS } from "@/components/metagraphed/explorer-leaderboard-layout";
import { ExplorerLeaderboardTableShell } from "@/components/metagraphed/explorer-leaderboard-table-shell";
import { ChainEventsFeed } from "@/components/metagraphed/chain-events-feed";
import {
  blocksQuery,
  chainActivityQuery,
  chainCallsQuery,
  chainEventsStatsQuery,
  chainFeesQuery,
  chainSignersQuery,
  chainWeightSettersQuery,
  chainRegistrationsQuery,
  chainServingQuery,
  chainPrometheusQuery,
  chainStakeFlowQuery,
  chainStakeMovesQuery,
  chainTurnoverQuery,
  chainStakeTransfersQuery,
  chainAxonRemovalsQuery,
  chainIdleStakeQuery,
  chainTransferPairsQuery,
  chainTransfersQuery,
  economicsTrendsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { rovingTabIndex, useRovingTablist } from "@/hooks/use-roving-tablist";
import { shortHash } from "@/lib/metagraphed/blocks";
import type {
  ChainCalls,
  ChainEventsStats,
  ChainStakeFlow,
  ChainStakeMoves,
  ChainTurnover,
  EconomicsTrends,
  ChainAxonRemovals,
  ChainIdleStake,
  ChainRegistrations,
  ChainServing,
  ChainPrometheus,
  ChainTransfers,
} from "@/lib/metagraphed/types";

// #3373: compact live chain-head tip in the hero — "head #NNNN · N ago" from the
// live /api/v1/blocks feed (limit 1), linking to that block. Mirrors #3372's
// ChainHeadTip on the home page: plain useQuery so a cold/failed fetch silently
// renders null and never disrupts the primary hero or the daily-aggregate KPIs.
function ChainHeadTip() {
  const { data } = useQuery(blocksQuery({ limit: 1 }));
  const head = data?.data?.[0];
  if (!head || head.block_number == null) return null;
  return (
    <Link
      to="/blocks/$ref"
      params={{ ref: String(head.block_number) }}
      className="mg-fade-in mg-fade-in-delay-3 inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-muted hover:text-accent transition-colors"
    >
      <span className="mg-live-dot" />
      head #{formatNumber(head.block_number)} · <TimeAgo at={head.observed_at} />
    </Link>
  );
}

const explorerSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
  pallet: fallback(z.string(), "").default(""),
  method: fallback(z.string(), "").default(""),
  events_cursor: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/explorer")({
  validateSearch: zodValidator(explorerSearchSchema),
  head: () => ({
    meta: [
      { title: "Chain explorer — Metagraphed" },
      {
        name: "description",
        content:
          "Bittensor network at a glance: daily extrinsic/block/event activity, fees, call mix, and the most active accounts — chain-direct analytics.",
      },
      { property: "og:title", content: "Chain explorer — Metagraphed" },
      {
        property: "og:description",
        content:
          "Bittensor network at a glance: daily activity, fees, call mix, and the most active accounts.",
      },
    ],
  }),
  component: ExplorerPage,
});

function sum(values: number[]): number {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

function fmtTaoSigned(v: number): string {
  return v < 0 ? `-${formatTao(-v)}` : `+${formatTao(v)}`;
}

function ExplorerPage() {
  return (
    <AppShell>
      <PageMasthead
        eyebrow="Explorer"
        live
        title="Chain explorer"
        description="The Bittensor network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers."
        actions={
          <>
            <ActionBar>
              <ShareButton bare />
            </ActionBar>
            <ChainHeadTip />
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <ExplorerDashboard />
        </Suspense>
      </QueryErrorBoundary>
      <ChainEventsFeedSection />
      <ApiSourceFooter
        paths={[
          "/api/v1/blocks",
          "/api/v1/chain/activity",
          "/api/v1/chain/fees",
          "/api/v1/chain/calls",
          "/api/v1/chain/signers",
          "/api/v1/chain/weights/setters",
          "/api/v1/chain/registrations",
          "/api/v1/chain/serving",
          "/api/v1/chain/prometheus",
          "/api/v1/chain/stake-flow",
          "/api/v1/chain/stake-moves",
          "/api/v1/chain/turnover",
          "/api/v1/chain/stake-transfers",
          "/api/v1/chain/axon-removals",
          "/api/v1/chain-events",
          "/api/v1/chain-events/stats",
          "/api/v1/economics/trends",
          "/api/v1/chain/transfers",
        ]}
      />
    </AppShell>
  );
}

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

/**
 * One labeled mini-sparkline cell for a daily series. Aligns `days` labels to
 * `values` so the hover tooltip shows the day, and surfaces the latest value
 * as a compact caption.
 */
function MiniSeries({
  label,
  days,
  values,
  color,
  formatValue,
}: {
  label: string;
  days: string[];
  values: number[];
  color: string;
  formatValue: (v: number) => string;
}) {
  const latest = values.length > 0 ? values[values.length - 1]! : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-strong">
          {latest == null ? "—" : formatValue(latest)}
        </span>
      </div>
      <Sparkline
        values={values}
        points={values.map((v, i) => ({ t: days[i] ?? "", v }))}
        width={320}
        height={48}
        color={color}
        ariaLabel={`Daily ${label.toLowerCase()}`}
        formatValue={formatValue}
      />
    </div>
  );
}

/**
 * Call mix — the top modules as a BarMini, plus a click-through drill-down into
 * the selected module's call_function rows (where the grouping exposes them).
 */
// #3384: cycle the shared chart palette across the call-mix donut segments +
// their legend swatches, matching providers.index.tsx's ProviderOverview.
const CALL_MIX_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

function CallMixSection({ calls }: { calls: ChainCalls }) {
  const modules = calls.calls.slice(0, 10);
  const [selected, setSelected] = useState<string | null>(null);
  const moduleSegments = modules.map((c, i) => ({
    label: c.call_module,
    value: c.count,
    color: CALL_MIX_PALETTE[i % CALL_MIX_PALETTE.length]!,
  }));
  // Function-level rows exist only when the aggregate is grouped by function;
  // at module grouping call_function is null, so this stays empty until then.
  const functions = calls.calls.filter(
    (c) => c.call_function != null && (selected == null || c.call_module === selected),
  );

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Call mix
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(calls.total_extrinsics)} calls
        </span>
      </div>
      {modules.length > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Donut
              segments={moduleSegments}
              centerLabel={formatNumber(calls.total_extrinsics)}
              centerSub="calls"
            />
            {/* Interactive legend: `Donut`/`DonutLegend` are presentational, so
                the click-to-drill-in affordance lives on these legend rows,
                preserving the module-select behaviour the bar list had. */}
            <ul className="min-w-0 flex-1 space-y-1">
              {modules.map((c, i) => {
                const active = selected === c.call_module;
                return (
                  <li key={c.call_module}>
                    <button
                      type="button"
                      onClick={() => setSelected(active ? null : c.call_module)}
                      className="flex w-full items-center gap-2 text-left"
                      aria-pressed={active}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-sm"
                        style={{ background: CALL_MIX_PALETTE[i % CALL_MIX_PALETTE.length] }}
                      />
                      <span
                        className={
                          active
                            ? "mg-type-micro truncate text-[10px] text-accent"
                            : "mg-type-micro truncate text-[10px] text-ink-muted"
                        }
                      >
                        {c.call_module}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-strong">
                        {formatNumber(c.count)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {functions.length > 0 ? (
            <div className="border-t border-border pt-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                {selected ? `${selected} functions` : "Function breakdown"}
              </div>
              <BarMini
                data={functions.slice(0, 10).map((c) => ({
                  label: c.call_function ?? c.call_module,
                  value: c.count,
                }))}
              />
            </div>
          ) : (
            <p className="border-t border-border pt-3 font-mono text-[11px] text-ink-muted">
              {selected
                ? "No per-function breakdown for this module at the current grouping."
                : "Tap a module to drill into its functions (function rows appear when the chain-calls aggregate is grouped by function)."}
            </p>
          )}
        </div>
      ) : (
        <EmptyState title="No calls yet." />
      )}
    </Panel>
  );
}

// #3489: raw all-events tier (ADR 0013) pallet.method distribution from
// /api/v1/chain-events/stats — the raw-tier sibling of the curated CallMixSection
// above (D1 /chain/calls). Same ranked-list-with-proportional-bar idiom, capped
// to the busiest 10 rows; the header reports the distinct group count and the
// block window scanned. Empty until the all-events backfill runs.
function PalletEventMixSection({ stats }: { stats: ChainEventsStats }) {
  const rows = stats.activity.slice(0, 10);
  const cap = Math.max(1, ...rows.map((r) => r.count));

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Pallet event mix
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(stats.groups)} groups · {formatNumber(stats.window_blocks)} blocks
        </span>
      </div>
      {rows.length > 0 ? (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const pct = Math.max(2, Math.round((r.count / cap) * 100));
            const label = r.method ? `${r.pallet}.${r.method}` : r.pallet;
            return (
              <li key={label} className="grid grid-cols-[10rem_1fr_auto] items-center gap-2">
                <span className="mg-type-micro truncate text-[10px] text-ink-muted" title={label}>
                  {label}
                </span>
                <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${pct}%`, background: "var(--chart-1)" }}
                  />
                </span>
                <span className="font-mono text-[10px] tabular-nums text-ink-strong">
                  {formatNumber(r.count)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No raw pallet events indexed yet." />
      )}
    </Panel>
  );
}

/** Compact labeled metric for the stake-flow summary row. */
function StakeFlowMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "ok" | "down" | "default";
}) {
  const valueClass =
    tone === "ok" ? "text-health-ok" : tone === "down" ? "text-health-down" : "text-ink-strong";
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-sm tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

/**
 * Network-wide stake flow (#3734) — total staked vs unstaked across every subnet
 * for the window, the gaining/losing/flat split, and the top net inflows as a
 * bar list. The endpoint returns subnets sorted descending by net flow and caps
 * the list server-side (LIMIT_MAX 100 of ~129 subnets), so it is a
 * top-net-inflows board and cannot surface the biggest outflows — the largest
 * single outflow is reported separately from the full-network distribution.
 * Chain-direct: GET /api/v1/chain/stake-flow.
 */
function StakeFlowSection({ flow }: { flow: ChainStakeFlow }) {
  const net = flow.network;
  const dist = flow.net_flow_distribution;
  // Server already sorts subnets descending by net flow (biggest net inflows
  // first); re-sort defensively and take the top 12 for the inflow board.
  const inflows = [...flow.subnets].sort((a, b) => b.net_flow_tao - a.net_flow_tao).slice(0, 12);
  const cap = Math.max(1, ...inflows.map((s) => s.net_flow_tao));

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Stake flow
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(flow.subnet_count)} subnets
        </span>
      </div>

      {net ? (
        <div className="mb-5 space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StakeFlowMetric
              label="Net flow"
              value={fmtTaoSigned(net.net_flow_tao)}
              tone={net.net_flow_tao >= 0 ? "ok" : "down"}
            />
            <StakeFlowMetric label="Gross flow" value={formatTao(net.gross_flow_tao)} />
            <StakeFlowMetric label="Staked" value={formatTao(net.total_staked_tao)} />
            <StakeFlowMetric label="Unstaked" value={formatTao(net.total_unstaked_tao)} />
          </div>
          <div className="mg-type-micro flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
            <span className="text-health-ok">{formatNumber(net.gaining)} gaining</span>
            <span className="text-health-down">{formatNumber(net.losing)} losing</span>
            <span className="text-ink-muted">{formatNumber(net.flat)} flat</span>
            <span className="text-ink-muted">
              {formatNumber(net.stake_events + net.unstake_events)} events
            </span>
          </div>
        </div>
      ) : null}

      {inflows.length > 0 ? (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Top net inflows
          </div>
          <ul className="space-y-1.5">
            {inflows.map((s) => {
              const pct = Math.max(2, Math.round((Math.max(0, s.net_flow_tao) / cap) * 100));
              const inflow = s.net_flow_tao >= 0;
              return (
                <li key={s.netuid}>
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: s.netuid }}
                    className="grid w-full grid-cols-[3.5rem_1fr_6rem] items-center gap-2 text-left hover:opacity-80"
                  >
                    <span className="mg-type-micro truncate text-[10px] text-ink-muted">
                      SN{s.netuid}
                    </span>
                    <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: inflow ? "var(--health-ok)" : "var(--health-down)",
                        }}
                      />
                    </span>
                    <span
                      className={`text-right font-mono text-[10px] tabular-nums ${
                        inflow ? "text-health-ok" : "text-health-down"
                      }`}
                    >
                      {fmtTaoSigned(s.net_flow_tao)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <EmptyState title="No stake flow in this window yet." />
      )}

      {dist ? (
        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-ink-muted">
          Median net flow {fmtTaoSigned(dist.median ?? 0)}, largest single outflow{" "}
          {fmtTaoSigned(dist.min ?? 0)} across {formatNumber(dist.count)} subnets.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Network-wide stake moves (#3468) - re-delegation churn across every subnet for
 * the window: distinct movers, total movements, and moves-per-mover, plus the
 * busiest subnets by movement count and the intensity distribution.
 * Chain-direct: GET /api/v1/chain/stake-moves.
 */
function StakeMovesSection({ moves }: { moves: ChainStakeMoves }) {
  const net = moves.network;
  const dist = moves.intensity_distribution;
  // Server sorts subnets by movements desc; re-sort defensively, take the top 12.
  const busiest = [...moves.subnets].sort((a, b) => b.movements - a.movements).slice(0, 12);
  const cap = Math.max(1, ...busiest.map((s) => s.movements));

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Stake moves
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(moves.subnet_count)} subnets
        </span>
      </div>

      {net ? (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StakeFlowMetric label="Distinct movers" value={formatNumber(net.distinct_movers)} />
          <StakeFlowMetric label="Movements" value={formatNumber(net.movements)} />
          <StakeFlowMetric label="Moves / mover" value={net.movements_per_mover.toFixed(2)} />
        </div>
      ) : null}

      {busiest.length > 0 ? (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Busiest subnets
          </div>
          <ul className="space-y-1.5">
            {busiest.map((s) => {
              const pct = Math.max(2, Math.round((s.movements / cap) * 100));
              return (
                <li key={s.netuid}>
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: s.netuid }}
                    className="grid w-full grid-cols-[3.5rem_1fr_6rem] items-center gap-2 text-left hover:opacity-80"
                  >
                    <span className="mg-type-micro truncate text-[10px] text-ink-muted">
                      SN{s.netuid}
                    </span>
                    <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${pct}%`, background: "var(--accent)" }}
                      />
                    </span>
                    <span className="text-right font-mono text-[10px] tabular-nums text-ink-strong">
                      {formatNumber(s.movements)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <EmptyState title="No stake moves in this window yet." />
      )}

      {dist ? (
        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-ink-muted">
          Median {(dist.median ?? 0).toFixed(1)} moves per mover, up to {(dist.max ?? 0).toFixed(1)}{" "}
          in the busiest subnet, across {formatNumber(dist.count)} subnets.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * #3463: network-wide axon-serving and Prometheus-telemetry leaderboards side
 * by side — which subnets are actively announcing operational endpoints. The
 * wrapping section leaves room for #3464's axon-removals panel to slot in later.
 */
function NetworkOperationsSection({
  serving,
  prometheus,
}: {
  serving: ChainServing;
  prometheus: ChainPrometheus;
}) {
  return (
    <section>
      <h2 className="mb-6 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
        Network operations
      </h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChainServingLeaderboard board={serving} />
        <ChainPrometheusLeaderboard board={prometheus} />
      </div>
    </section>
  );
}

function ChainServingLeaderboard({ board }: { board: ChainServing }) {
  const net = board.network;

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Axon serving
        </h3>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(board.subnet_count)} subnets
        </span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StakeFlowMetric label="Announcements" value={formatNumber(net.announcements)} />
        <StakeFlowMetric label="Distinct servers" value={formatNumber(net.distinct_servers)} />
        <StakeFlowMetric
          label="Per server"
          value={
            net.announcements_per_server != null ? net.announcements_per_server.toFixed(2) : "—"
          }
        />
      </div>

      {board.subnets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TH}>Subnet</th>
                <th className={`${TH} text-right`}>Announcements</th>
                <th className={`${TH} text-right`}>Distinct servers</th>
                <th className={`${TH} text-right`}>Per server</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.subnets.map((s) => (
                <tr key={s.netuid} className="hover:bg-surface/40">
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{s.netuid}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatNumber(s.announcements)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(s.distinct_servers)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {s.announcements_per_server != null
                      ? s.announcements_per_server.toFixed(2)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No serving activity in this window yet." />
      )}
    </Panel>
  );
}

function ChainPrometheusLeaderboard({ board }: { board: ChainPrometheus }) {
  const net = board.network;

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Prometheus telemetry
        </h3>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(board.subnet_count)} subnets
        </span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StakeFlowMetric label="Announcements" value={formatNumber(net.announcements)} />
        <StakeFlowMetric label="Distinct exporters" value={formatNumber(net.distinct_exporters)} />
        <StakeFlowMetric
          label="Per exporter"
          value={
            net.announcements_per_exporter != null ? net.announcements_per_exporter.toFixed(2) : "—"
          }
        />
      </div>

      {board.subnets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TH}>Subnet</th>
                <th className={`${TH} text-right`}>Announcements</th>
                <th className={`${TH} text-right`}>Distinct exporters</th>
                <th className={`${TH} text-right`}>Per exporter</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.subnets.map((s) => (
                <tr key={s.netuid} className="hover:bg-surface/40">
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{s.netuid}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatNumber(s.announcements)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(s.distinct_exporters)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {s.announcements_per_exporter != null
                      ? s.announcements_per_exporter.toFixed(2)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No Prometheus telemetry in this window yet." />
      )}
    </Panel>
  );
}

/**
 * #3464: network-wide axon-teardown ("churn") leaderboard — the teardown-side
 * complement of the serving/stake-transfer boards, from the newly-wired
 * chainAxonRemovalsQuery. Network rollup line + per-subnet table, mirroring the
 * stake-transfer leaderboard treatment on this page.
 */
function AxonChurnSection({ churn }: { churn: ChainAxonRemovals }) {
  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Axon churn leaderboard
          </h2>
          <p className="mt-1 font-mono text-[11px] text-ink-muted">
            {formatNumber(churn.network.removals)} axon teardowns across{" "}
            {formatNumber(churn.network.distinct_removers)} removers network-wide
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink-muted">{churn.subnets.length} subnets</span>
      </div>
      {churn.subnets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TH}>Subnet</th>
                <th className={`${TH} text-right`}>Teardowns</th>
                <th className={`${TH} text-right`}>Distinct removers</th>
                <th className={`${TH} text-right`}>Teardowns per remover</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {churn.subnets.map((s) => (
                <tr key={s.netuid} className="hover:bg-surface/40">
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{s.netuid}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatNumber(s.removals)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(s.distinct_removers)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {s.removals_per_remover != null ? s.removals_per_remover.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No axon teardowns in this window yet." />
      )}
    </Panel>
  );
}

/**
 * Network-wide idle-stake rollup (#6994) — subnets ranked by stake delegated to
 * hotkeys currently earning zero dividends (no permit / zero-weight outcome).
 * Chain-direct: GET /api/v1/chain/idle-stake.
 */
function NetworkIdleStakeSection({ idleStake }: { idleStake: ChainIdleStake }) {
  const totalIdleHotkeys = idleStake.subnets.reduce(
    (sum, s) => sum + (s.idle_neuron_count ?? 0),
    0,
  );
  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Idle stake
          </h2>
          <p className="mt-1 font-mono text-[11px] text-ink-muted">
            Stake delegated to hotkeys currently earning zero dividends
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(idleStake.subnet_count)} subnets
        </span>
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Coins}
          eyebrow="Total idle stake"
          value={formatTao(idleStake.total_idle_stake_tao)}
          hint="network-wide, zero-dividend"
          tone="accent"
        />
        <StatTile
          icon={Coins}
          eyebrow="Idle subnets"
          value={formatNumber(idleStake.subnet_count)}
          hint="with idle stake"
        />
        <StatTile
          icon={Coins}
          eyebrow="Idle hotkeys"
          value={formatNumber(totalIdleHotkeys)}
          hint="earning zero dividends"
        />
      </div>

      {idleStake.subnets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TH}>Subnet</th>
                <th className={`${TH} text-right`}>Idle stake</th>
                <th className={`${TH} text-right`}>Idle hotkeys</th>
                <th className={`${TH} text-right`}>Neurons</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {idleStake.subnets.map((s) => (
                <tr key={s.netuid} className="hover:bg-surface/40">
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{s.netuid}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatTao(s.idle_stake_tao)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatNumber(s.idle_neuron_count)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(s.neuron_count)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No idle stake in this snapshot yet." />
      )}
    </Panel>
  );
}

/**
 * Network-wide neuron-registration leaderboard (#3465) — subnets ranked by
 * NeuronRegistered volume over the window. Chain-direct: GET /api/v1/chain/registrations.
 */
function NetworkRegistrationsSection({ registrations }: { registrations: ChainRegistrations }) {
  const net = registrations.network;

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Network registrations
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(registrations.subnet_count)} subnets
        </span>
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={UserPlus}
          eyebrow="Registrations"
          value={formatNumber(net.registrations)}
          hint={`${registrations.window ?? "window"} total`}
          tone="accent"
        />
        <StatTile
          icon={UserPlus}
          eyebrow="Distinct registrants"
          value={formatNumber(net.distinct_registrants)}
          hint="network-wide hotkeys"
        />
        <StatTile
          icon={UserPlus}
          eyebrow="Per registrant"
          value={
            net.registrations_per_registrant != null
              ? net.registrations_per_registrant.toFixed(2)
              : "—"
          }
          hint="avg registrations"
        />
      </div>

      {registrations.subnets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TH}>Subnet</th>
                <th className={`${TH} text-right`}>Registrations</th>
                <th className={`${TH} text-right`}>Distinct registrants</th>
                <th className={`${TH} text-right`}>Per registrant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {registrations.subnets.map((s) => (
                <tr key={s.netuid} className="hover:bg-surface/40">
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{s.netuid}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatNumber(s.registrations)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(s.distinct_registrants)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {s.registrations_per_registrant != null
                      ? s.registrations_per_registrant.toFixed(2)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No registrations in this window yet." />
      )}
    </Panel>
  );
}

/**
 * Network-wide validator-set turnover (#3473) — how much each subnet's validator
 * set churned over the window (entered / exited, retention, stability), plus the
 * most volatile subnets. Chain-direct: GET /api/v1/chain/turnover. Placed here
 * alongside the sibling network-chain sections; the issue names /leaderboards,
 * which does not exist yet.
 */
function ValidatorTurnoverSection({ turnover }: { turnover: ChainTurnover }) {
  const net = turnover.network;
  // Most volatile first (lowest stability score); bar width ~ total churn.
  const volatile = [...turnover.subnets]
    .sort((a, b) => (a.stability_score ?? 100) - (b.stability_score ?? 100))
    .slice(0, 12);

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Validator turnover
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(turnover.subnet_count)} subnets
        </span>
      </div>

      {net ? (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StakeFlowMetric
            label="Retention"
            value={
              net.validator_retention != null
                ? `${(net.validator_retention * 100).toFixed(1)}%`
                : "—"
            }
            tone="ok"
          />
          <StakeFlowMetric label="Entered" value={formatNumber(net.validators_entered)} />
          <StakeFlowMetric label="Exited" value={formatNumber(net.validators_exited)} />
          <StakeFlowMetric
            label="Stability"
            value={net.stability_score != null ? `${formatNumber(net.stability_score)}/100` : "—"}
          />
        </div>
      ) : null}

      {volatile.length > 0 ? (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Most volatile subnets
          </div>
          <ul className="space-y-1.5">
            {volatile.map((s) => {
              const pct = Math.max(
                2,
                Math.round((s.validator_retention != null ? 1 - s.validator_retention : 0) * 100),
              );
              return (
                <li key={s.netuid}>
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: s.netuid }}
                    className="grid w-full grid-cols-[3.5rem_1fr_6rem] items-center gap-2 text-left hover:opacity-80"
                  >
                    <span className="mg-type-micro truncate text-[10px] text-ink-muted">
                      SN{s.netuid}
                    </span>
                    <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${pct}%`, background: "var(--health-warn)" }}
                      />
                    </span>
                    <span className="text-right font-mono text-[10px] tabular-nums text-ink-strong">
                      {s.validator_retention != null
                        ? `${Math.round(s.validator_retention * 100)}% kept`
                        : "—"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <EmptyState title="No turnover in this window yet." />
      )}

      {net ? (
        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-ink-muted">
          Validator set {formatNumber(net.validators_start)} to {formatNumber(net.validators_end)}{" "}
          over {turnover.window}, across {formatNumber(turnover.subnet_count)} subnets.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Network-wide economics trend (#3365) — the subnet_snapshots rollup (stake,
 * alpha price, validator/miner counts, emission share), a distinct data source
 * from every other section on this page (which reads the chain indexer). Reuses
 * the page's MiniSeries idiom for consistency with "Daily activity"/"Daily fees".
 */
function EconomicsTrendsSection({ trends }: { trends: EconomicsTrends }) {
  const chrono = [...trends.days].reverse();
  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Network economics trend
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">{trends.day_count} days</span>
      </div>
      {chrono.length > 0 ? (
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
          <MiniSeries
            label="Total stake"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.total_stake_tao ?? 0)}
            color="var(--accent)"
            formatValue={formatTao}
          />
          <MiniSeries
            label="Alpha price"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.alpha_price_tao_weighted ?? 0)}
            color="var(--chart-1)"
            formatValue={formatTao}
          />
          <MiniSeries
            label="Emission share"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => (d.mean_emission_share ?? 0) * 100)}
            color="var(--chart-6)"
            formatValue={(v) => `${v.toFixed(3)}%`}
          />
          <MiniSeries
            label="Validators"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.validator_count ?? 0)}
            color="var(--chart-3)"
            formatValue={(v) => formatNumber(v)}
          />
          <MiniSeries
            label="Miners"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.miner_count ?? 0)}
            color="var(--chart-1)"
            formatValue={(v) => formatNumber(v)}
          />
        </div>
      ) : (
        <EmptyState title="No economics snapshots in this window yet." />
      )}
    </Panel>
  );
}

function fmtShare(share: number | null): string {
  return share == null ? "—" : `${(share * 100).toFixed(1)}%`;
}

function weightSetterKey(setter: {
  hotkey: string | null;
  netuid?: number | null;
  uid: number | null;
}): string {
  return setter.hotkey ?? `uid:${setter.netuid ?? "unknown"}:${setter.uid ?? "unknown"}`;
}

function weightSetterLabel(setter: { netuid?: number | null; uid: number | null }): string {
  const uid = setter.uid ?? "—";
  return setter.netuid == null ? `uid ${uid}` : `SN${setter.netuid} uid ${uid}`;
}

/**
 * Network-wide native-TAO transfer-volume leaderboard (#3475) — separate
 * top-senders/top-receivers rankings, distinct from the directed
 * sender->receiver corridor view (#3476, chainTransferPairsQuery). Chain-direct:
 * GET /api/v1/chain/transfers.
 */
function TransfersLeaderboardSection({ transfers }: { transfers: ChainTransfers }) {
  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Transfers leaderboard
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(transfers.transfer_count)} transfers
        </span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StakeFlowMetric label="Total volume" value={formatTao(transfers.total_volume_tao)} />
        <StakeFlowMetric label="Transfers" value={formatNumber(transfers.transfer_count)} />
        <StakeFlowMetric label="Unique senders" value={formatNumber(transfers.unique_senders)} />
        <StakeFlowMetric
          label="Unique receivers"
          value={formatNumber(transfers.unique_receivers)}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Top senders
          </div>
          {transfers.top_senders.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Account</th>
                    <th className={`${TH} text-right`}>Volume</th>
                    <th className={`${TH} text-right`}>Transfers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {transfers.top_senders.map((s) => (
                    <tr key={s.address} className="hover:bg-surface/40">
                      <td className="px-4 py-2 font-mono text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to="/accounts/$ss58"
                            params={{ ss58: s.address }}
                            className="text-ink-strong hover:text-accent hover:underline"
                            title={s.address}
                          >
                            {shortHash(s.address) ?? s.address}
                          </Link>
                          <CopyButton value={s.address} label="address" compact />
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                        {formatTao(s.volume_tao)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(s.transfer_count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No senders in this window yet.</p>
          )}
        </div>

        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Top receivers
          </div>
          {transfers.top_receivers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Account</th>
                    <th className={`${TH} text-right`}>Volume</th>
                    <th className={`${TH} text-right`}>Transfers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {transfers.top_receivers.map((r) => (
                    <tr key={r.address} className="hover:bg-surface/40">
                      <td className="px-4 py-2 font-mono text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to="/accounts/$ss58"
                            params={{ ss58: r.address }}
                            className="text-ink-strong hover:text-accent hover:underline"
                            title={r.address}
                          >
                            {shortHash(r.address) ?? r.address}
                          </Link>
                          <CopyButton value={r.address} label="address" compact />
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                        {formatTao(r.volume_tao)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(r.transfer_count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No receivers in this window yet.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

type ExplorerTab = "activity" | "fees" | "stake" | "governance";
const EXPLORER_TABS: { id: ExplorerTab; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "fees", label: "Fees" },
  { id: "stake", label: "Stake" },
  { id: "governance", label: "Governance" },
];

function ExplorerDashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  // A single batched useSuspenseQueries, not one useSuspenseQuery call per
  // endpoint: each individual call suspends the component separately, so on a
  // cold cache (in particular during SSR) React re-renders and re-suspends
  // once per query, resolving them in a serial waterfall instead of parallel
  // -- the original 9 queries at ~5s each measured as a genuine ~33s page load
  // in production, not a hang (confirmed by testing each endpoint standalone,
  // all fast, and the full page eventually completing at ~33s with a longer
  // timeout). useSuspenseQueries fires all fetches concurrently and suspends
  // once, so the page waits on the slowest single query, not the sum. #3365
  // adds a 10th (economics/trends, a different data source entirely).
  const [
    { data: activityRes },
    { data: feesRes },
    { data: callsRes },
    { data: signersRes },
    { data: weightSettersRes },
    { data: registrationsRes },
    { data: servingRes },
    { data: prometheusRes },
    { data: stakeFlowRes },
    { data: stakeMovesRes },
    { data: turnoverRes },
    { data: stakeTransfersRes },
    { data: axonChurnRes },
    { data: eventMixRes },
    { data: trendsRes },
    { data: transfersRes },
    { data: idleStakeRes },
  ] = useSuspenseQueries({
    queries: [
      chainActivityQuery(win),
      chainFeesQuery(win),
      chainCallsQuery(win),
      chainSignersQuery(win),
      chainWeightSettersQuery(win),
      chainRegistrationsQuery(win),
      chainServingQuery(win),
      chainPrometheusQuery(win),
      chainStakeFlowQuery(win),
      chainStakeMovesQuery(win),
      chainTurnoverQuery(win),
      chainStakeTransfersQuery(win),
      chainAxonRemovalsQuery(win),
      chainEventsStatsQuery(),
      economicsTrendsQuery(win),
      chainTransfersQuery(win),
      chainIdleStakeQuery(),
    ],
  });
  const activity = activityRes.data;
  const fees = feesRes.data;
  const calls = callsRes.data;
  const signers = signersRes.data;
  const weightSetters = weightSettersRes.data;
  const registrations = registrationsRes.data;
  const serving = servingRes.data;
  const prometheus = prometheusRes.data;
  const stakeFlow = stakeFlowRes.data;
  const stakeMoves = stakeMovesRes.data;
  const turnover = turnoverRes.data;
  const stakeTransfers = stakeTransfersRes.data;
  const axonChurn = axonChurnRes.data;
  const eventMix = eventMixRes.data;
  const trends = trendsRes.data;
  const transfers = transfersRes.data;
  const idleStake = idleStakeRes.data;

  // The API returns newest-day-first; sparklines want chronological order.
  const chrono = [...activity.days].reverse();
  const feeChrono = [...fees.daily].reverse();
  const totalExtrinsics = sum(activity.days.map((d) => d.extrinsic_count));
  const totalBlocks = sum(activity.days.map((d) => d.block_count));
  const totalEvents = sum(activity.days.map((d) => d.event_count));
  const totalSuccessful = sum(activity.days.map((d) => d.successful_extrinsics));
  const successRate = totalExtrinsics > 0 ? totalSuccessful / totalExtrinsics : null;
  const totalFees = sum(fees.daily.map((d) => d.total_fee_tao));
  const totalTips = sum(fees.daily.map((d) => d.total_tip_tao));

  // #5328: group the ~20 chain-analytics panels into tabs so the page is no
  // longer one ~24,000px vertical feed. Only the active tab's panels mount; the
  // queries above are batched once, so switching tabs never re-suspends.
  const [tab, setTab] = useState<ExplorerTab>("activity");
  // #6391: arrow-key navigation for the role="tablist" section switcher.
  const tabActiveIndex = Math.max(
    0,
    EXPLORER_TABS.findIndex((t) => t.id === tab),
  );
  const { tabRef: explorerTabRef, onKeyDown: explorerTabKeyDown } = useRovingTablist(
    EXPLORER_TABS.length,
    (i) => setTab(EXPLORER_TABS[i].id),
  );
  return (
    <div className="space-y-10">
      {/* window toggle */}
      <div className="flex items-center gap-2">
        {(["7d", "30d"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => navigate({ search: { window: w } })}
            className={
              w === win
                ? "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent-text"
                : "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30"
            }
          >
            {w}
          </button>
        ))}
      </div>

      {/* KPI tiles */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon={Zap}
          eyebrow="Extrinsics"
          value={formatNumber(totalExtrinsics)}
          hint={`${win} total`}
          tone="accent"
        />
        <StatTile
          icon={Boxes}
          eyebrow="Blocks"
          value={formatNumber(totalBlocks)}
          hint={`${win} total`}
        />
        <StatTile
          icon={Activity}
          eyebrow="Events"
          value={formatNumber(totalEvents)}
          hint={`${win} total`}
        />
        <StatTile icon={Coins} eyebrow="Fees" value={formatTao(totalFees)} hint={`${win} total`} />
        <StatTile
          icon={Coins}
          eyebrow="Tips"
          value={formatTao(totalTips)}
          hint={`${win} total`}
          tone={totalTips > 0 ? "ok" : "default"}
        />
        <StatTile
          icon={Layers}
          eyebrow="Success rate"
          value={successRate == null ? "—" : `${(successRate * 100).toFixed(2)}%`}
          hint="successful / total"
        />
      </div>

      <div
        className="flex flex-wrap gap-2 border-b border-border pb-3"
        role="tablist"
        aria-label="Explorer sections"
      >
        {EXPLORER_TABS.map((t, i) => (
          <button
            key={t.id}
            ref={explorerTabRef(i)}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={rovingTabIndex(i, tabActiveIndex)}
            onClick={() => setTab(t.id)}
            onKeyDown={explorerTabKeyDown(i)}
            className={
              tab === t.id
                ? "rounded-full border border-accent/40 bg-accent/10 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-accent-text"
                : "rounded-full border border-border bg-card px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30 hover:text-ink-strong"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "activity" && (
        <>
          {/* daily activity series */}
          <Panel className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Daily activity
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">
                {activity.day_count} days
              </span>
            </div>
            {chrono.length > 0 ? (
              <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
                <MiniSeries
                  label="Extrinsics"
                  days={chrono.map((d) => d.day)}
                  values={chrono.map((d) => d.extrinsic_count)}
                  color="var(--accent)"
                  formatValue={(v) => formatNumber(v)}
                />
                <MiniSeries
                  label="Blocks"
                  days={chrono.map((d) => d.day)}
                  values={chrono.map((d) => d.block_count)}
                  color="var(--chart-1)"
                  formatValue={(v) => formatNumber(v)}
                />
                <MiniSeries
                  label="Events"
                  days={chrono.map((d) => d.day)}
                  values={chrono.map((d) => d.event_count)}
                  color="var(--chart-3)"
                  formatValue={(v) => formatNumber(v)}
                />
                <MiniSeries
                  label="Success rate"
                  days={chrono.map((d) => d.day)}
                  values={chrono.map((d) => d.success_rate ?? 0)}
                  color="var(--chart-6)"
                  formatValue={(v) => `${(v * 100).toFixed(1)}%`}
                />
                <MiniSeries
                  label="Unique signers"
                  days={chrono.map((d) => d.day)}
                  values={chrono.map((d) => d.unique_signers)}
                  color="var(--chart-1)"
                  formatValue={(v) => formatNumber(v)}
                />
              </div>
            ) : (
              <EmptyState title="No activity indexed yet — the chain poller fills this every few minutes." />
            )}
          </Panel>
          <div className="grid gap-6 lg:grid-cols-2">
            {/* call mix */}
            <CallMixSection calls={calls} />

            {/* top signers */}
            <Panel className="min-w-0">
              <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Most active accounts
              </h2>
              {signers.signers.length > 0 ? (
                <ExplorerLeaderboardTableShell
                  leaderboardId={EXPLORER_LEADERBOARD_IDS.activeAccounts}
                >
                  <thead>
                    <tr>
                      <th className={TH}>Account</th>
                      <th className={`${TH} text-right`}>Txs</th>
                      <th className={`${TH} text-right`}>Fees</th>
                      <th className={`${TH} text-right`}>Tips</th>
                      <th className={`${TH} text-right`}>Last block</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {signers.signers.slice(0, 12).map((s) => (
                      <tr key={s.signer} className="hover:bg-surface/40">
                        <td className="px-4 py-2 font-mono text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <Link
                              to="/accounts/$ss58"
                              params={{ ss58: s.signer }}
                              className="text-ink-strong hover:text-accent hover:underline"
                              title={s.signer}
                            >
                              {shortHash(s.signer) ?? s.signer}
                            </Link>
                            <CopyButton value={s.signer} label="signer" compact />
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                          {formatNumber(s.tx_count)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {formatTao(s.total_fee_tao)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {formatTao(s.total_tip_tao)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {s.last_tx_block != null ? (
                            <Link
                              to="/blocks/$ref"
                              params={{ ref: String(s.last_tx_block) }}
                              className="hover:text-accent hover:underline"
                            >
                              #{formatNumber(s.last_tx_block)}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </ExplorerLeaderboardTableShell>
              ) : (
                <EmptyState title="No signers in this window yet." />
              )}
            </Panel>
          </div>
          <NetworkOperationsSection serving={serving} prometheus={prometheus} />
          <AxonChurnSection churn={axonChurn} />
          <PalletEventMixSection stats={eventMix} />
        </>
      )}

      {tab === "fees" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Daily fees &amp; tips
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">{fees.day_count} days</span>
            </div>
            {feeChrono.length > 0 ? (
              <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
                <MiniSeries
                  label="Total fees"
                  days={feeChrono.map((d) => d.day)}
                  values={feeChrono.map((d) => d.total_fee_tao)}
                  color="var(--accent)"
                  formatValue={formatTao}
                />
                <MiniSeries
                  label="Avg fee"
                  days={feeChrono.map((d) => d.day)}
                  values={feeChrono.map((d) => d.avg_fee_tao ?? 0)}
                  color="var(--chart-3)"
                  formatValue={formatTao}
                />
                <MiniSeries
                  label="Total tips"
                  days={feeChrono.map((d) => d.day)}
                  values={feeChrono.map((d) => d.total_tip_tao)}
                  color="var(--chart-6)"
                  formatValue={formatTao}
                />
                <MiniSeries
                  label="Avg tip"
                  days={feeChrono.map((d) => d.day)}
                  values={feeChrono.map((d) => d.avg_tip_tao ?? 0)}
                  color="var(--chart-1)"
                  formatValue={formatTao}
                />
              </div>
            ) : (
              <EmptyState title="No fees in this window yet." />
            )}
          </Panel>
          <Panel className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Top fee payers
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">
                {fees.top_fee_payers.length} accounts
              </span>
            </div>
            {fees.top_fee_payers.length > 0 ? (
              // Table alone — the former BarMini restated the same ranked fee
              // list with no distinct cut of the data (#5313).
              <ExplorerLeaderboardTableShell leaderboardId={EXPLORER_LEADERBOARD_IDS.feePayers}>
                <thead>
                  <tr>
                    <th className={TH}>Account</th>
                    <th className={`${TH} text-right`}>Fees</th>
                    <th className={`${TH} text-right`}>Tips</th>
                    <th className={`${TH} text-right`}>Txs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {fees.top_fee_payers.map((p) => (
                    <tr key={p.signer} className="hover:bg-surface/40">
                      <td className="px-4 py-2 font-mono text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to="/accounts/$ss58"
                            params={{ ss58: p.signer }}
                            className="text-ink-strong hover:text-accent hover:underline"
                            title={p.signer}
                          >
                            {shortHash(p.signer) ?? p.signer}
                          </Link>
                          <CopyButton value={p.signer} label="signer" compact />
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                        {formatTao(p.total_fee_tao)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatTao(p.total_tip_tao)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(p.extrinsic_count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ExplorerLeaderboardTableShell>
            ) : (
              <EmptyState title="No fee payers in this window yet." />
            )}
          </Panel>
        </div>
      )}

      {tab === "stake" && (
        <>
          {/* network-wide economics trend (#3365) — subnet_snapshots rollup, a
          different data source from the chain-indexer sections above/below */}
          <EconomicsTrendsSection trends={trends} />
          {/* network-wide native-TAO transfer-volume leaderboard (#3475) */}
          <TransfersLeaderboardSection transfers={transfers} />
          <TransferPairsSection win={win} />
          <StakeFlowSection flow={stakeFlow} />
          <StakeMovesSection moves={stakeMoves} />
          <NetworkIdleStakeSection idleStake={idleStake} />
          {/* stake-transfer leaderboard */}
          <Panel className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
              <div>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                  Stake-transfer leaderboard
                </h2>
                <p className="mt-1 font-mono text-[11px] text-ink-muted">
                  {formatNumber(stakeTransfers.network.transfers)} transfers across{" "}
                  {formatNumber(stakeTransfers.network.distinct_senders)} senders network-wide
                </p>
              </div>
              <span className="font-mono text-[11px] text-ink-muted">
                {stakeTransfers.subnets.length} subnets
              </span>
            </div>
            {stakeTransfers.subnets.length > 0 ? (
              <>
                {/* < md: a squeezed 4-column table either clips its last column or
                requires an undiscoverable horizontal scroll, so narrow
                viewports get a stacked card per subnet instead (mirrors the
                cards/table split ListShell uses for paginated lists). */}
                <div className="md:hidden space-y-2">
                  {stakeTransfers.subnets.map((s) => (
                    <div key={s.netuid} className="rounded border border-border bg-card p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: s.netuid }}
                          className="font-mono text-[12px] font-medium text-ink-strong hover:text-accent hover:underline"
                        >
                          SN{s.netuid}
                        </Link>
                        <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                          {s.transfers_per_sender != null
                            ? `${s.transfers_per_sender.toFixed(2)} / sender`
                            : "—"}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                        <span>{formatNumber(s.transfers)} transfers</span>
                        <span>{formatNumber(s.distinct_senders)} senders</span>
                      </div>
                    </div>
                  ))}
                </div>
                <ExplorerLeaderboardTableShell
                  leaderboardId={EXPLORER_LEADERBOARD_IDS.stakeTransfers}
                  visibility="desktop-only"
                >
                  <thead>
                    <tr>
                      <th className={TH}>Subnet</th>
                      <th className={`${TH} text-right`}>Transfers</th>
                      <th className={`${TH} text-right`}>Distinct senders</th>
                      <th className={`${TH} text-right`}>Transfers per sender</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stakeTransfers.subnets.map((s) => (
                      <tr key={s.netuid} className="hover:bg-surface/40">
                        <td className="px-4 py-2 font-mono text-[11px]">
                          <Link
                            to="/subnets/$netuid"
                            params={{ netuid: s.netuid }}
                            className="text-ink-strong hover:text-accent hover:underline"
                          >
                            SN{s.netuid}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                          {formatNumber(s.transfers)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {formatNumber(s.distinct_senders)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {s.transfers_per_sender != null ? s.transfers_per_sender.toFixed(2) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </ExplorerLeaderboardTableShell>
              </>
            ) : (
              <EmptyState title="No stake transfers in this window yet." />
            )}
          </Panel>
        </>
      )}

      {tab === "governance" && (
        <>
          <Panel className="min-w-0 lg:col-span-2">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Network weight-setters
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">
                {formatNumber(weightSetters.distinct_setters)} validators
              </span>
            </div>
            {weightSetters.setters.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Validator</th>
                      <th className={`${TH} text-right`}>WeightsSet</th>
                      <th className={`${TH} text-right`}>Share</th>
                      <th className={`${TH} text-right`}>Last set</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {weightSetters.setters.map((setter) => (
                      <tr key={weightSetterKey(setter)} className="hover:bg-surface/40">
                        <td className="px-4 py-2 font-mono text-[11px]">
                          {setter.hotkey ? (
                            <div className="flex items-center gap-1.5">
                              <Link
                                to="/accounts/$ss58"
                                params={{ ss58: setter.hotkey }}
                                className="text-ink-strong hover:text-accent hover:underline"
                                title={setter.hotkey}
                              >
                                {shortHash(setter.hotkey) ?? setter.hotkey}
                              </Link>
                              <CopyButton value={setter.hotkey} label="hotkey" compact />
                            </div>
                          ) : (
                            <span
                              className="text-ink-muted"
                              title="Uid-only setter scoped to a subnet (no network-wide hotkey)"
                            >
                              {weightSetterLabel(setter)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                          {formatNumber(setter.weight_sets)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {fmtShare(setter.share)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                          {setter.last_set_at ? <TimeAgo at={setter.last_set_at} /> : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No weight-setters in this window yet." />
            )}
          </Panel>
          <ValidatorTurnoverSection turnover={turnover} />
          <NetworkRegistrationsSection registrations={registrations} />
        </>
      )}
    </div>
  );
}

// Ranked sender→receiver native-TAO transfer corridors (#3476). Uses a plain
// useQuery (not the page's suspense queries) so the volume/count sort toggle can
// swap the ranking in place without re-suspending the whole dashboard.
function TransferPairsSection({ win }: { win: "7d" | "30d" }) {
  const [sort, setSort] = useState<"volume" | "count">("volume");
  const pairsQ = useQuery(chainTransferPairsQuery(win, 25, sort));
  const pairs = pairsQ.data?.data;
  const rows = pairs?.pairs ?? [];

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Transfer pairs
          </h2>
          {pairs ? (
            <p className="mt-1 font-mono text-[11px] text-ink-muted">
              {formatNumber(pairs.unique_pairs)} sender→receiver corridors ·{" "}
              {formatTao(pairs.total_volume_tao)} moved
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Sort transfer pairs by">
          {(["volume", "count"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === sort}
              onClick={() => setSort(s)}
              className={
                s === sort
                  ? "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent-text"
                  : "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30"
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {pairsQ.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : pairsQ.error ? (
        <ErrorState
          error={pairsQ.error}
          onRetry={() => pairsQ.refetch()}
          context="transfer pairs"
        />
      ) : rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={`${TH} text-right`}>#</th>
                <th className={TH}>From</th>
                <th className={TH}>To</th>
                <th className={`${TH} text-right`}>Volume</th>
                <th className={`${TH} text-right`}>Transfers</th>
                <th className={`${TH} text-right`}>Last block</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p, i) => (
                <tr key={`${p.from}-${p.to}`} className="hover:bg-surface/40">
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {i + 1}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: p.from }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={p.from}
                      >
                        {shortHash(p.from) ?? p.from}
                      </Link>
                      <CopyButton value={p.from} label="address" compact />
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: p.to }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={p.to}
                      >
                        {shortHash(p.to) ?? p.to}
                      </Link>
                      <CopyButton value={p.to} label="address" compact />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatTao(p.volume_tao)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(p.transfer_count)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {p.last_block != null ? (
                      <Link
                        to="/blocks/$ref"
                        params={{ ref: String(p.last_block) }}
                        className="hover:text-accent hover:underline"
                      >
                        #{formatNumber(p.last_block)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No transfer pairs in this window yet." />
      )}
    </Panel>
  );
}

function ChainEventsFeedSection() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const onFilter = (patch: { pallet?: string; method?: string }) =>
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, ...patch, events_cursor: "" }) as never,
      resetScroll: false,
    });

  return (
    <Panel className="mt-10">
      <div className="mb-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Chain events
        </h2>
        <p className="mt-1 font-mono text-[11px] text-ink-muted">
          Browse individual pallet events newest-first — distinct from aggregate activity stats.
        </p>
      </div>
      <ChainEventsFeed
        pallet={search.pallet}
        method={search.method}
        cursor={search.events_cursor}
        onFilter={onFilter}
      />
    </Panel>
  );
}
