import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { ArrowUpRight, ChevronDown, FileCode2 } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, ErrorState, Skeleton, StatUnavailable } from "@/components/metagraphed/states";
import { statPhase, type StatPhase } from "@/lib/metagraphed/stat-phase";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  AccentBand,
  BrandIcon,
  TimeAgo,
  CurationChip,
  HealthPill,
  CopyableCode,
  safeExternalUrl,
  ScrollReveal,
  Sparkline,
} from "@jsonbored/ui-kit";
import { SubnetPulseGrid } from "@/components/metagraphed/charts/subnet-pulse-grid";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import { LeaderboardsModule } from "@/components/metagraphed/leaderboards";
import { MoversBand } from "@/components/metagraphed/movers-band";
import { useRegistryEvents } from "@/hooks/use-registry-events";
import { CoverageFunnel } from "@/components/metagraphed/analytics/coverage-funnel";
import { NetworkPulseBand } from "@/components/metagraphed/analytics/network-pulse-band";
import { WhatChangedFeed } from "@/components/metagraphed/analytics/what-changed-feed";
import {
  RegistryScoreHistogram,
  DimensionCoverageHeatmap,
  EnrichmentQueueTable,
} from "@/components/metagraphed/analytics/registry-depth";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import { SubnetPriceTicker } from "@/components/metagraphed/subnet-price-ticker";
import { NetworkMoodGauge } from "@/components/metagraphed/network-mood-gauge";
import { HeroSubnetChips } from "@/components/metagraphed/hero-subnet-chips";
import { QuickActionsRow } from "@/components/metagraphed/quick-actions-row";
import { RecentIdentityChanges } from "@/components/metagraphed/recent-identity-changes";
import { ContinueExploring } from "@/components/metagraphed/continue-exploring";
import { HeroFeatureRow } from "@/components/metagraphed/hero-feature-row";
import { useHydrated } from "@/hooks/use-hydrated";

