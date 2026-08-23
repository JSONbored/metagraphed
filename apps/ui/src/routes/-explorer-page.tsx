import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ChainOverviewSearch } from "./chain.index";
import { useQuery, useSuspenseQueries } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CrowdloansPanel } from "@/components/metagraphed/crowdloans-panel";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import {
  TimeAgo,
  SectionHead,
  FactStrip,
  FactCell,
  RangeControl,
  LineWithWindow,
  CompositionBreakdown,
  RankedRails,
  DataTable,
  type CellValue,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ChainEventCard } from "@/components/metagraphed/chain-events-feed";
import { WhatChangedFeed } from "@/components/metagraphed/analytics/what-changed-feed";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import {
  NetworkDecentralizationPanel,
  NetworkDecentralizationSkeleton,
} from "@/components/metagraphed/network-decentralization-panel";
import {
  EmissionYieldPanel,
  EmissionYieldSkeleton,
} from "@/components/metagraphed/emission-yield-panel";
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
  chainConcentrationQuery,
  chainPerformanceQuery,
  chainYieldQuery,
  economicsTrendsQuery,
  recentChainEventsQuery,
} from "@/lib/metagraphed/queries";
import { toLinePoints } from "@/components/metagraphed/metric-history";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { ChainTabActions } from "./-chain-hub";
import { BlockCard } from "./-blocks-index-page";
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
  ChainSignerEntry,
  ChainTransferEntry,
  ChainTransfers,
} from "@/lib/metagraphed/types";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { railItems } from "@/lib/metagraphed/rails";

// #3373: compact live chain-head tip in the hero — "head #NNNN · N ago" from the
// live /api/v1/blocks feed (limit 1), linking to that block. Mirrors #3372's
// ChainHeadTip on the home page: plain useQuery so a cold/failed fetch silently
// renders null and never disrupts the primary hero or the daily-aggregate KPIs.
//
// Hydration-gated like nav-status-dot.tsx's health dot (#8241): `enabled`
// keeps the query from fetching until the client has hydrated, AND the
// render itself checks `hydrated` before ever reading `data` -- registry-
// ticker.tsx queries this exact same key, so `enabled: false` alone isn't
// enough (it only blocks a new fetch, not a read of whatever's already in
// the shared cache from that other consumer). Both together guarantee SSR
// and the first client paint render `null`, and the live link only ever
// appears in a client-only render after that -- never diffed against server
// HTML. Without this, a block landing between the SSR snapshot and the
// client's own fetch resolving (blocks land ~every 12s) made the two sides
// render a different `head.block_number`, or one side `null` and the other
// the Link, throwing React's hydration-mismatch error (#418).
function ChainHeadTip() {
  const hydrated = useHydrated();
  const { data } = useQuery({ ...blocksQuery({ limit: 1 }), enabled: hydrated });
  if (!hydrated) return null;
  const head = data?.data?.[0];
  if (!head || head.block_number == null) return null;
  return (
    <Link
      to="/blocks/$ref"
      params={{ ref: String(head.block_number) }}
      className="inline-flex items-center gap-1.5 text-11 text-ink-muted hover:text-accent transition-colors"
    >
      <span className="mg-live-dot" />
      head #{formatNumber(head.block_number)} · <TimeAgo at={head.observed_at} />
    </Link>
  );
}

/** Section head for a bounded preview — title plus a link to the full feed. */
function PreviewHeader({
  title,
  to,
  search,
}: {
  title: string;
  to: "/chain/blocks" | "/chain/events";
  search?: Record<string, string>;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-11 text-ink-muted">{title}</h3>
      <Link
        to={to}
        search={search}
        className="text-11 text-ink-muted transition-colors hover:text-accent hover:underline"
      >
        View all →
      </Link>
    </div>
  );
}

const PREVIEW_ROW_COUNT = 8;
const PREVIEW_TRANSFER_COUNT = 5;

/**
 * Latest 8 blocks, newest first — a small taste of /chain/blocks reusing its
 * own card row (metagraphed#8359), not a second block-production feed.
 */
function BlocksPreview() {
  const { data } = useQuery(blocksQuery({ limit: PREVIEW_ROW_COUNT }));
  const rows = data?.data ?? [];
  return (
    <Panel className="min-w-0">
      <PreviewHeader title="Latest blocks" to="/chain/blocks" />
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((b) => (
            <BlockCard key={b.block_hash || b.block_number} block={b} />
          ))}
        </div>
      ) : (
        <EmptyState title="No blocks indexed yet." />
      )}
    </Panel>
  );
}

/**
 * Latest 8 chain events, newest first — replaces the old inline
 * ChainEventsFeedSection (a full, unbounded copy of /chain/events, confirmed
 * as genuine duplication during metagraphed#8359's investigation) with a
 * bounded taste that reuses the feed's own ChainEventCard row.
 */
function EventsPreview() {
  const { data } = useQuery(recentChainEventsQuery({ limit: PREVIEW_ROW_COUNT }));
  const rows = data ?? [];
  return (
    <Panel className="min-w-0">
      <PreviewHeader title="Latest events" to="/chain/events" />
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((event) => (
            <ChainEventCard key={`${event.block_number}-${event.event_index}`} event={event} />
          ))}
        </div>
      ) : (
        <EmptyState title="No events indexed yet." />
      )}
    </Panel>
  );
}

/**
 * Latest 5 native-TAO transfers, newest first. There is no standalone
 * "transfers" tab on the hub (metagraphed#8359's investigation found the
 * issue's premise wrong on this point — transfers aren't duplicated
 * anywhere) — a transfer is just a Balances.Transfer chain event, so this
 * reuses the same events endpoint pre-filtered, and "View all" deep-links
 * into /chain/events with that filter already applied.
 */
