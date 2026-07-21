import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo, useState } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChevronDown, Download, Scale, UserMinus, Zap } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { RegistryLeaderboards } from "@/components/metagraphed/registry-leaderboards";
import {
  PageHero,
  BrandIcon,
  TimeAgo,
  StatTile,
  ShareButton,
  ActionBar,
  Popover,
  PopoverTrigger,
  PopoverContent,
  buildCsvDownloadUrl,
} from "@jsonbored/ui-kit";
import {
  chainDeregistrationsQuery,
  chainWeightsQuery,
  economicsQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import type { Subnet, SubnetEconomics } from "@/lib/metagraphed/types";

const leaderboardsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

type LeaderboardWindow = z.infer<typeof leaderboardsSearchSchema>["window"];

export const Route = createFileRoute("/leaderboards")({
  validateSearch: zodValidator(leaderboardsSearchSchema),
  head: () => ({
    meta: [
      { title: "Leaderboards — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor leaderboards — registry health, RPC latency, completeness and economic-opportunity boards, plus validator weight-setting activity and neuron deregistrations ranked by subnet.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
      {
        property: "og:description",
        content:
          "Network-wide Bittensor leaderboards — registry health, RPC latency, completeness and economic-opportunity boards, plus validator weight-setting activity and neuron deregistrations ranked by subnet.",
      },
    ],
  }),
  component: LeaderboardsPage,
});

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";
const WINDOW_BTN_ACTIVE =
  "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent-text";
const WINDOW_BTN =
  "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30";

// Shaped to each board's own layout -- title, one description line, the
// 3-tile StatTile row, and a table-shaped placeholder -- so the loading
// state doesn't visibly jump in height/columns once the real content
// resolves (#6388). All three boards on this route share this exact shape,
// so one skeleton covers all three Suspense fallbacks.
function LeaderboardSkeleton() {
  return (
    <div className="space-y-4">
      <div>
        <Skeleton className="h-3 w-48 mb-2" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// The registry-leaderboards section is a card grid (two groups of boards), a
// different shape from the StatTile+table chain boards, so it gets its own
// matching skeleton rather than borrowing LeaderboardSkeleton.
function RegistryLeaderboardsSkeleton() {
  return (
    <div className="space-y-8">
      <div>
        <Skeleton className="h-3 w-24 mb-2" />
        <Skeleton className="h-7 w-72 mb-2" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-56" />
        ))}
      </div>
    </div>
  );
}

// Every chain board on this route ranks the same 7d/30d window, so the window control lives at the
// page level and governs those sections rather than each board owning a duplicate toggle. The
// registry-leaderboards section is not windowed and renders independently of it.
function LeaderboardsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Leaderboards"
        description="Registry and chain-activity boards — ranked by subnet from live registry data and chain-direct analytics."
        actions={
          <ActionBar>
            <CsvExportMenu win={win} />
            <ShareButton bare />
          </ActionBar>
        }
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Window
        </span>
        {(["7d", "30d"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => navigate({ search: { window: w } })}
            className={w === win ? WINDOW_BTN_ACTIVE : WINDOW_BTN}
          >
            {w}
          </button>
        ))}
      </div>
      <div className="space-y-12">
        <QueryErrorBoundary>
          <Suspense fallback={<RegistryLeaderboardsSkeleton />}>
            <RegistryLeaderboards />
          </Suspense>
        </QueryErrorBoundary>
        <QueryErrorBoundary>
          <Suspense fallback={<LeaderboardSkeleton />}>
            <WeightSettingLeaderboard win={win} />
          </Suspense>
        </QueryErrorBoundary>
        <QueryErrorBoundary>
          <Suspense fallback={<LeaderboardSkeleton />}>
            <DeregistrationsLeaderboard win={win} />
          </Suspense>
        </QueryErrorBoundary>
        <QueryErrorBoundary>
          <Suspense fallback={<LeaderboardSkeleton />}>
            <EmissionsLeaderboard />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter
        paths={[
          "/api/v1/registry/leaderboards",
          "/api/v1/chain/weights",
          "/api/v1/chain/deregistrations",
          "/api/v1/economics",
        ]}
      />
    </AppShell>
  );
}