import {
  blocksQuery,
  coverageQuery,
  freshnessQuery,
  healthQuery,
  subnetsQuery,
  adapterQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Metagraphed — Bittensor registry & block explorer" },
      {
        name: "description",
        content:
          "Unofficial registry and block explorer for Bittensor — subnet APIs, schemas, docs, endpoints, providers, health, plus live blocks, extrinsics, and events.",
      },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  // #1117: live registry pulse — refresh the homepage's live data on each publish.
  useRegistryEvents();
  // #5327: the homepage stacked 15+ equal-weight sections (~14,000px tall on
  // mobile). Keep the hero + KPIs and the "what's tracked" overview always
  // visible; everything past it is the deeper registry dive, collapsed behind a
  // single "show more" disclosure so it's reachable but not forced into the
  // initial scroll. Collapsed sections don't mount, so their queries don't fire
  // until opened.
  const [showMore, setShowMore] = useState(false);
  return (
    <AppShell
      flushTop
      afterHeader={
        // Seat the alpha-price marquee flush against the secondary ecosystem
        // strip -- fills the gap that used to sit above the hero. Its bottom
        // mint hairline doubles as the hero's top rule.
        <QueryErrorBoundary fallback={() => null}>
          <Suspense fallback={null}>
            <SubnetPriceTicker />
          </Suspense>
        </QueryErrorBoundary>
      }
    >
      <HomeHero />

      {/* #6642: network-wide sentiment reading — full-width card with a real
          gradient rail, ticks, and a numeric ratio. Self-manages loading/error
          via useQuery (no Suspense needed). */}
      <QueryErrorBoundary fallback={() => null}>
        <NetworkMoodGauge />
      </QueryErrorBoundary>

      <QueryErrorBoundary fallback={() => null}>
        <Suspense fallback={null}>
          <HeroSubnetChips />
        </Suspense>
      </QueryErrorBoundary>

      <ContinueExploring />

      <section className="mt-section-gap">
        <SectionHeader
          eyebrow="What's tracked"
          title="Every public surface, in one registry."
          description="Glance counts live in the registry pulse ticker above — these are the sections to explore."
          link={{ to: "/subnets", label: "Browse the registry" }}
        />
        <TrackedGrid />
      </section>

      {!showMore && (
        <div className="mt-section-gap flex justify-center">
          <button
            type="button"
            onClick={() => setShowMore(true)}
            aria-expanded={false}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-ink-strong transition-colors hover:border-accent/60 hover:text-accent"
          >
            Show more of the registry
            <ChevronDown className="size-4" />
          </button>
        </div>
      )}
      {showMore && (
        <>
          <LivePerformance />

          {/* #1124: live registry signal band — curation funnel + network pulse +
          what-changed feed, scoped to a shared time range. Wired to real coverage/
          health/changelog/incident data. */}
          <ScrollReveal>
            <section className="mt-section-gap">
              <TimeRangeProvider>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <SectionHeader
                    inline
                    eyebrow="Signal"
                    live
                    title="Live registry signal."
                    description="Curation depth, network pulse, and the latest changes."
                  />
                  <TimeRangeScrub />
                </div>
                <QueryErrorBoundary>
                  <div className="grid gap-4 lg:grid-cols-12">
                    <Suspense fallback={<Skeleton className="h-72 lg:col-span-5" />}>
                      <div className="lg:col-span-5">
                        <CoverageFunnel />
                      </div>
                    </Suspense>
                    <Suspense fallback={<Skeleton className="h-72 lg:col-span-7" />}>
                      <div className="lg:col-span-7">
                        <NetworkPulseBand />
                      </div>
                    </Suspense>
                    <Suspense fallback={<Skeleton className="h-64 lg:col-span-12" />}>
                      <div className="lg:col-span-12">
                        <WhatChangedFeed />
                      </div>
                    </Suspense>
                  </div>
                </QueryErrorBoundary>
              </TimeRangeProvider>
            </section>
          </ScrollReveal>

          {/* #5: registry depth — completeness score distribution, surface-dimension
          coverage, and the ranked enrichment queue. Wired to /api/v1/registry/summary
          + /api/v1/coverage-depth. Each module renders inside its own error boundary
          so a single artifact gap never blanks the whole section. */}
          <ScrollReveal>
            <section className="mt-section-gap">
              <SectionHeader
                eyebrow="Registry depth"
                title="How complete is the registry?"
                description="Completeness scores, surface-dimension coverage, and the highest-priority subnets to enrich next."
              />
              <div className="grid gap-4 lg:grid-cols-12">
                <QueryErrorBoundary>
                  <Suspense fallback={<Skeleton className="h-64 lg:col-span-7" />}>
                    <div className="lg:col-span-7">
                      <RegistryScoreHistogram className="h-full" />
                    </div>
                  </Suspense>
                </QueryErrorBoundary>
                <QueryErrorBoundary>
                  <Suspense fallback={<Skeleton className="h-64 lg:col-span-5" />}>
                    <div className="lg:col-span-5">
                      <DimensionCoverageHeatmap className="h-full" />
                    </div>
                  </Suspense>
                </QueryErrorBoundary>
                <div className="lg:col-span-12">
                  <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                    Enrichment queue
                  </div>
                  <QueryErrorBoundary>
                    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                      <EnrichmentQueueTable />
                    </Suspense>
                  </QueryErrorBoundary>
                </div>
              </div>
            </section>
          </ScrollReveal>

          <LeaderboardsModule />
          <QueryErrorBoundary fallback={() => null}>
            <Suspense fallback={<Skeleton className="h-48 w-full mt-section-gap" />}>
              <MoversBand />
            </Suspense>
          </QueryErrorBoundary>

          <QuickActionsRow />

          {/* #5171: featured pilots are schema-backed (registry `partnership.tier ===
          "pilot"`), not a hardcoded slug/netuid list — adding or removing one is
          a registry data change. Renders null until the list resolves (and stays
          null if it's empty), so an empty/failed fetch never leaves a dangling
          "Pilots" heading. */}
          <QueryErrorBoundary fallback={() => null}>
            <Suspense fallback={null}>
              <PilotsSection />
            </Suspense>
          </QueryErrorBoundary>

          <section className="mt-section-gap">
            <div className="flex items-end justify-between mb-6">
              <SectionHeader inline eyebrow="Active subnets" live title="The live registry." />
              <Link
                to="/subnets"
                className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] text-ink-muted hover:text-accent transition-colors group"
              >
                View all
                <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
            </div>
            <QueryErrorBoundary>
              <Suspense fallback={<TableSkeleton />}>
                <SubnetPreviewTable />
              </Suspense>
            </QueryErrorBoundary>
          </section>

          {/* #3474: live network-wide feed of recent subnet-identity changes. */}
          <section className="mt-section-gap">
            <SectionHeader
              eyebrow="Network activity"
              title="Recent identity changes."
              description="Subnet name, symbol, and profile edits observed on-chain across the network, newest first."
            />
            <QueryErrorBoundary>
              <RecentIdentityChanges />
            </QueryErrorBoundary>
          </section>

          <section className="mt-section-gap">
            <SectionHeader
              eyebrow="For developers"
              title="Public, read-only, JSON-Schema canonical."
              description="Every list and detail view in this app is also a documented API route. Same data, same envelope."
            />
            <div className="rounded-xl border border-border bg-card p-6 max-w-2xl">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-2">
                Try it
              </div>
              <CopyableCode
                value={`curl ${API_BASE}/api/v1/subnets`}
                className="w-full text-[12px]"
                truncate={false}
              />
              <div className="mt-3 flex gap-4 text-xs">
                <Link to="/schemas" className="text-accent-text hover:underline">
                  API reference →
                </Link>
                <a
                  href={safeExternalUrl(`${API_BASE}/api/v1/openapi.json`)}
                  className="text-ink-muted hover:text-ink-strong"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenAPI spec
                </a>
              </div>
            </div>
          </section>

          <div className="mt-section-gap flex justify-center">
            <button
              type="button"
              onClick={() => setShowMore(false)}
              aria-expanded
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent/60 hover:text-accent"
            >
              Show less
              <ChevronDown className="size-4 rotate-180" />
            </button>
          </div>
        </>
      )}

      <AccentBand pattern className="mt-20">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div className="max-w-xl">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-strong/70 mb-2">
              All registry data is public
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-semibold text-ink-strong tracking-tight">
              Browse the full Bittensor registry.
            </h2>
          </div>
          <Link
            to="/subnets"
            className="inline-flex items-center gap-1.5 rounded-full bg-ink-strong px-5 py-2.5 text-sm font-medium text-paper hover:opacity-90 transition-opacity self-start md:self-auto"
          >
            Open subnets
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </AccentBand>

      <PoweredByFooter />
    </AppShell>
  );
}