function TransfersPreview() {
  const { data } = useQuery(
    recentChainEventsQuery({
      limit: PREVIEW_TRANSFER_COUNT,
      pallet: "Balances",
      method: "Transfer",
    }),
  );
  const rows = data ?? [];
  return (
    <Panel className="min-w-0">
      <PreviewHeader
        title="Latest transfers"
        to="/chain/events"
        search={{ pallet: "Balances", method: "Transfer" }}
      />
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((event) => (
            <ChainEventCard key={`${event.block_number}-${event.event_index}`} event={event} />
          ))}
        </div>
      ) : (
        <EmptyState title="No transfers in this window yet." />
      )}
    </Panel>
  );
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

function fmtTaoSigned(v: number): string {
  return v < 0 ? `-${formatTao(-v)}` : `+${formatTao(v)}`;
}

export function ExplorerPage() {
  // #8359: Overview's default view is KPI band + one activity viz + 3 bounded
  // previews (blocks/events/transfers) — everything else (the per-window
  // analytics tabs, network decentralization, emission yield, and the full
  // "what changed" feed) is real, non-duplicated content, just not part of
  // that default read. It stays reachable behind one disclosure toggle
  // shared across the whole page, rather than being deleted — see
  // ExplorerDashboard's own doc comment for why the issue's "already
  // duplicates the hub's sibling tabs" premise only held for chain events.
  const [showAnalytics, setShowAnalytics] = useState(false);
  return (
    <>
      <ChainTabActions>
        <ChainHeadTip />
      </ChainTabActions>
      <AsyncPanel context="explorer dashboard" fallback={<Skeleton className="h-[40rem] w-full" />}>
        <ExplorerDashboard
          showAnalytics={showAnalytics}
          onShowAnalytics={() => setShowAnalytics(true)}
        />
      </AsyncPanel>

      {showAnalytics && (
        <>
          {/* #8253: chain-scope decentralization + emission-yield move here from
              /status, where they were off-topic — /status answers "is it up", not
              "how concentrated is the network". Both are chain-wide metagraph
              rollups, which is exactly what this Overview is. */}
          <section className="mt-10">
            <div className="mb-4">
              <h2 className="text-11 text-ink-muted">Network decentralization</h2>
              <p className="mt-1 text-11 text-ink-muted">
                Chain-wide stake &amp; emission concentration (Gini, HHI, Nakamoto coefficient,
                entropy, top-1% share) and the trust/consensus score spread, computed across every
                subnet from the metagraph snapshot.
              </p>
            </div>
            <AsyncPanel
              context="network decentralization"
              fallback={<NetworkDecentralizationSkeleton />}
              retryQueryKeys={[
                chainConcentrationQuery().queryKey,
                chainPerformanceQuery().queryKey,
              ]}
            >
              <NetworkDecentralizationPanel />
            </AsyncPanel>
          </section>

          <section className="mt-10">
            <div className="mb-4">
              <h2 className="text-11 text-ink-muted">Network emission yield</h2>
              <p className="mt-1 text-11 text-ink-muted">
                Chain-wide emission yield — total emission over total stake, split by
                validator/miner role — plus the per-neuron return distribution, computed across
                every neuron from the metagraph snapshot.
              </p>
            </div>
            <AsyncPanel
              context="network emission yield"
              fallback={<EmissionYieldSkeleton />}
              retryQueryKeys={[chainYieldQuery().queryKey]}
            >
              <EmissionYieldPanel />
            </AsyncPanel>
          </section>

          {/* #8257: the full "what changed" view. The homepage carries a 7-item
              compact version; this one is unbounded within the range and adds the
              per-kind filter chips. Chain Overview rather than /subnets Rankings:
              runtime upgrades and incidents aren't subnet rankings. */}
          <section className="mt-10">
            <SectionHead
              name="What changed"
              question="Registry updates, incidents, on-chain identity edits and runtime upgrades — grouped by day, newest first."
            />
            <TimeRangeProvider>
              <AsyncPanel context="what changed" fallback={<Skeleton className="h-64 w-full" />}>
                <WhatChangedFeed showFilters />
              </AsyncPanel>
            </TimeRangeProvider>
          </section>
        </>
      )}

      {/* #10300: /crowdloans and /crowdloans/{id} were published and rendered
          nowhere. OUTSIDE the `showAnalytics` disclosure on purpose -- that
          block defaults to closed, so mounting here would have satisfied the
          route-coverage sweep while leaving the surface effectively unseen,
          which is the rubber stamp #10300 warned the gate must not become.
          Crowdloans are chain state, not analytics, so they belong in the
          always-rendered body. */}
      <section className="mt-10">
        <SectionHead
          name="Crowdloans"
          question="On-chain crowdloans — raised against cap, and whether they have actually settled."
        />
        <CrowdloansPanel />
      </section>

      <ApiSourceFooter
        paths={[
          "/api/v1/blocks",
          "/api/v1/crowdloans",
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
          "/api/v1/chain/concentration",
          "/api/v1/chain/performance",
          "/api/v1/chain/yield",
        ]}
      />
      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/chain" />
    </>
  );
}

/** `DataTable` cell formatter for a count / ratio column, in this app's units. */
function fmtCount(value: CellValue): string {
  return formatNumber(typeof value === "number" ? value : null);
}

/** `DataTable` cell formatter for a τ amount. */
function fmtTao(value: CellValue): string {
  return formatTao(typeof value === "number" ? value : null);
}

/**
 * One labeled mini-sparkline cell for a daily series. Aligns `days` labels to
 * `values` so the hover tooltip shows the day, and surfaces the latest value
 * as a compact caption.
 */
