import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo, useState } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Activity, Boxes, Coins, Layers, Zap } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ErrorState, Skeleton } from "@/components/metagraphed/states";
import { ShareButton } from "@/components/metagraphed/share-button";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
import { SearchInput } from "@/components/metagraphed/table-controls";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import {
  chainActivityQuery,
  chainCallsQuery,
  chainEventsInfiniteQuery,
  chainEventsStatsQuery,
  chainFeesQuery,
  chainSignersQuery,
  chainStakeFlowQuery,
  chainStakeMovesQuery,
  chainStakeTransfersQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import type {
  ChainCalls,
  ChainEvent,
  ChainEventsStats,
  ChainStakeFlow,
  ChainStakeMoves,
} from "@/lib/metagraphed/types";

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
  return v < 0 ? `-${fmtTao(-v)}` : `+${fmtTao(v)}`;
}
function fmtTao(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

function ExplorerPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Chain explorer"
        description="The Bittensor network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers."
        actions={<ShareButton />}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <ExplorerDashboard />
        </Suspense>
      </QueryErrorBoundary>
      <ChainEventsFeedSection />
      <ApiSourceFooter
        paths={[
          "/api/v1/chain/activity",
          "/api/v1/chain/fees",
          "/api/v1/chain/calls",
          "/api/v1/chain/signers",
          "/api/v1/chain/stake-flow",
          "/api/v1/chain/stake-moves",
          "/api/v1/chain/stake-transfers",
          "/api/v1/chain-events",
          "/api/v1/chain-events/stats",
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
function CallMixSection({ calls }: { calls: ChainCalls }) {
  const modules = calls.calls.slice(0, 10);
  const [selected, setSelected] = useState<string | null>(null);
  // Function-level rows exist only when the aggregate is grouped by function;
  // at module grouping call_function is null, so this stays empty until then.
  const functions = calls.calls.filter(
    (c) => c.call_function != null && (selected == null || c.call_module === selected),
  );

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Call mix
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(calls.total_extrinsics)} calls
        </span>
      </div>
      {modules.length > 0 ? (
        <div className="space-y-4">
          <ul className="space-y-1.5">
            {modules.map((c) => {
              const cap = Math.max(1, ...modules.map((m) => m.count));
              const pct = Math.max(2, Math.round((c.count / cap) * 100));
              const active = selected === c.call_module;
              return (
                <li key={c.call_module}>
                  <button
                    type="button"
                    onClick={() => setSelected(active ? null : c.call_module)}
                    className="grid w-full grid-cols-[7rem_1fr_auto] items-center gap-2 text-left"
                    aria-pressed={active}
                  >
                    <span
                      className={
                        active
                          ? "truncate font-mono text-[10px] uppercase tracking-widest text-accent"
                          : "truncate font-mono text-[10px] uppercase tracking-widest text-ink-muted"
                      }
                    >
                      {c.call_module}
                    </span>
                    <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: active ? "var(--accent)" : "var(--chart-1)",
                        }}
                      />
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-ink-strong">
                      {formatNumber(c.count)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

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
        <p className="font-mono text-[12px] text-ink-muted">No calls yet.</p>
      )}
    </section>
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
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
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
                <span
                  className="truncate font-mono text-[10px] uppercase tracking-widest text-ink-muted"
                  title={label}
                >
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
        <p className="font-mono text-[12px] text-ink-muted">No raw pallet events indexed yet.</p>
      )}
    </section>
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
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
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
            <StakeFlowMetric label="Gross flow" value={fmtTao(net.gross_flow_tao)} />
            <StakeFlowMetric label="Staked" value={fmtTao(net.total_staked_tao)} />
            <StakeFlowMetric label="Unstaked" value={fmtTao(net.total_unstaked_tao)} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-widest">
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
                    <span className="truncate font-mono text-[10px] uppercase tracking-widest text-ink-muted">
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
        <p className="font-mono text-[12px] text-ink-muted">No stake flow in this window yet.</p>
      )}

      {dist ? (
        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-ink-muted">
          Median net flow {fmtTaoSigned(dist.median ?? 0)}, largest single outflow{" "}
          {fmtTaoSigned(dist.min ?? 0)} across {formatNumber(dist.count)} subnets.
        </p>
      ) : null}
    </section>
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
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
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
                    <span className="truncate font-mono text-[10px] uppercase tracking-widest text-ink-muted">
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
        <p className="font-mono text-[12px] text-ink-muted">No stake moves in this window yet.</p>
      )}

      {dist ? (
        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-ink-muted">
          Median {(dist.median ?? 0).toFixed(1)} moves per mover, up to {(dist.max ?? 0).toFixed(1)}{" "}
          in the busiest subnet, across {formatNumber(dist.count)} subnets.
        </p>
      ) : null}
    </section>
  );
}

function ExplorerDashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  const activity = useSuspenseQuery(chainActivityQuery(win)).data.data;
  const fees = useSuspenseQuery(chainFeesQuery(win)).data.data;
  const calls = useSuspenseQuery(chainCallsQuery(win)).data.data;
  const signers = useSuspenseQuery(chainSignersQuery(win)).data.data;
  const stakeFlow = useSuspenseQuery(chainStakeFlowQuery(win)).data.data;
  const stakeMoves = useSuspenseQuery(chainStakeMovesQuery(win)).data.data;
  const stakeTransfers = useSuspenseQuery(chainStakeTransfersQuery(win)).data.data;
  const eventMix = useSuspenseQuery(chainEventsStatsQuery()).data.data;

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
                ? "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent"
                : "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30"
            }
          >
            {w}
          </button>
        ))}
      </div>

      {/* KPI tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
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
        <StatTile icon={Coins} eyebrow="Fees" value={fmtTao(totalFees)} hint={`${win} total`} />
        <StatTile
          icon={Coins}
          eyebrow="Tips"
          value={fmtTao(totalTips)}
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

      {/* daily activity series */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Daily activity
          </h2>
          <span className="font-mono text-[11px] text-ink-muted">{activity.day_count} days</span>
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
          <p className="font-mono text-[12px] text-ink-muted">
            No activity indexed yet — the chain poller fills this every few minutes.
          </p>
        )}
      </section>

      {/* fees: daily series + tip series + top payers */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
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
                formatValue={fmtTao}
              />
              <MiniSeries
                label="Avg fee"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.avg_fee_tao ?? 0)}
                color="var(--chart-3)"
                formatValue={fmtTao}
              />
              <MiniSeries
                label="Total tips"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.total_tip_tao)}
                color="var(--chart-6)"
                formatValue={fmtTao}
              />
              <MiniSeries
                label="Avg tip"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.avg_tip_tao ?? 0)}
                color="var(--chart-1)"
                formatValue={fmtTao}
              />
            </div>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No fees in this window yet.</p>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Top fee payers
            </h2>
            <span className="font-mono text-[11px] text-ink-muted">
              {fees.top_fee_payers.length} accounts
            </span>
          </div>
          {fees.top_fee_payers.length > 0 ? (
            <table className="w-full text-left text-sm">
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
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: p.signer }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={p.signer}
                      >
                        {shortHash(p.signer) ?? p.signer}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                      {fmtTao(p.total_fee_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(p.total_tip_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {formatNumber(p.extrinsic_count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">
              No fee payers in this window yet.
            </p>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* call mix */}
        <CallMixSection calls={calls} />

        {/* top signers */}
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Most active accounts
          </h2>
          {signers.signers.length > 0 ? (
            <table className="w-full text-left text-sm">
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
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: s.signer }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={s.signer}
                      >
                        {shortHash(s.signer) ?? s.signer}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                      {formatNumber(s.tx_count)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(s.total_fee_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(s.total_tip_tao)}
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
            </table>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No signers in this window yet.</p>
          )}
        </section>
      </div>

      <StakeFlowSection flow={stakeFlow} />

      <StakeMovesSection moves={stakeMoves} />

      {/* stake-transfer leaderboard */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
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
          <table className="w-full text-left text-sm">
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
          </table>
        ) : (
          <p className="font-mono text-[12px] text-ink-muted">
            No stake transfers in this window yet.
          </p>
        )}
      </section>
      <PalletEventMixSection stats={eventMix} />
    </div>
  );
}

function ChainEventsFeedSection() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const baseParams = useMemo(
    () => ({
      pallet: search.pallet.trim() || undefined,
      method: search.pallet.trim() && search.method.trim() ? search.method.trim() : undefined,
      limit: 50,
    }),
    [search.pallet, search.method],
  );

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    error,
    isPending,
    isFetching,
    refetch,
  } = useInfiniteQuery(chainEventsInfiniteQuery(baseParams, search.events_cursor));

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, ...patch, events_cursor: "" }) as never,
      resetScroll: false,
    });

  const pages = data?.pages ?? [];
  const lastPage = pages[pages.length - 1];
  const cursorInvalid = !!(lastPage as { cursorInvalid?: boolean } | undefined)?.cursorInvalid;
  const events = pages.flatMap((p) => (p.data ?? []) as ChainEvent[]);
  const filtersActive = !!(search.pallet.trim() || search.method.trim());

  const filters = (
    <>
      <SearchInput
        value={search.pallet}
        onChange={(v) => setSearch({ pallet: v, method: v.trim() ? search.method : "" })}
        placeholder="Filter by pallet"
        className="min-w-[140px] flex-none font-mono text-[11px]"
      />
      <SearchInput
        value={search.method}
        onChange={(v) => setSearch({ method: v })}
        placeholder={search.pallet.trim() ? "Filter by method" : "Method (requires pallet)"}
        className="min-w-[140px] flex-none font-mono text-[11px]"
      />
    </>
  );

  const emptyNode = (
    <p className="font-mono text-[12px] text-ink-muted">
      {filtersActive
        ? "No chain events match these filters."
        : "No chain events indexed yet — the all-events backfill fills this feed."}
    </p>
  );

  const table = (
    <table className="w-full text-left text-sm">
      <thead className="bg-surface/40">
        <tr>
          <th className={TH}>Pallet.method</th>
          <th className={TH}>Block</th>
          <th className={`${TH} text-right`}>Observed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {events.map((event) => (
          <tr key={`${event.block_number}-${event.event_index}`} className="hover:bg-surface/40">
            <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
              {extrinsicCall(event.pallet, event.method)}
            </td>
            <td className="px-4 py-2.5 font-mono text-[11px]">
              {event.block_number != null ? (
                <Link
                  to="/blocks/$ref"
                  params={{ ref: String(event.block_number) }}
                  className="text-ink-strong hover:text-accent hover:underline"
                >
                  #{formatNumber(event.block_number)}
                </Link>
              ) : (
                "—"
              )}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
              <TimeAgo at={event.observed_at} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const cards = events.map((event) => (
    <div
      key={`${event.block_number}-${event.event_index}-card`}
      className="rounded border border-border bg-card p-3 min-h-11"
    >
      <div className="font-mono text-[11px] text-ink-strong">
        {extrinsicCall(event.pallet, event.method)}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-muted">
        {event.block_number != null ? (
          <Link
            to="/blocks/$ref"
            params={{ ref: String(event.block_number) }}
            className="hover:text-accent hover:underline"
          >
            #{formatNumber(event.block_number)}
          </Link>
        ) : (
          <span>—</span>
        )}
        <TimeAgo at={event.observed_at} />
      </div>
    </div>
  ));

  return (
    <section className="mt-10 rounded-lg border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Chain events
        </h2>
        <p className="mt-1 font-mono text-[11px] text-ink-muted">
          Browse individual pallet events newest-first — distinct from aggregate activity stats.
        </p>
      </div>

      {isPending ? (
        <Skeleton className="h-56 w-full" />
      ) : error && !data ? (
        <ErrorState
          error={error}
          context="chain events feed"
          onRetry={() => {
            void refetch();
          }}
        />
      ) : (
        <ListShell
          filters={filters}
          table={table}
          cards={cards}
          isEmpty={events.length === 0 && !isFetching}
          empty={emptyNode}
          isStale={isFetching && !isPending && !isFetchingNextPage}
          footer={
            events.length > 0 ? (
              <LoadMore
                hasMore={!!hasNextPage}
                isLoading={isFetchingNextPage}
                onLoadMore={() => {
                  void fetchNextPage();
                }}
                shown={events.length}
                error={isFetchNextPageError ? error : null}
                cursorInvalid={cursorInvalid}
              />
            ) : undefined
          }
        />
      )}
    </section>
  );
}