/* ----------------------------- hero ----------------------------- */

// #3372: a compact chain-head tip in the hero — "head #NNNN · N ago" from the
// live /api/v1/blocks feed (limit 1), linking to that block. Plain useQuery so a
// cold/failed fetch silently renders null and never disrupts the primary hero.
function ChainHeadTip() {
  const { data } = useQuery(blocksQuery({ limit: 1 }));
  const head = data?.data?.[0];
  if (!head || head.block_number == null) return null;
  return (
    <Link
      to="/blocks/$ref"
      params={{ ref: String(head.block_number) }}
      className="mg-fade-in mg-fade-in-delay-3 mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-muted hover:text-accent transition-colors"
    >
      <span className="mg-live-dot" />
      head #{formatNumber(head.block_number)} · <TimeAgo at={head.observed_at} />
    </Link>
  );
}

function openCommandPalette() {
  if (typeof window === "undefined") return;
  // The app shell listens on window for ⌘/Ctrl+K — dispatching a real
  // KeyboardEvent triggers the same open path, no shell changes needed.
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }),
  );
}

function HomeHero() {
  const hydrated = useHydrated();
  const { data: subnetsData } = useQuery({
    ...subnetsQuery({ limit: 128 }),
    enabled: hydrated,
  });
  const subnetCount =
    hydrated && Array.isArray(subnetsData?.data)
      ? (subnetsData?.data as Subnet[]).filter((s) => s.netuid > 0).length
      : 128;

  return (
    <section className="mg-hero-slab relative overflow-hidden px-4 py-14 sm:px-6 md:py-20">
      <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center text-center">
        <h1 className="mg-fade-in mt-2 font-display text-[30px] sm:text-[40px] md:text-[48px] font-semibold leading-[1.08] text-ink-strong">
          <span className="block">Bittensor,</span>
          <span className="block text-accent">de-mystified.</span>
        </h1>
        <p className="mg-fade-in mg-fade-in-delay-1 mt-5 max-w-xl text-base md:text-lg text-ink-muted leading-relaxed">
          One search bar for every subnet, endpoint, and account — and yes, it&rsquo;s all a live
          API.
        </p>

        {/* Unified search field: query trigger on the left, mint Search button flush right. */}
        <div className="mg-fade-in mg-fade-in-delay-2 mt-8 w-full max-w-2xl">
          <div className="mg-focus-ring flex items-stretch overflow-hidden rounded-2xl border border-border bg-card transition-colors focus-within:border-accent/60 hover:border-accent/40">
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Search subnets, validators, endpoints, accounts. Opens command palette (⌘K)"
              className="flex flex-1 items-center gap-3 px-4 py-3.5 text-left text-sm text-ink-muted transition-colors hover:text-ink"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                className="size-4 shrink-0 text-ink-muted"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <span className="flex-1 truncate">
                Search subnets, validators, endpoints, accounts…
              </span>
              <kbd className="hidden sm:inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                ⌘K
              </kbd>
            </button>
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Open search"
              className="flex size-12 shrink-0 items-center justify-center border-l border-border bg-primary-soft text-accent-text transition-colors hover:bg-accent hover:text-accent-foreground sm:h-auto sm:w-auto sm:px-5"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                className="size-4 sm:hidden"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <span className="hidden text-sm font-medium sm:inline">Search</span>
            </button>
          </div>
        </div>

        <div className="mg-fade-in mg-fade-in-delay-3 mt-6 flex flex-col items-center gap-3 sm:flex-row sm:gap-4 text-[13px]">
          <Link
            to="/subnets"
            className="mg-focus-ring inline-flex items-center gap-1.5 rounded-full bg-accent px-5 py-2 font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            Explore all {subnetCount} subnets
            <ArrowUpRight className="size-3.5" />
          </Link>
          <Link
            to="/schemas"
            className="mg-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-5 py-2 font-medium text-ink-strong transition-colors hover:border-accent/60 hover:text-accent"
          >
            Read the API
          </Link>
        </div>
        <ChainHeadTip />
      </div>

      <div className="relative z-10 mx-auto mt-10 max-w-6xl px-0 sm:px-2">
        <HeroFeatureRow />
      </div>
    </section>
  );
}