function MiniSeries({
  label,
  days,
  values,
  formatValue,
}: {
  label: string;
  days: string[];
  values: number[];
  formatValue: (v: number) => string;
}) {
  const latest = values.length > 0 ? values[values.length - 1]! : null;
  const points = toLinePoints(
    values.map((v, i) => ({ day: days[i] ?? "", v })),
    (r) => r.day,
    (r) => r.v,
  );
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-13 text-ink-muted">{label}</span>
        <span className="text-11 tabular-nums text-ink-strong">
          {latest == null ? "—" : formatValue(latest)}
        </span>
      </div>
      {points.length > 1 ? (
        <LineWithWindow
          compact
          points={points}
          window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
          unit={label.toLowerCase()}
          formatValue={formatValue}
          ariaLabel={`Daily ${label.toLowerCase()}`}
          source={`chain-${label.toLowerCase().replace(/\s+/g, "-")}`}
        />
      ) : null}
    </div>
  );
}

/**
 * Call mix — the top modules as a composition bar, plus a click-through drill-down into
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
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="text-11 text-ink-muted">Call mix</h2>
        <span className="text-11 text-ink-muted">{formatNumber(calls.total_extrinsics)} calls</span>
      </div>
      {modules.length > 0 ? (
        <div className="space-y-4">
          <CompositionBreakdown
            segments={modules.map((c) => ({
              key: c.call_module,
              label: c.call_module,
              value: c.count,
            }))}
            formatValue={(v) => formatNumber(v)}
            ariaLabel="Calls by module"
            onActivate={(key) => setSelected(selected === key ? null : key)}
          />

          {functions.length > 0 ? (
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-13 text-ink-muted">
                {selected ? `${selected} functions` : "Function breakdown"}
              </div>
              <RankedRails
                items={railItems(
                  functions.slice(0, 10).map((c) => ({
                    label: c.call_function ?? c.call_module,
                    value: c.count,
                  })),
                )}
                formatValue={(v) => formatNumber(v)}
                ariaLabel={selected ? `${selected} functions` : "Function breakdown"}
              />
            </div>
          ) : (
            <p className="border-t border-border pt-3 text-11 text-ink-muted">
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
// above (/chain/calls). Same ranked-list-with-proportional-bar idiom, capped
// to the busiest 10 rows; the header reports the distinct group count and the
// block window scanned. Empty until the all-events backfill runs.
function PalletEventMixSection({ stats }: { stats: ChainEventsStats }) {
  const rows = stats.activity.slice(0, 10);
  const cap = Math.max(1, ...rows.map((r) => r.count));

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h2 className="text-11 text-ink-muted">Pallet event mix</h2>
        <span className="text-11 text-ink-muted">
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
                <span className="text-13 truncate text-ink-muted">{label}</span>
                <span className="relative h-1.5 overflow-hidden rounded bg-surface">
                  <span
                    className="absolute inset-y-0 left-0 rounded"
                    style={{ width: `${pct}%`, background: "var(--chart-1)" }}
                  />
                </span>
                <span className="text-10 tabular-nums text-ink-strong">
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
      <div className="text-13 text-ink-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-13 tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

/**
 * Network-wide stake flow (#3734) — total staked vs unstaked across every subnet
 * for the window, the gaining/losing/flat split, and the top net inflows as a
 * bar list. The endpoint returns subnets sorted descending by net flow and caps
 * the list server-side (LIMIT_MAX 100 of ~129 netuids), so it is a
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
        <h2 className="text-11 text-ink-muted">Stake flow</h2>
        <span className="text-11 text-ink-muted">{formatNumber(flow.subnet_count)} subnets</span>
      </div>

      {net ? (
        <div className="mb-4 space-y-3">
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
          <div className="text-13 flex flex-wrap items-center gap-x-4 gap-y-1">
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
          <div className="mb-2 text-13 text-ink-muted">Top net inflows</div>
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
                    <span className="text-13 truncate text-ink-muted">SN{s.netuid}</span>
                    <span className="relative h-1.5 overflow-hidden rounded bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded"
                        style={{
                          width: `${pct}%`,
                          background: inflow ? "var(--health-ok)" : "var(--health-down)",
                        }}
                      />
                    </span>
                    <span
                      className={`text-right text-10 tabular-nums ${
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
        <p className="mt-4 border-t border-border pt-3 text-10 text-ink-muted">
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
        <h2 className="text-11 text-ink-muted">Stake moves</h2>
        <span className="text-11 text-ink-muted">{formatNumber(moves.subnet_count)} subnets</span>
      </div>

      {net ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StakeFlowMetric label="Distinct movers" value={formatNumber(net.distinct_movers)} />
          <StakeFlowMetric label="Movements" value={formatNumber(net.movements)} />
          <StakeFlowMetric label="Moves / mover" value={net.movements_per_mover.toFixed(2)} />
        </div>
      ) : null}

      {busiest.length > 0 ? (
        <div>
          <div className="mb-2 text-13 text-ink-muted">Busiest subnets</div>
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
                    <span className="text-13 truncate text-ink-muted">SN{s.netuid}</span>
                    <span className="relative h-1.5 overflow-hidden rounded bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded"
                        style={{ width: `${pct}%`, background: "var(--accent)" }}
                      />
                    </span>
                    <span className="text-right text-10 tabular-nums text-ink-strong">
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
        <p className="mt-4 border-t border-border pt-3 text-10 text-ink-muted">
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
      <h2 className="mb-6 text-11 text-ink-muted">Network operations</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChainServingLeaderboard board={serving} />
        {/* #8292: rendered nothing but a framed "no data" box in every window
            observed — a panel with no data is noise, not information. It
            reappears on its own the moment exporters report. */}
        {prometheus.network?.announcements ? (
          <ChainPrometheusLeaderboard board={prometheus} />
        ) : null}
      </div>
    </section>
  );
}

