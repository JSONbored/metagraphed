import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { ArrowUpRight, FileCode2 } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  AccentBand,
  BrandIcon,
  TimeAgo,
  CurationChip,
  HealthPill,
  AnimatedNumber,
  CopyableCode,
  InfoTooltip,
  safeExternalUrl,
  ScrollReveal,
} from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton, StatUnavailable } from "@/components/metagraphed/states";
import { statPhase, type StatPhase } from "@/lib/metagraphed/stat-phase";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { Sparkline, type SparklinePoint } from "@/components/metagraphed/charts/sparkline";
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
import { HeroSubnetChips } from "@/components/metagraphed/hero-subnet-chips";
import { QuickActionsRow } from "@/components/metagraphed/quick-actions-row";
import { RecentIdentityChanges } from "@/components/metagraphed/recent-identity-changes";
import { ContinueExploring } from "@/components/metagraphed/continue-exploring";

import {
  blocksQuery,
  chainActivityQuery,
  coverageQuery,
  freshnessQuery,
  healthQuery,
  subnetsQuery,
  adapterQuery,
  endpointsQuery,
  providersQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Metagraphed — Bittensor public-interface registry" },
      {
        name: "description",
        content:
          "Unofficial registry and explorer for Bittensor subnet APIs, schemas, docs, endpoints, providers, and health.",
      },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  // #1117: live registry pulse — refresh the homepage's live data on each publish.
  useRegistryEvents();
  return (
    <AppShell>
      <HomeHero />

      {/* #1124/#1302: hero discovery rail — alpha-price ticker, trending subnet
          chips, and a "continue exploring" rail. Each renders null until it has
          data, so they never clutter a cold first paint. */}
      <QueryErrorBoundary fallback={() => null}>
        <Suspense fallback={null}>
          <SubnetPriceTicker />
        </Suspense>
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
          link={{ to: "/subnets", label: "Browse the registry" }}
        />
        <TrackedGrid />
      </section>

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

      <section className="mt-section-gap">
        <SectionHeader
          eyebrow="Pilots"
          title="Adapter-backed subnets"
          description="Subnets with live machine-verified data pulled directly through a maintained adapter."
        />
        <div className="grid gap-4 md:grid-cols-2">
          <QueryErrorBoundary
            fallback={() => <PilotCardFallback netuid={7} title="Allways" subtitle="SN7" />}
          >
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <PilotCard slug="allways" netuid={7} title="Allways" subtitle="SN7" />
            </Suspense>
          </QueryErrorBoundary>
          <QueryErrorBoundary
            fallback={() => <PilotCardFallback netuid={74} title="Gittensor" subtitle="SN74" />}
          >
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <PilotCard slug="gittensor" netuid={74} title="Gittensor" subtitle="SN74" />
            </Suspense>
          </QueryErrorBoundary>
        </div>
      </section>

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

function HomeHero() {
  return (
    <section className="mg-hero-slab relative overflow-hidden px-6 py-12 md:px-12 md:py-20">
      <div className="relative z-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-center">
        <div className="min-w-0 max-w-2xl">
          <div className="mg-fade-in font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted inline-flex items-center gap-2">
            <span className="mg-live-dot" />
            Registry · Live · Read-only
          </div>
          <h1 className="mg-fade-in mg-fade-in-delay-1 mt-4 font-display text-4xl sm:text-5xl md:text-6xl font-semibold leading-[1.02] tracking-tight text-ink-strong">
            The public-interface registry for <span className="text-accent">Bittensor</span>.
          </h1>
          <p className="mg-fade-in mg-fade-in-delay-2 mt-5 max-w-xl text-base text-ink-muted leading-relaxed">
            A builder-facing index of subnet APIs, schemas, docs, endpoints, providers, freshness,
            and registry gaps. Not a block explorer.
          </p>
          <div className="mg-fade-in mg-fade-in-delay-3 mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/subnets"
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90 transition-opacity"
            >
              Browse subnets
              <ArrowUpRight className="size-3.5" />
            </Link>
            <Link
              to="/schemas"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/50 px-5 py-2.5 text-sm font-medium text-ink hover:border-accent/40 transition-colors"
            >
              Read the API
            </Link>
          </div>
          <ChainHeadTip />
        </div>
        <div className="mg-fade-in mg-fade-in-delay-2 shrink-0">
          <HeroKpis />
        </div>
      </div>
    </section>
  );
}

function HeroKpis() {
  // #3964: track each source query's phase so a cell shows a skeleton (loading)
  // or a distinct "Unavailable" glyph (error) instead of collapsing loading /
  // error / genuinely-null all into "—". Shared statPhase()/StatUnavailable
  // keep this identical to the About "At a glance" sidebar.
  const coverageResult = useQuery(coverageQuery());
  const freshnessResult = useQuery(freshnessQuery());
  const healthResult = useQuery(healthQuery());
  const coverage = coverageResult.data?.data;
  const freshness = freshnessResult.data?.data;
  const health = healthResult.data?.data;
  const active = coverage?.netuids_active;
  const avgAge = freshness?.avg_age_seconds;
  const uptime = health?.uptime_24h;

  const ages = (freshness?.sources ?? [])
    .map((s) => (s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 1000 : null))
    .filter((v): v is number => typeof v === "number");
  // Real per-source freshness ages (newest first). No fabricated fallback —
  // the sparkline simply hides when there's no series.
  const freshSeries = ages.length ? ages.slice(0, 24).reverse() : undefined;

  // No per-hour uptime series is exposed by /api/v1/health, so the uptime cell
  // shows the honest number with no invented trend line.
  const freshPoints = freshSeries ? buildHourlyPoints(freshSeries) : undefined;

  // #3383: chain-direct activity, distinct from the registry/freshness metadata
  // above — useQuery (not suspense), so a slow/failed fetch degrades this one
  // cell instead of blocking the whole hero card. No fabricated fallback: the
  // sparkline hides via HeroStatCell's own hasSeries guard when there's no data.
  const activityResult = useQuery(chainActivityQuery("7d"));
  const activity = activityResult.data?.data;
  const activityChrono = activity?.days.length ? [...activity.days].reverse() : undefined;
  const latestExtrinsics = activityChrono?.at(-1)?.extrinsic_count;
  const activitySeries = activityChrono?.map((d) => d.extrinsic_count);
  const activityPoints = activityChrono?.map((d) => ({ t: d.day, v: d.extrinsic_count }));

  return (
    <div className="mx-auto w-full max-w-[560px] rounded-xl border border-border bg-card/80 overflow-hidden lg:mx-0 lg:max-w-none">
      {/* Caption strip */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-surface/40">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted inline-flex items-center gap-2">
          <span className="mg-live-dot" />
          Registry pulse
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          live · 30s
        </div>
      </div>

      {/* Subnet pulse grid */}
      <div className="px-4 py-3.5 border-b border-border">
        <div className="flex items-baseline justify-between mb-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Active subnets
          </span>
          <span className="font-display text-sm font-semibold text-ink-strong mg-num">
            <AnimatedNumber value={active ?? null} />
          </span>
        </div>
        <SubnetPulseGrid columns={16} />
        <div className="mt-2.5 flex items-center gap-3 text-[10px] font-mono text-ink-muted">
          <LegendDot tone="bg-health-ok" label="ok" />
          <LegendDot tone="bg-health-warn" label="warn" />
          <LegendDot tone="bg-health-down" label="down" />
          <LegendDot tone="bg-ink-subtle/60" label="unknown" />
        </div>
      </div>

      {/* Three stat cells. Uptime has no exposed per-hour series, so it shows the
          number alone; freshness charts the real per-source ages when present;
          chain activity is the only one sourced chain-direct rather than from
          registry/probe metadata. */}
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <HeroStatCell
          label="Healthy now"
          value={uptime != null ? `${(uptime * 100).toFixed(1)}%` : "—"}
          phase={statPhase(healthResult)}
          formatValue={(v) => `${v.toFixed(1)}%`}
          tooltip="Share of verified endpoints passing their most recent probe. Failures are non-2xx, timeouts, or schema-invalid responses. Source: /api/v1/health."
          accent
        />
        <HeroStatCell
          label="Freshness"
          value={avgAge != null ? humaniseSeconds(avgAge) : "—"}
          phase={statPhase(freshnessResult)}
          series={freshSeries}
          points={freshPoints}
          formatValue={(v) => humaniseSeconds(v)}
          tooltip="Median age of the most recent successful probe per registered source over the last 24 hours. Lower is better. Source: /api/v1/freshness."
        />
        <HeroStatCell
          label="Chain activity"
          value={latestExtrinsics != null ? formatNumber(latestExtrinsics) : "—"}
          phase={statPhase(activityResult)}
          series={activitySeries}
          points={activityPoints}
          formatValue={(v) => formatNumber(v)}
          seriesCaption="7d · daily"
          tooltip="Extrinsics in the latest indexed day, chain-direct (not registry-derived). Source: /api/v1/chain/activity."
        />
      </div>

      {/* Pilot chips */}
      <div className="flex items-center gap-2 px-4 py-2.5 text-[11px] font-mono text-ink-muted">
        <span className="uppercase tracking-[0.18em] text-[10px]">Pilots</span>
        <span aria-hidden>▸</span>
        <Link
          to="/subnets/$netuid"
          params={{ netuid: 7 }}
          className="rounded-full border border-border bg-paper px-2 py-0.5 hover:text-accent hover:border-accent/40 transition-colors"
        >
          Allways · SN7
        </Link>
        <Link
          to="/subnets/$netuid"
          params={{ netuid: 74 }}
          className="rounded-full border border-border bg-paper px-2 py-0.5 hover:text-accent hover:border-accent/40 transition-colors"
        >
          Gittensor · SN74
        </Link>
      </div>
    </div>
  );
}

function buildHourlyPoints(series: number[]): SparklinePoint[] {
  const now = Date.now();
  const stepMs = 60 * 60 * 1000;
  return series.map((v, i) => {
    const d = new Date(now - (series.length - 1 - i) * stepMs);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return { t: `${hh}:${mm} UTC`, v };
  });
}

function LegendDot({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`size-1.5 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

function HeroStatCell({
  label,
  value,
  phase = "ready",
  series,
  points,
  formatValue,
  tooltip,
  accent,
  seriesCaption = "24h · hourly",
}: {
  label: string;
  value: string;
  /** Loading/error/ready phase of the cell's source query (#3964). */
  phase?: StatPhase;
  /** Real data series. When absent, no sparkline is rendered (no fabrication). */
  series?: number[];
  points?: SparklinePoint[];
  formatValue?: (v: number) => string;
  tooltip?: string;
  accent?: boolean;
  /** Cadence label under the sparkline; defaults to the freshness cell's 24h/hourly cadence. */
  seriesCaption?: string;
}) {
  // Hide the sparkline unless the value settled successfully — a skeleton or
  // error glyph replaces the number, so a stale series would misrepresent state.
  const hasSeries = phase === "ready" && !!series && series.length > 1;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        <span>{label}</span>
        {tooltip ? <InfoTooltip label={tooltip} /> : null}
      </div>
      <div
        className={`mt-1 font-display text-xl font-semibold leading-none tabular-nums ${
          accent ? "text-accent" : "text-ink-strong"
        }`}
      >
        {phase === "pending" ? (
          <Skeleton className="h-5 w-14" />
        ) : phase === "error" ? (
          <StatUnavailable />
        ) : (
          value
        )}
      </div>
      {hasSeries ? (
        <>
          <div className="mt-2">
            <Sparkline
              values={series}
              points={points}
              formatValue={formatValue}
              width={150}
              height={20}
              color={accent ? "var(--accent)" : "var(--ink-strong)"}
              ariaLabel={label}
            />
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-[0.18em] text-ink-muted">
            <span
              aria-hidden
              className="inline-block h-px w-3"
              style={{ background: accent ? "var(--accent)" : "var(--ink-strong)" }}
            />
            <span>{seriesCaption}</span>
          </div>
        </>
      ) : null}
    </div>
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
  const coverageResult = useQuery(coverageQuery());
  const coverage = coverageResult.data?.data as Record<string, number | undefined> | undefined;
  // Endpoint/provider totals are not in /api/v1/coverage — read from their own
  // list endpoints. Use limit=1 for endpoints (1197 items) to get only the
  // pagination meta; providers are small enough to load in full (cached for /providers).
  const endpointsResult = useQuery({ ...endpointsQuery({ limit: 1 }), retry: 0 });
  const providersResult = useQuery({ ...providersQuery(), retry: 0 });
  const endpointsTotal =
    endpointsResult.data?.meta.pagination?.total ??
    endpointsResult.data?.meta.total ??
    endpointsResult.data?.data.length;
  const providersTotal =
    providersResult.data?.meta.pagination?.total ??
    providersResult.data?.meta.total ??
    providersResult.data?.data.length;

  const items: Array<{
    label: string;
    to: string;
    value: number | undefined;
    desc: string;
    phase: StatPhase;
  }> = [
    {
      label: "Subnets",
      to: "/subnets",
      value: coverage?.netuids_active,
      desc: "Active Finney netuids with curated overlays.",
      phase: statPhase(coverageResult),
    },
    {
      label: "Surfaces",
      to: "/surfaces",
      value: coverage?.surfaces_total,
      desc: "Verified public APIs, schemas, docs, dashboards.",
      phase: statPhase(coverageResult),
    },
    {
      label: "Endpoints",
      to: "/endpoints",
      value: endpointsTotal,
      desc: "Tracked endpoint resources including root RPC pools.",
      phase: statPhase(endpointsResult),
    },
    {
      label: "Providers",
      to: "/providers",
      value: providersTotal,
      desc: "Subnet teams and infrastructure operators.",
      phase: statPhase(providersResult),
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
          <div className="mt-3 font-display text-3xl md:text-4xl font-semibold leading-none tabular-nums text-ink-strong">
            {item.phase === "pending" ? (
              <Skeleton className="h-8 w-20" />
            ) : item.phase === "error" ? (
              <StatUnavailable iconClassName="size-4" />
            ) : item.value != null ? (
              formatNumber(item.value)
            ) : (
              "—"
            )}
          </div>
          <p className="mt-3 text-xs text-ink-muted leading-relaxed flex-1">{item.desc}</p>
          <span className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted group-hover:text-accent transition-colors">
            View
            <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </span>
        </Link>
      ))}
    </div>
  );
}

function LivePerformance() {
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
 * Error fallback for PilotCard, rendered by the QueryErrorBoundary in
 * OverviewPage when the adapter snapshot fails to load. Kept separate so
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