/* ----------------------------- shared ----------------------------- */

function SectionHeader({
  eyebrow,
  title,
  description,
  live,
  link,
  inline,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  live?: boolean;
  link?: { to: string; label: string };
  inline?: boolean;
}) {
  if (inline) {
    return (
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted inline-flex items-center gap-2">
          {live ? <span className="mg-live-dot" /> : null}
          {eyebrow}
        </div>
        <h2 className="mt-1 font-display text-2xl md:text-3xl font-semibold tracking-tight text-ink-strong">
          {title}
        </h2>
      </div>
    );
  }
  return (
    <div className="mb-8 max-w-2xl">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted inline-flex items-center gap-2">
        {live ? <span className="mg-live-dot" /> : null}
        {eyebrow}
      </div>
      <h2 className="mt-2 font-display text-2xl md:text-3xl font-semibold tracking-tight text-ink-strong">
        {title}
      </h2>
      {description ? (
        <p className="mt-2 text-sm text-ink-muted leading-relaxed">{description}</p>
      ) : null}
      {link ? (
        <Link
          to={link.to}
          className="mt-3 inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] text-accent hover:underline group"
        >
          {link.label}
          <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </Link>
      ) : null}
    </div>
  );
}

function TrackedGrid() {
  // #5312: navigation cards only — subnet/endpoint/surface/provider counts
  // already surface in the global registry ticker; freshness/health deep-dive
  // lives in LivePerformance below.
  const items = [
    {
      label: "Subnets",
      to: "/subnets",
      desc: "Active Finney netuids with curated overlays, identity, and health.",
    },
    {
      label: "Surfaces",
      to: "/surfaces",
      desc: "Verified public APIs, schemas, docs, dashboards, and SDKs.",
    },
    {
      label: "Endpoints",
      to: "/endpoints",
      desc: "Tracked endpoint resources including root RPC pools.",
    },
    {
      label: "Providers",
      to: "/providers",
      desc: "Subnet teams and infrastructure operators behind the registry.",
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <Link
          key={item.label}
          to={item.to}
          className="mg-hover-lift group rounded-xl border border-border bg-card p-6 flex flex-col"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {item.label}
          </div>
          <p className="mt-3 text-sm text-ink-strong leading-relaxed flex-1">{item.desc}</p>
          <span className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted group-hover:text-accent transition-colors">
            Explore
            <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </span>
        </Link>
      ))}
    </div>
  );
}