function ChainServingLeaderboard({ board }: { board: ChainServing }) {
  const net = board.network;

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h3 className="text-11 text-ink-muted">Axon serving</h3>
        <span className="text-11 text-ink-muted">{formatNumber(board.subnet_count)} subnets</span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StakeFlowMetric label="Announcements" value={formatNumber(net.announcements)} />
        <StakeFlowMetric label="Distinct servers" value={formatNumber(net.distinct_servers)} />
        <StakeFlowMetric
          label="Per server"
          value={
            net.announcements_per_server != null ? net.announcements_per_server.toFixed(2) : "—"
          }
        />
      </div>

      <DataTable
        rows={board.subnets}
        rowKey={(row) => String(row.netuid)}
        caption="Axon serving by subnet"
        captionHidden
        link={RouterLink}
        source="chain-serving"
        rowHref={(row) => `/subnets/${row.netuid}`}
        empty={<EmptyState title="No serving activity in this window yet." />}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "announcements",
            label: "Announcements",
            kind: "number",
            sortable: true,
            value: (row) => row.announcements,
            format: fmtCount,
          },
          {
            key: "distinct_servers",
            label: "Distinct servers",
            kind: "number",
            sortable: true,
            value: (row) => row.distinct_servers,
            format: fmtCount,
          },
          {
            key: "per_server",
            label: "Per server",
            kind: "number",
            sortable: true,
            value: (row) => row.announcements_per_server,
            format: fmtCount,
          },
        ]}
      />
    </Panel>
  );
}