// Three boards, three CSV sources (#6577). A third bare DownloadCsvButton here
// collapses to an unlabeled icon below `sm` — its own two prior PR attempts both
// did exactly that and were rejected by the maintainer ("3 repeating icons" /
// "utterly ridiculous and confusing" on mobile, since nothing distinguishes one
// download icon from another once the text label drops). One trigger opening a
// menu of the three exports keeps the action bar to a single icon at every
// viewport, mirroring HeaderActionsMenu's single-icon-opens-a-list-of-actions
// Popover idiom (apps/ui/src/components/metagraphed/header-actions-menu.tsx) —
// each export's own label stays visible inside the open menu regardless of width.
function CsvExportMenu({ win }: { win: LeaderboardWindow }) {
  const [open, setOpen] = useState(false);
  const exports = [
    {
      label: "Weight-setting CSV",
      url: buildUrl("/api/v1/chain/weights", { window: win }),
    },
    {
      label: "Deregistrations CSV",
      url: buildUrl("/api/v1/chain/deregistrations", { window: win }),
    },
    // Not window-scoped -- EmissionsLeaderboard sources from economicsQuery(),
    // which takes no window param (/api/v1/economics?window=… is a 400).
    { label: "Emissions CSV", url: buildUrl("/api/v1/economics") },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Download CSV"
          title="Download CSV"
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="size-3" aria-hidden />
          <span className="hidden sm:inline">Download CSV</span>
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5 space-y-0.5">
        {exports.map((exp) => (
          <button
            key={exp.label}
            type="button"
            onClick={() => {
              setOpen(false);
              window.location.href = buildCsvDownloadUrl(exp.url);
            }}
            className="w-full flex items-center gap-2 rounded px-2 py-2 text-left text-[12px] text-ink hover:bg-surface hover:text-ink-strong transition-colors min-h-9"
          >
            <Download className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
            <span>{exp.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// Shared subnet lookup so a board row can render the brand icon + name for its netuid. subnetsQuery
// is cached per key, so both boards mounting it is a single shared fetch, not a waterfall.
function useSubnetById(): Map<number, Subnet> {
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  return useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);
}

function WeightSettingLeaderboard({ win }: { win: LeaderboardWindow }) {
  const { data: boardRes } = useSuspenseQuery(chainWeightsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;
  const dist = board.intensity_distribution;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Weight-setting activity
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Validator consensus effort ranked by subnet — raw WeightsSet events over the selected
          window.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Scale}
          eyebrow="Weight-sets"
          value={formatNumber(network.weight_sets)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={Scale}
          eyebrow="Distinct setters"
          value={formatNumber(network.distinct_setters)}
          hint="network-wide unique validators"
        />
        <StatTile
          icon={Scale}
          eyebrow="Per setter"
          value={network.sets_per_setter != null ? network.sets_per_setter.toFixed(2) : "—"}
          hint="network intensity"
        />
      </div>

      {dist ? (
        <p className="text-xs text-ink-muted">
          Update intensity across {formatNumber(dist.count)} subnets — median{" "}
          {dist.median.toFixed(2)}, p90 {dist.p90.toFixed(2)}, max {dist.max.toFixed(2)} sets per
          validator.
        </p>
      ) : null}

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No weight-setting activity in this window"
          description="The chain poller has not indexed any WeightsSet events for this window yet, or no validators set weights."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(board.subnet_count)} subnets
              {board.observed_at ? (
                <>
                  {" "}
                  · observed <TimeAgo at={board.observed_at} />
                </>
              ) : null}
            </span>
          </div>
          {/* < md: the 5-column table clips its trailing columns behind an
              undiscoverable horizontal scroll, so narrow viewports get a
              stacked card per subnet instead — mirrors the cards/desktop-only
              split the explorer leaderboards use for the same static boards. */}
          <div className="md:hidden space-y-2 p-3">
            {board.subnets.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                      {row.sets_per_setter != null
                        ? `${row.sets_per_setter.toFixed(2)} / setter`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                    <span>{formatNumber(row.weight_sets)} weight-sets</span>
                    <span>{formatNumber(row.distinct_setters)} setters</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Rank</th>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Weight-sets</th>
                  <th className={`${TH} text-right`}>Distinct setters</th>
                  <th className={`${TH} text-right`}>Per setter</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {board.subnets.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="hover:bg-surface/40">
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
                        {formatNumber(row.weight_sets)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(row.distinct_setters)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {row.sets_per_setter != null ? row.sets_per_setter.toFixed(2) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// Top-emitters board (#6269) — subnets ranked by their share of network
// emissions, from the already-live GET /api/v1/economics snapshot. Mirrors the
// weight-setting/deregistrations board structure (summary tiles + desktop table
// + < md card fallback); emission_share is not windowed, so this board has no
// window selector.
function EmissionsLeaderboard() {
  const { data: ecoRes } = useSuspenseQuery(economicsQuery());
  const subnetById = useSubnetById();
  const ranked = useMemo(
    () =>
      ((ecoRes.data ?? []) as SubnetEconomics[])
        .filter((s) => typeof s.emission_share === "number")
        .sort((a, b) => (b.emission_share ?? 0) - (a.emission_share ?? 0)),
    [ecoRes],
  );
  const pct = (v: number | undefined) =>
    v != null && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";
  const topShare = ranked.slice(0, 10).reduce((sum, s) => sum + (s.emission_share ?? 0), 0);
  // Cap the ranked table at the top 20, matching the other boards' page size.
  const top = ranked.slice(0, 20);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Top emitters
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Subnets ranked by their share of network emissions — from the live economics snapshot.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Zap}
          eyebrow="Subnets emitting"
          value={formatNumber(ranked.length)}
          hint="with an emission share"
          tone="accent"
        />
        <StatTile
          icon={Zap}
          eyebrow="Top emitter"
          value={ranked.length > 0 ? pct(ranked[0].emission_share) : "—"}
          hint={
            ranked.length > 0
              ? (subnetById.get(ranked[0].netuid)?.name ?? `Subnet ${ranked[0].netuid}`)
              : "no data"
          }
        />
        <StatTile
          icon={Zap}
          eyebrow="Top 10 share"
          value={pct(topShare)}
          hint="combined network emissions"
        />
      </div>

      {ranked.length === 0 ? (
        <EmptyState
          title="No emission data yet"
          description="The economics snapshot has no per-subnet emission share for this network yet."
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              top {top.length} of {formatNumber(ranked.length)} subnets
            </span>
          </div>
          <div className="md:hidden space-y-2 p-3">
            {top.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? row.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-strong">
                      {pct(row.emission_share)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Rank</th>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Emission share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {top.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? row.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="hover:bg-surface/40">
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
                        {pct(row.emission_share)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function DeregistrationsLeaderboard({ win }: { win: LeaderboardWindow }) {
  const { data: boardRes } = useSuspenseQuery(chainDeregistrationsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Deregistrations
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Neuron evictions ranked by subnet — raw NeuronDeregistered events over the selected
          window.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={UserMinus}
          eyebrow="Deregistrations"
          value={formatNumber(network.deregistrations)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Distinct hotkeys"
          value={formatNumber(network.distinct_deregistered_hotkeys)}
          hint="network-wide unique"
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Per hotkey"
          value={
            network.deregistrations_per_hotkey != null
              ? network.deregistrations_per_hotkey.toFixed(2)
              : "—"
          }
          hint="network intensity"
        />
      </div>

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No deregistrations in this window"
          description="The chain poller has not indexed any NeuronDeregistered events for this window yet, or eviction activity was zero."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(board.subnet_count)} subnets
              {board.observed_at ? (
                <>
                  {" "}
                  · observed <TimeAgo at={board.observed_at} />
                </>
              ) : null}
            </span>
          </div>
          {/* < md: card fallback per subnet (see the weight-setting board). */}
          <div className="md:hidden space-y-2 p-3">
            {board.subnets.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                      {row.deregistrations_per_hotkey != null
                        ? `${row.deregistrations_per_hotkey.toFixed(2)} / hotkey`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                    <span>{formatNumber(row.deregistrations)} deregistrations</span>
                    <span>{formatNumber(row.distinct_deregistered_hotkeys)} hotkeys</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Rank</th>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Deregistrations</th>
                  <th className={`${TH} text-right`}>Distinct hotkeys</th>
                  <th className={`${TH} text-right`}>Per hotkey</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {board.subnets.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="hover:bg-surface/40">
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
                        {formatNumber(row.deregistrations)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(row.distinct_deregistered_hotkeys)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {row.deregistrations_per_hotkey != null
                          ? row.deregistrations_per_hotkey.toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