function LivePerformance() {
  // #5312: canonical homepage deep-dive for freshness + health — the only place
  // on `/` these numbers appear (glance counts live in RegistryTicker).
  const freshnessResult = useQuery(freshnessQuery());
  const healthResult = useQuery(healthQuery());
  const freshness = freshnessResult.data?.data;
  const health = healthResult.data?.data;

  const ages = (freshness?.sources ?? [])
    .map((s) => (s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 1000 : null))
    .filter((v): v is number => typeof v === "number");

  const total =
    (health?.ok ?? 0) + (health?.warn ?? 0) + (health?.down ?? 0) + (health?.unknown ?? 0);
  const okPct = total > 0 ? Math.round(((health?.ok ?? 0) / total) * 100) : 0;

  return (
    <AccentBand className="mt-20">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-strong/70 inline-flex items-center gap-2">
            <span className="mg-live-dot" />
            Live performance
          </div>
          <h2 className="mt-2 font-display text-2xl md:text-3xl font-semibold tracking-tight text-ink-strong">
            Probed every 30 seconds.
          </h2>
        </div>
        <Link
          to="/health"
          className="text-xs font-mono uppercase tracking-[0.18em] text-ink-strong/70 hover:text-ink-strong"
        >
          View health →
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <PerfCard
          label="Source freshness"
          value={
            freshness?.avg_age_seconds != null ? humaniseSeconds(freshness.avg_age_seconds) : "—"
          }
          hint="avg poll lag"
          phase={statPhase(freshnessResult)}
          series={ages.length ? ages : undefined}
        />
        <PerfCard
          label="Global health"
          value={`${okPct}%`}
          hint={`${health?.ok ?? 0}/${total} OK`}
          phase={statPhase(healthResult)}
          accent
        />
      </div>
    </AccentBand>
  );
}