function ChainPrometheusLeaderboard({ board }: { board: ChainPrometheus }) {
  const net = board.network;

  // #8253: render nothing until there's data, rather than a framed panel of
  // zeroes above an "No Prometheus telemetry in this window yet" box. Gated
  // on the network rollup being empty too, not just the per-subnet table --
  // a zeroed rollup with no rows is the whole panel saying nothing.
  if (board.subnets.length === 0 && !net.announcements && !net.distinct_exporters) return null;

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <h3 className="text-11 text-ink-muted">Prometheus telemetry</h3>
        <span className="text-11 text-ink-muted">{formatNumber(board.subnet_count)} subnets</span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StakeFlowMetric label="Announcements" value={formatNumber(net.announcements)} />
        <StakeFlowMetric label="Distinct exporters" value={formatNumber(net.distinct_exporters)} />
        <StakeFlowMetric
          label="Per exporter"
          value={
            net.announcements_per_exporter != null ? net.announcements_per_exporter.toFixed(2) : "—"
          }
        />
      </div>

      <DataTable
        rows={board.subnets}
        rowKey={(row) => String(row.netuid)}
        caption="Prometheus telemetry by subnet"
        captionHidden
        link={RouterLink}
        source="chain-prometheus"
        rowHref={(row) => `/subnets/${row.netuid}`}
        empty={<EmptyState title="No Prometheus telemetry in this window yet." />}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "announcements",
            label: "Announcements",
            kind: "number",
            sortable: true,
            value: (row) => row.announcements,
            format: fmtCount,
          },
          {
            key: "distinct_exporters",
            label: "Distinct exporters",
            kind: "number",
            sortable: true,
            value: (row) => row.distinct_exporters,
            format: fmtCount,
          },
          {
            key: "per_exporter",
            label: "Per exporter",
            kind: "number",
            sortable: true,
            value: (row) => row.announcements_per_exporter,
            format: fmtCount,
          },
        ]}
      />
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
  // #8253: same empty-module rule as the Prometheus board above — an
  // all-zero "0 teardowns across 0 removers" header over an empty-state box
  // is a framed panel saying nothing.
  if (churn.subnets.length === 0 && !churn.network.removals && !churn.network.distinct_removers) {
    return null;
  }

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
        <div>
          <h2 className="text-11 text-ink-muted">Axon churn leaderboard</h2>
          <p className="mt-1 text-11 text-ink-muted">
            {formatNumber(churn.network.removals)} axon teardowns across{" "}
            {formatNumber(churn.network.distinct_removers)} removers network-wide
          </p>
        </div>
        <span className="text-11 text-ink-muted">{churn.subnets.length} subnets</span>
      </div>
      <DataTable
        rows={churn.subnets}
        rowKey={(row) => String(row.netuid)}
        caption="Axon churn by subnet"
        captionHidden
        link={RouterLink}
        source="chain-axon-churn"
        rowHref={(row) => `/subnets/${row.netuid}`}
        empty={<EmptyState title="No axon teardowns in this window yet." />}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "removals",
            label: "Teardowns",
            kind: "number",
            sortable: true,
            value: (row) => row.removals,
            format: fmtCount,
          },
          {
            key: "distinct_removers",
            label: "Distinct removers",
            kind: "number",
            sortable: true,
            value: (row) => row.distinct_removers,
            format: fmtCount,
          },
          {
            key: "per_remover",
            label: "Teardowns per remover",
            kind: "number",
            sortable: true,
            value: (row) => row.removals_per_remover,
            format: fmtCount,
          },
        ]}
      />
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
          <h2 className="text-11 text-ink-muted">Idle stake</h2>
          <p className="mt-1 text-11 text-ink-muted">
            Stake delegated to hotkeys currently earning zero dividends
          </p>
        </div>
        <span className="text-11 text-ink-muted">
          {formatNumber(idleStake.subnet_count)} subnets
        </span>
      </div>

      <FactStrip variant="grid">
        <FactCell
          label="Total idle stake"
          value={formatTao(idleStake.total_idle_stake_alpha)}
          hint="network-wide, zero-dividend"
        />
        <FactCell
          label="Idle subnets"
          value={formatNumber(idleStake.subnet_count)}
          hint="with idle stake"
        />
        <FactCell
          label="Idle hotkeys"
          value={formatNumber(totalIdleHotkeys)}
          hint="earning zero dividends"
        />
      </FactStrip>

      <DataTable
        rows={idleStake.subnets}
        rowKey={(row) => String(row.netuid)}
        caption="Idle stake by subnet"
        captionHidden
        link={RouterLink}
        source="chain-idle-stake"
        rowHref={(row) => `/subnets/${row.netuid}`}
        empty={<EmptyState title="No idle stake in this snapshot yet." />}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "idle_stake",
            label: "Idle stake",
            kind: "number",
            sortable: true,
            value: (row) => row.idle_stake_alpha,
            format: fmtTao,
          },
          {
            key: "idle_neurons",
            label: "Idle hotkeys",
            kind: "number",
            sortable: true,
            value: (row) => row.idle_neuron_count,
            format: fmtCount,
          },
          {
            key: "neurons",
            label: "Neurons",
            kind: "number",
            sortable: true,
            value: (row) => row.neuron_count,
            format: fmtCount,
          },
        ]}
      />
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
        <h2 className="text-11 text-ink-muted">Network registrations</h2>
        <span className="text-11 text-ink-muted">
          {formatNumber(registrations.subnet_count)} subnets
        </span>
      </div>

      <FactStrip variant="grid">
        <FactCell
          label="Registrations"
          value={formatNumber(net.registrations)}
          hint={`${registrations.window ?? "window"} total`}
        />
        <FactCell
          label="Distinct registrants"
          value={formatNumber(net.distinct_registrants)}
          hint="network-wide hotkeys"
        />
        <FactCell
          label="Per registrant"
          value={
            net.registrations_per_registrant != null
              ? net.registrations_per_registrant.toFixed(2)
              : "—"
          }
          hint="avg registrations"
        />
      </FactStrip>

      <DataTable
        rows={registrations.subnets}
        rowKey={(row) => String(row.netuid)}
        caption="Registrations by subnet"
        captionHidden
        link={RouterLink}
        source="chain-registrations"
        rowHref={(row) => `/subnets/${row.netuid}`}
        empty={<EmptyState title="No registrations in this window yet." />}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "registrations",
            label: "Registrations",
            kind: "number",
            sortable: true,
            value: (row) => row.registrations,
            format: fmtCount,
          },
          {
            key: "distinct_registrants",
            label: "Distinct registrants",
            kind: "number",
            sortable: true,
            value: (row) => row.distinct_registrants,
            format: fmtCount,
          },
          {
            key: "per_registrant",
            label: "Per registrant",
            kind: "number",
            sortable: true,
            value: (row) => row.registrations_per_registrant,
            format: fmtCount,
          },
        ]}
      />
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
        <h2 className="text-11 text-ink-muted">Validator turnover</h2>
        <span className="text-11 text-ink-muted">
          {formatNumber(turnover.subnet_count)} subnets
        </span>
      </div>

      {net ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <div className="mb-2 text-13 text-ink-muted">Most volatile subnets</div>
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
                    <span className="text-13 truncate text-ink-muted">SN{s.netuid}</span>
                    <span className="relative h-1.5 overflow-hidden rounded bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded"
                        style={{ width: `${pct}%`, background: "var(--health-warn)" }}
                      />
                    </span>
                    <span className="text-right text-10 tabular-nums text-ink-strong">
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
        <p className="mt-4 border-t border-border pt-3 text-10 text-ink-muted">
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
        <h2 className="text-11 text-ink-muted">Network economics trend</h2>
        <span className="text-11 text-ink-muted">{trends.day_count} days</span>
      </div>
      {chrono.length > 0 ? (
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
          <MiniSeries
            label="Total stake"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.total_stake_alpha ?? 0)}
            formatValue={formatTao}
          />
          <MiniSeries
            label="Alpha price"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.alpha_price_tao_weighted ?? 0)}
            formatValue={formatTao}
          />
          <MiniSeries
            label="Emission share"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => (d.mean_emission_share ?? 0) * 100)}
            formatValue={(v) => `${v.toFixed(3)}%`}
          />
          <MiniSeries
            label="Validators"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.validator_count ?? 0)}
            formatValue={(v) => formatNumber(v)}
          />
          <MiniSeries
            label="Miners"
            days={chrono.map((d) => d.snapshot_date)}
            values={chrono.map((d) => d.miner_count ?? 0)}
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

/** Top senders and top receivers rank the same shape, so they share one spec. */
const transferLeaderboardColumns: DataTableColumn<ChainTransferEntry>[] = [
  {
    key: "address",
    label: "Account",
    value: (row) => row.address,
    render: (row) => (
      <AddressDisplay
        ss58={row.address}
        fallback={<>{row.address}</>}
        compact
        valueClassName="text-ink-strong hover:text-accent"
      />
    ),
  },
  {
    key: "volume",
    label: "Volume",
    kind: "number",
    sortable: true,
    value: (row) => row.volume_tao,
    format: fmtTao,
  },
  {
    key: "transfers",
    label: "Transfers",
    kind: "number",
    sortable: true,
    value: (row) => row.transfer_count,
    format: fmtCount,
  },
];

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
        <h2 className="text-11 text-ink-muted">Transfers leaderboard</h2>
        <span className="text-11 text-ink-muted">
          {formatNumber(transfers.transfer_count)} transfers
        </span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <div className="mb-2 text-13 text-ink-muted">Top senders</div>
          <DataTable
            rows={transfers.top_senders}
            rowKey={(row) => row.address}
            caption="Top senders"
            captionHidden
            link={RouterLink}
            source="chain-top-senders"
            empty={<EmptyState title="No senders in this window yet." />}
            columns={transferLeaderboardColumns}
          />
        </div>

        <div>
          <div className="mb-2 text-13 text-ink-muted">Top receivers</div>
          <DataTable
            rows={transfers.top_receivers}
            rowKey={(row) => row.address}
            caption="Top receivers"
            captionHidden
            link={RouterLink}
            source="chain-top-receivers"
            empty={<EmptyState title="No receivers in this window yet." />}
            columns={transferLeaderboardColumns}
          />
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