function PerfCard({
  label,
  value,
  hint,
  phase = "ready",
  series,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  /** Loading/error/ready phase of the card's source query (#3964). */
  phase?: StatPhase;
  /** Real data series. When absent, no sparkline is rendered (no fabrication). */
  series?: number[];
  accent?: boolean;
}) {
  const hasSeries = phase === "ready" && !!series && series.length > 1;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {label}
        </div>
        <div className="font-mono text-[10px] text-ink-muted">{hint}</div>
      </div>
      <div
        className={`font-display text-3xl md:text-4xl font-semibold leading-none tabular-nums ${accent ? "text-accent" : "text-ink-strong"}`}
      >
        {phase === "pending" ? (
          <Skeleton className="h-9 w-24" />
        ) : phase === "error" ? (
          <StatUnavailable iconClassName="size-4" />
        ) : (
          value
        )}
      </div>
      {hasSeries ? (
        <div className="mt-4">
          <Sparkline
            values={series}
            width={520}
            height={56}
            color={accent ? "var(--accent)" : "var(--ink-strong)"}
            ariaLabel={label}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------- pilot ----------------------------- */

/**
 * Data-driven "Pilots" homepage section (#5171): the featured list comes from
 * the registry (`partnership.tier === "pilot"`) instead of a hardcoded
 * slug/netuid list, so adding or removing a pilot is a registry data change,
 * not a source edit. `limit: 200` covers the full registry (well above the
 * known subnet count) since a pilot can sit anywhere in netuid order; each
 * card still owns its own QueryErrorBoundary/Suspense pair (unchanged from
 * before) so one pilot's adapter failing never takes down the others. Renders
 * null when the filtered list is empty so the section never leaves a dangling
 * heading over an empty grid.
 */
function PilotsSection() {
  const { data } = useSuspenseQuery(subnetsQuery({ limit: 200 }));
  const subnets = (data.data ?? []) as Subnet[];
  const pilots = subnets
    .filter((subnet) => subnet.partnership?.tier === "pilot")
    .sort((a, b) => {
      const bySince = (a.partnership?.since ?? "").localeCompare(b.partnership?.since ?? "");
      return bySince !== 0 ? bySince : a.netuid - b.netuid;
    });

  if (pilots.length === 0) return null;

  return (
    <section className="mt-section-gap">
      <SectionHeader
        eyebrow="Pilots"
        title="Adapter-backed subnets"
        description="Subnets with live machine-verified data pulled directly through a maintained adapter."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {pilots.map((subnet) => {
          const title = subnet.name ?? `Subnet ${subnet.netuid}`;
          const subtitle = `SN${subnet.netuid}`;
          const slug = subnet.slug ?? `sn-${subnet.netuid}`;
          return (
            <QueryErrorBoundary
              key={subnet.netuid}
              fallback={() => (
                <PilotCardFallback netuid={subnet.netuid} title={title} subtitle={subtitle} />
              )}
            >
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <PilotCard slug={slug} netuid={subnet.netuid} title={title} subtitle={subtitle} />
              </Suspense>
            </QueryErrorBoundary>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Error fallback for PilotCard, rendered by the QueryErrorBoundary in
 * PilotsSection when the adapter snapshot fails to load. Kept separate so
 * PilotCard can call useSuspenseQuery unconditionally (a try/catch around the
 * hook breaks the Rules of Hooks).
 */
function PilotCardFallback({
  netuid,
  title,
  subtitle,
}: {
  netuid: number;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid }}
      className="mg-hover-lift block rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {subtitle}
          </div>
          <div className="mt-1 font-display text-lg font-semibold text-ink-strong">{title}</div>
        </div>
        <CurationChip level="adapter-backed" />
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        Pilot adapter — open the subnet page for surfaces, endpoints, and evidence.
      </p>
    </Link>
  );
}

function PilotCard({
  slug,
  netuid,
  title,
  subtitle,
}: {
  slug: string;
  netuid: number;
  title: string;
  subtitle: string;
}) {
  // useSuspenseQuery must run unconditionally — a try/catch around it breaks the
  // Rules of Hooks. Load errors are caught by the QueryErrorBoundary wrapper in
  // OverviewPage, which renders PilotCardFallback.
  const snapshot = useSuspenseQuery(adapterQuery(slug)).data;
  const generated = snapshot.meta?.generated_at;
  const metrics = (snapshot.data?.metrics ?? {}) as Record<string, unknown>;
  const metricEntries = Object.entries(metrics).slice(0, 4);

  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid }}
      className="mg-hover-lift block rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {subtitle}
          </div>
          <div className="mt-1 font-display text-lg font-semibold text-ink-strong">{title}</div>
        </div>
        <CurationChip level="adapter-backed" />
      </div>
      {metricEntries.length > 0 ? (
        <dl className="grid grid-cols-2 gap-2">
          {metricEntries.map(([k, v]) => (
            <div key={k} className="rounded-md border border-border bg-surface/40 px-3 py-2">
              <dt className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted truncate">
                {k}
              </dt>
              <dd className="font-mono text-[12px] text-ink-strong truncate">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-ink-muted">Adapter connected. Open subnet for detail.</p>
      )}
      {generated ? (
        <div className="mt-3 font-mono text-[10px] text-ink-muted">
          updated <TimeAgo at={generated} />
        </div>
      ) : null}
    </Link>
  );
}

function TableSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="border-b border-border last:border-b-0 px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

function SubnetPreviewTable() {
  const { data, refetch } = useSuspenseQuery(subnetsQuery({ limit: 12 }));
  // Best-effort overlays: the subnet list is the hard dependency for this table,
  // but health and coverage failures should degrade to Unknown/dash values rather
  // than replace the entire table via the surrounding QueryErrorBoundary.
  const { data: healthRes } = useQuery({ ...healthQuery(), retry: 0 });
  const coverage = useQuery({ ...coverageQuery(), retry: 0 }).data?.data;
  const subnets = (data.data ?? []) as Subnet[];
  const healthBySubnet = new Map<number, "ok" | "warn" | "down" | "unknown">();
  const hsubs = (
    healthRes?.data as { subnets?: Array<{ netuid: number; status?: string }> } | undefined
  )?.subnets;
  if (Array.isArray(hsubs)) {
    for (const s of hsubs) {
      const st = s.status;
      const mapped: "ok" | "warn" | "down" | "unknown" =
        st === "ok" ? "ok" : st === "degraded" ? "warn" : st === "failed" ? "down" : "unknown";
      healthBySubnet.set(s.netuid, mapped);
    }
  }

  if (!Array.isArray(subnets) || subnets.length === 0) {
    return (
      <EmptyState
        title="No subnets returned"
        description="The API responded but returned an empty list."
      />
    );
  }

  const total = coverage?.netuids_active ?? coverage?.netuids_total;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/40 text-[10px] font-mono uppercase tracking-[0.18em] text-ink-muted">
            <tr>
              <th className="px-4 py-3 font-medium">UID</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium text-right">Participants</th>
              <th className="px-4 py-3 font-medium">Curation</th>
              <th className="px-4 py-3 font-medium text-right">Surfaces</th>
              <th className="px-4 py-3 font-medium">Health</th>
              <th className="px-4 py-3 font-medium text-right">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {subnets.slice(0, 12).map((s) => (
              <tr key={s.netuid} className="mg-row-hover">
                <td className="px-4 py-3 font-mono text-[12px] text-ink-muted">
                  <EntityHoverCard kind="subnet" netuid={s.netuid}>
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="hover:text-accent transition-colors"
                    >
                      {String(s.netuid).padStart(3, "0")}
                    </Link>
                  </EntityHoverCard>
                </td>
                <td className="px-4 py-3">
                  <EntityHoverCard kind="subnet" netuid={s.netuid}>
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="inline-flex items-center gap-2 font-medium text-ink-strong hover:text-accent transition-colors"
                    >
                      <BrandIcon
                        size={20}
                        name={s.name ?? `Subnet ${s.netuid}`}
                        fallback={s.netuid}
                        url={s.website}
                        netuid={s.netuid}
                      />
                      <span className="truncate">{s.name ?? `Subnet ${s.netuid}`}</span>
                    </Link>
                  </EntityHoverCard>
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-ink-muted">
                  {s.symbol ?? "—"}
                </td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-ink">
                  {formatNumber(s.participants)}
                </td>
                <td className="px-4 py-3">
                  <CurationChip level={s.curation_level} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-[12px]">
                  {s.surfaces_count ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <HealthPill state={healthBySubnet.get(s.netuid) ?? s.health ?? "unknown"} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={s.updated_at ?? s.freshness} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border bg-surface/30 px-4 py-2.5 flex justify-between text-[11px] font-mono text-ink-muted">
        <span>
          Showing {Math.min(12, subnets.length)}
          {total ? ` of ${formatNumber(total)}` : ""} ·{" "}
          <Link to="/subnets" className="hover:text-accent underline underline-offset-2">
            view all
          </Link>
        </span>
        <button onClick={() => refetch()} className="hover:text-accent transition-colors">
          refresh
        </button>
      </div>
    </div>
  );
}

function PoweredByFooter() {
  return (
    <div className="mt-12 border-t border-border pt-6 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-ink-muted">
      <span className="inline-flex items-center gap-2">
        <FileCode2 className="size-3" />
        Powered by Cloudflare Workers · Static Assets · R2
      </span>
      <span>JSON-Schema canonical · OpenAPI projected</span>
    </div>
  );
}

export function ErrorBoundaryFallback({ error }: { error: unknown }) {
  return <ErrorState error={error} />;
}