/**
 * metagraphed#8359 correction: the issue that spawned this trim assumed the
 * ~20 analytics panels below (call mix, stake flow, leaderboards, ...) were
 * duplicates of the hub's Blocks/Extrinsics/Events/Governance/Runtime tabs.
 * Investigation found that's only true for one of them — the old
 * ChainEventsFeedSection, a full unbounded copy of /chain/events (now
 * replaced by EventsPreview below). Everything else here is unique,
 * already-tabbed content (see EXPLORER_TABS) with no sibling-tab equivalent;
 * deleting it would be a real regression, not de-duplication. So instead of
 * removing it, `showAnalytics` (owned by the caller, ExplorerPage, so the
 * same toggle also gates the network-decentralization/emission-yield/
 * what-changed sections below this component) keeps it out of the default
 * mobile read without taking it away.
 */
function ExplorerDashboard({
  showAnalytics,
  onShowAnalytics,
}: {
  showAnalytics: boolean;
  onShowAnalytics: () => void;
}) {
  const search = useSearch({ from: "/chain/" }) as ChainOverviewSearch;
  const navigate = useNavigate({ from: "/chain/" });
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
  // #8292: the Most-active-accounts fee/tip columns rendered 0.0000 τ for
  // every row in every window observed. Drive the columns off the data rather
  // than hardcoding their removal, so they return by themselves if the fee
  // market ever wakes up.
  const anySignerFees = signers.signers.some((s) => (s.total_fee_tao ?? 0) > 0);
  const anySignerTips = signers.signers.some((s) => (s.total_tip_tao ?? 0) > 0);

  // #5328: group the ~20 chain-analytics panels into tabs so the page is no
  // longer one ~24,000px vertical feed. Only the active tab's panels mount; the
  // queries above are batched once, so switching tabs never re-suspends.
  const [tab, setTab] = useState<ExplorerTab>("activity");
  return (
    <div className="space-y-10">
      <RangeControl
        label="Window"
        options={[
          { value: "7d", label: "7d" },
          { value: "30d", label: "30d" },
        ]}
        value={win}
        onChange={(w) => navigate({ search: { window: w } })}
      />

      {/* KPI tiles */}
      <FactStrip variant="grid">
        <FactCell label="Extrinsics" value={formatNumber(totalExtrinsics)} hint={`${win} total`} />
        <FactCell label="Blocks" value={formatNumber(totalBlocks)} hint={`${win} total`} />
        <FactCell label="Events" value={formatNumber(totalEvents)} hint={`${win} total`} />
        <FactCell label="Fees" value={formatTao(totalFees)} hint={`${win} total`} />
        <FactCell label="Tips" value={formatTao(totalTips)} hint={`${win} total`} />
        <FactCell
          label="Success rate"
          value={successRate == null ? "—" : `${(successRate * 100).toFixed(2)}%`}
          hint="successful / total"
        />
      </FactStrip>

      {/* one activity viz, always visible (#8359) */}
      <Panel className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
          <h2 className="text-11 text-ink-muted">Daily activity</h2>
          <span className="text-11 text-ink-muted">{activity.day_count} days</span>
        </div>
        {chrono.length > 0 ? (
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
            <MiniSeries
              label="Extrinsics"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.extrinsic_count)}
              formatValue={(v) => formatNumber(v)}
            />
            <MiniSeries
              label="Events"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.event_count)}
              formatValue={(v) => formatNumber(v)}
            />
            <MiniSeries
              label="Unique signers"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.unique_signers)}
              formatValue={(v) => formatNumber(v)}
            />
          </div>
        ) : (
          <EmptyState title="No activity indexed yet — the chain poller fills this every few minutes." />
        )}
      </Panel>

      {/* 3 bounded previews, always visible (#8359) */}
      <div className="grid gap-4 lg:grid-cols-3">
        <BlocksPreview />
        <EventsPreview />
        <TransfersPreview />
      </div>

      {!showAnalytics && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onShowAnalytics}
            aria-expanded={false}
            className="inline-flex items-center gap-2 rounded border border-border bg-card px-4 py-2.5 text-13 font-medium text-ink-strong transition-colors hover:border-accent/60 hover:text-accent"
          >
            Show more chain analytics
            <ChevronDown className="size-4" />
          </button>
        </div>
      )}

      {showAnalytics && (
        <>
          <RangeControl
            label="Explorer sections"
            options={EXPLORER_TABS.map((t) => ({ value: t.id, label: t.label }))}
            value={tab}
            onChange={setTab}
          />

          {tab === "activity" && (
            <>
              {/* call mix + most active accounts */}
              <div className="grid gap-6 lg:grid-cols-2">
                <CallMixSection calls={calls} />

                {/* top signers */}
                <Panel className="min-w-0">
                  <h2 className="mb-4 text-11 text-ink-muted">Most active accounts</h2>
                  <DataTable
                    rows={signers.signers.slice(0, 12)}
                    rowKey={(row) => row.signer}
                    caption="Most active accounts"
                    captionHidden
                    link={RouterLink}
                    source="chain-signers"
                    empty={<EmptyState title="No signers in this window yet." />}
                    columns={[
                      {
                        key: "signer",
                        label: "Account",
                        value: (row) => row.signer,
                        render: (row) => (
                          <AddressDisplay
                            ss58={row.signer}
                            fallback={<>{row.signer}</>}
                            compact
                            valueClassName="text-ink-strong hover:text-accent"
                          />
                        ),
                      },
                      {
                        key: "tx_count",
                        label: "Txs",
                        kind: "number",
                        sortable: true,
                        value: (row) => row.tx_count,
                        format: fmtCount,
                      },
                      // #8292: these read 0.0000 τ for every row in every
                      // window observed — subtensor's fee market is
                      // effectively idle. A column of zeroes is not data, so
                      // it renders only when some row actually has a value.
                      ...(anySignerFees
                        ? [
                            {
                              key: "fees",
                              label: "Fees",
                              kind: "number" as const,
                              sortable: true,
                              value: (row: ChainSignerEntry) => row.total_fee_tao,
                              format: fmtTao,
                            },
                          ]
                        : []),
                      ...(anySignerTips
                        ? [
                            {
                              key: "tips",
                              label: "Tips",
                              kind: "number" as const,
                              sortable: true,
                              value: (row: ChainSignerEntry) => row.total_tip_tao,
                              format: fmtTao,
                            },
                          ]
                        : []),
                      {
                        key: "last_block",
                        label: "Last block",
                        kind: "link",
                        align: "right",
                        sortable: true,
                        value: (row) => row.last_tx_block,
                        format: (value) =>
                          typeof value === "number" ? `#${formatNumber(value)}` : "—",
                        href: (row) =>
                          row.last_tx_block != null ? `/blocks/${row.last_tx_block}` : undefined,
                      },
                    ]}
                  />
                </Panel>
              </div>
              <NetworkOperationsSection serving={serving} prometheus={prometheus} />
              {/* #8292: showed "0 axon teardowns across 0 removers" in every
              window observed. Hidden until the tier reports something, rather
              than rendering an empty framed board. */}
              {axonChurn.network?.removals ? <AxonChurnSection churn={axonChurn} /> : null}
              <PalletEventMixSection stats={eventMix} />
            </>
          )}

          {tab === "fees" && (
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel className="min-w-0">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
                  <h2 className="text-11 text-ink-muted">Daily fees &amp; tips</h2>
                  <span className="text-11 text-ink-muted">{fees.day_count} days</span>
                </div>
                {feeChrono.length > 0 ? (
                  <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
                    <MiniSeries
                      label="Total fees"
                      days={feeChrono.map((d) => d.day)}
                      values={feeChrono.map((d) => d.total_fee_tao)}
                      formatValue={formatTao}
                    />
                    <MiniSeries
                      label="Avg fee"
                      days={feeChrono.map((d) => d.day)}
                      values={feeChrono.map((d) => d.avg_fee_tao ?? 0)}
                      formatValue={formatTao}
                    />
                    <MiniSeries
                      label="Total tips"
                      days={feeChrono.map((d) => d.day)}
                      values={feeChrono.map((d) => d.total_tip_tao)}
                      formatValue={formatTao}
                    />
                    <MiniSeries
                      label="Avg tip"
                      days={feeChrono.map((d) => d.day)}
                      values={feeChrono.map((d) => d.avg_tip_tao ?? 0)}
                      formatValue={formatTao}
                    />
                  </div>
                ) : (
                  <EmptyState title="No fees in this window yet." />
                )}
              </Panel>
              <Panel className="min-w-0">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
                  <h2 className="text-11 text-ink-muted">Top fee payers</h2>
                  <span className="text-11 text-ink-muted">
                    {fees.top_fee_payers.length} accounts
                  </span>
                </div>
                {/* Table alone — the former bar chart restated the same ranked fee
                    list with no distinct cut of the data (#5313). */}
                <DataTable
                  rows={fees.top_fee_payers}
                  rowKey={(row) => row.signer}
                  caption="Top fee payers"
                  captionHidden
                  link={RouterLink}
                  source="chain-fee-payers"
                  empty={<EmptyState title="No fee payers in this window yet." />}
                  columns={[
                    {
                      key: "signer",
                      label: "Account",
                      value: (row) => row.signer,
                      render: (row) => (
                        <AddressDisplay
                          ss58={row.signer}
                          fallback={<>{row.signer}</>}
                          compact
                          valueClassName="text-ink-strong hover:text-accent"
                        />
                      ),
                    },
                    {
                      key: "fees",
                      label: "Fees",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.total_fee_tao,
                      format: fmtTao,
                    },
                    {
                      key: "tips",
                      label: "Tips",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.total_tip_tao,
                      format: fmtTao,
                    },
                    {
                      key: "txs",
                      label: "Txs",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.extrinsic_count,
                      format: fmtCount,
                    },
                  ]}
                />
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
                    <h2 className="text-11 text-ink-muted">Stake-transfer leaderboard</h2>
                    <p className="mt-1 text-11 text-ink-muted">
                      {formatNumber(stakeTransfers.network.transfers)} transfers across{" "}
                      {formatNumber(stakeTransfers.network.distinct_senders)} senders network-wide
                    </p>
                  </div>
                  <span className="text-11 text-ink-muted">
                    {stakeTransfers.subnets.length} subnets
                  </span>
                </div>
                <DataTable
                  rows={stakeTransfers.subnets}
                  rowKey={(row) => String(row.netuid)}
                  caption="Stake transfers by subnet"
                  captionHidden
                  link={RouterLink}
                  source="chain-stake-transfers"
                  rowHref={(row) => `/subnets/${row.netuid}`}
                  empty={<EmptyState title="No stake transfers in this window yet." />}
                  columns={[
                    {
                      key: "netuid",
                      label: "Subnet",
                      sortable: true,
                      value: (row) => row.netuid,
                      format: (value) => `SN${String(value)}`,
                    },
                    {
                      key: "transfers",
                      label: "Transfers",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.transfers,
                      format: fmtCount,
                    },
                    {
                      key: "distinct_senders",
                      label: "Distinct senders",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.distinct_senders,
                      format: fmtCount,
                    },
                    {
                      key: "per_sender",
                      label: "Transfers per sender",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.transfers_per_sender,
                      format: fmtCount,
                    },
                  ]}
                />
              </Panel>
            </>
          )}

          {tab === "governance" && (
            <>
              <Panel className="min-w-0 lg:col-span-2">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-y-1">
                  <h2 className="text-11 text-ink-muted">Network weight-setters</h2>
                  <span className="text-11 text-ink-muted">
                    {formatNumber(weightSetters.distinct_setters)} validators
                  </span>
                </div>
                <DataTable
                  rows={weightSetters.setters}
                  rowKey={weightSetterKey}
                  caption="Network weight-setters"
                  captionHidden
                  link={RouterLink}
                  source="chain-weight-setters"
                  columns={[
                    {
                      key: "validator",
                      label: "Validator",
                      value: (row) => row.hotkey ?? weightSetterLabel(row),
                      render: (row) => (
                        <AddressDisplay
                          ss58={row.hotkey}
                          fallback={
                            <span
                              className="text-ink-muted"
                              title="Uid-only setter scoped to a subnet (no network-wide hotkey)"
                            >
                              {weightSetterLabel(row)}
                            </span>
                          }
                          compact
                          valueClassName="text-ink-strong hover:text-accent"
                        />
                      ),
                    },
                    {
                      key: "weight_sets",
                      label: "WeightsSet",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.weight_sets,
                      format: fmtCount,
                    },
                    {
                      key: "share",
                      label: "Share",
                      kind: "number",
                      sortable: true,
                      value: (row) => row.share,
                      format: (_value, row) => fmtShare(row.share),
                    },
                    {
                      key: "last_set",
                      label: "Last set",
                      kind: "time",
                      align: "right",
                      sortable: true,
                      value: (row) => row.last_set_at,
                    },
                  ]}
                  empty={<EmptyState title="No weight-setters in this window yet." />}
                />
              </Panel>
              <ValidatorTurnoverSection turnover={turnover} />
              <NetworkRegistrationsSection registrations={registrations} />
            </>
          )}
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
  // The API returns the corridors already ranked by the selected sort; carry
  // that incoming position as a field so the "#" column survives a re-sort.
  const rows = (pairs?.pairs ?? []).map((pair, index) => ({ ...pair, rank: index + 1 }));

  return (
    <Panel className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div>
          <h2 className="text-11 text-ink-muted">Transfer pairs</h2>
          {pairs ? (
            <p className="mt-1 text-11 text-ink-muted">
              {formatNumber(pairs.unique_pairs)} sender→receiver corridors ·{" "}
              {formatTao(pairs.total_volume_tao)} moved
            </p>
          ) : null}
        </div>
        <div
          className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Sort transfer pairs by"
        >
          {(["volume", "count"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === sort}
              onClick={() => setSort(s)}
              className={
                s === sort
                  ? "rounded border border-accent/40 bg-accent/10 px-3 py-1 text-11 text-accent-text"
                  : "rounded border border-border bg-card px-3 py-1 text-11 text-ink-muted hover:border-ink/30"
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        rows={rows}
        rowKey={(row) => `${row.from}-${row.to}`}
        caption="Transfer pairs"
        captionHidden
        link={RouterLink}
        source="chain-transfer-pairs"
        loading={pairsQ.isPending}
        error={
          pairsQ.error ? (
            <ErrorState
              error={pairsQ.error}
              onRetry={() => pairsQ.refetch()}
              context="transfer pairs"
            />
          ) : undefined
        }
        empty={<EmptyState title="No transfer pairs in this window yet." />}
        columns={[
          {
            key: "rank",
            label: "#",
            kind: "number",
            value: (row) => row.rank,
            format: fmtCount,
          },
          {
            key: "from",
            label: "From",
            value: (row) => row.from,
            render: (row) => (
              <AddressDisplay
                ss58={row.from}
                fallback={<>{row.from}</>}
                compact
                valueClassName="text-ink-strong hover:text-accent"
              />
            ),
          },
          {
            key: "to",
            label: "To",
            value: (row) => row.to,
            render: (row) => (
              <AddressDisplay
                ss58={row.to}
                fallback={<>{row.to}</>}
                compact
                valueClassName="text-ink-strong hover:text-accent"
              />
            ),
          },
          {
            key: "volume",
            label: "Volume",
            kind: "number",
            sortable: true,
            value: (row) => row.volume_tao,
            format: fmtTao,
          },
          {
            key: "transfers",
            label: "Transfers",
            kind: "number",
            sortable: true,
            value: (row) => row.transfer_count,
            format: fmtCount,
          },
          {
            key: "last_block",
            label: "Last block",
            kind: "link",
            align: "right",
            sortable: true,
            value: (row) => row.last_block,
            format: (value) => (typeof value === "number" ? `#${formatNumber(value)}` : "—"),
            href: (row) => (row.last_block != null ? `/blocks/${row.last_block}` : undefined),
          },
        ]}
      />
    </Panel>
  );
}
