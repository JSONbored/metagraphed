import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Calculator,
  Minus,
  TrendingDown,
  TrendingUp,
  Waves,
  Activity,
  ChevronDown,
  Filter,
  Layers,
  Coins,
  UserMinus,
} from "lucide-react";
import {
  AsyncPanel,
  CopyLinkButton,
  MobileCollapse,
  Panel,
  ResponsiveTable,
} from "@/components/metagraphed/primitives";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, Skeleton, RECOVERY } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { WatchStarButton } from "@/components/metagraphed/watch-star-button";
import { WatchEntitySheet } from "@/components/metagraphed/watch-entity-sheet";
import { SurfacePlayground } from "@/components/metagraphed/surface-playground";
import { UptimeBadgeEmbed } from "@/components/metagraphed/uptime-badge-embed";
import {
  CandidateChip,
  CurationChip,
  ExternalLink,
  TimeAgo,
  LiveTickerProvider,
  SectionAnchor,
  TableState,
  HealthPill,
  CopyableCode,
  MethodologyCallout,
  BackToTop,
  StatTile,
  RealtimeFreshness,
  Sparkline,
} from "@jsonbored/ui-kit";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { ReadinessScorecard } from "@/components/metagraphed/readiness-scorecard";
import { DevActivityPanel } from "@/components/metagraphed/dev-activity-panel";
import { SearchInput } from "@/components/metagraphed/table-controls";
import { ReliabilityPanel } from "@/components/metagraphed/reliability-panel";
import { EconomicsPanel } from "@/components/metagraphed/economics-panel";
import { EndpointSnippet, apiSnippet } from "@/components/metagraphed/endpoint-snippet";
import { SubnetHistoryChart } from "@/components/metagraphed/subnet-history-chart";
import { SubnetOhlcChart } from "@/components/metagraphed/subnet-ohlc-chart";
import { SubnetConvictionLeaderboard } from "@/components/metagraphed/subnet-conviction-leaderboard";
import { SubnetOwnershipHistory } from "@/components/metagraphed/subnet-ownership-history";
import { SubnetLeasePanel } from "@/components/metagraphed/subnet-lease-panel";
import { MetagraphTableLoader } from "@/components/metagraphed/metagraph-panel";
import { ValidatorsTableLoader } from "@/components/metagraphed/validators-panel";
import { DistributionPanel } from "@/components/metagraphed/concentration-panel";
import { YieldLoader } from "@/components/metagraphed/yield-panel";
import { TurnoverLoader } from "@/components/metagraphed/turnover-panel";
import { NeuronDetailCard } from "@/components/metagraphed/neuron-detail-card";
import { NeuronHistoryChart } from "@/components/metagraphed/neuron-history-chart";
import { useHashScroll } from "@/components/metagraphed/use-hash-scroll";
import { StreamStatusChip } from "@/components/metagraphed/stream-status-chip";
import { accountEventMatchesNetuid, useChainStream } from "@/hooks/use-chain-stream";
import {
  subnetProfileQuery,
  subnetSurfacesQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetCandidatesQuery,
  subnetEventsQuery,
  subnetGapsQuery,
  subnetOverviewQuery,
  subnetUptimeQuery,
  lineageQuery,
  agentCatalogDetailQuery,
  subnetWeightSettersQuery,
  subnetWeightsQuery,
  subnetIdentityHistoryQuery,
  subnetStakeFlowQuery,
  subnetHyperparametersQuery,
  subnetHyperparamsHistoryQuery,
  subnetAlphaVolumeQuery,
  subnetStakeQuoteQuery,
  subnetEventSummaryQuery,
  subnetAxonRemovalsQuery,
} from "@/lib/metagraphed/queries";
import { isStaleFreshness, formatNumber, classNames } from "@/lib/metagraphed/format";
import { rovingTabIndex, useRovingTablist } from "@jsonbored/ui-kit";
import {
  eventKindCategory,
  eventKindCategoryLabel,
  eventKindLabel,
  EVENT_KIND_LABELS,
  type EventKindCategory,
} from "@/lib/metagraphed/event-kinds";
import {
  aggregateActivityEvents,
  activityGroupSpanMinutes,
  type ActivityGroup,
} from "@/lib/metagraphed/activity-aggregation";
import type {
  AccountEvent,
  Candidate,
  SubnetProfile,
  AgentCatalogService,
  AgentCatalogBlocker,
  SubnetHyperparameters,
} from "@/lib/metagraphed/types";
import { IncidentTimeline } from "@/components/metagraphed/incident-timeline";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { SubnetMasthead } from "@/components/metagraphed/subnet-masthead";
import { OperationalPanel } from "@/components/metagraphed/operational-panel";
import { ResourceExplorer } from "@/components/metagraphed/resource-explorer";
import { GittensorRegisteredRepos } from "@/components/metagraphed/gittensor-registered-repos";
import { SubnetProfilePanel } from "@/components/metagraphed/subnet-profile-panel";
import { SubnetPriorityHighlights } from "@/components/metagraphed/subnet-priority-highlights";
import { ActivityHeatmap } from "@/components/metagraphed/charts/activity-heatmap";
import { SubnetValidatorsPreview } from "@/components/metagraphed/subnet-validators-preview";
import { SubnetFilterProvider } from "@/components/metagraphed/subnet-filter-context";
import { SubnetCompareDrawer } from "@/components/metagraphed/subnet-compare-drawer";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { WatchSubnetAlert } from "@/components/metagraphed/watch-subnet-alert";
import { SubnetWindowProvider, SubnetWindowToggle } from "@/lib/metagraphed/subnet-window";
import type { SearchParams } from "./subnets.$netuid";

// #8247: 14 tabs -> 7. "Validators" folds into Metagraph (both are neuron-set
// views over the same live snapshot); Identity history/Hyperparameters/
// Surfaces/Endpoints/Schemas/Candidates/Gaps/Evidence/API redistribute into
// the tab that actually answers the question a visitor has ("is it up + how
// do I call it" -> API & Endpoints; "who governs/owns it" -> Governance &
// Ownership; everything else reference-shaped -> About).
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "api", label: "API & Endpoints" },
  { id: "metagraph", label: "Metagraph" },
  { id: "economics", label: "Economics" },
  { id: "activity", label: "Activity" },
  { id: "governance", label: "Governance & Ownership" },
  { id: "about", label: "About" },
] as const;

// Which tab does each section anchor live under? Drives cross-tab deep links.
const SECTION_TO_TAB: Record<string, string> = {
  "endpoints-glance": "overview",
  "start-integrating": "overview",
  "uptime-90d": "overview",
  "recent-activity": "overview",
  incidents: "overview",
  economics: "economics",
  "volume-24h": "economics",
  ohlc: "economics",
  "stake-quote": "economics",
  metagraph: "metagraph",
  neuron: "metagraph",
  concentration: "metagraph",
  yield: "metagraph",
  turnover: "metagraph",
  validators: "metagraph",
  history: "metagraph",
  activity: "activity",
  "health-trends": "api",
  reliability: "api",
  operational: "api",
  resources: "api",
  services: "api",
  "agent-readiness": "api",
  candidates: "api",
  api: "api",
  identity: "about",
  hyperparameters: "governance",
  "hyperparameters-history": "governance",
  conviction: "governance",
  "ownership-history": "governance",
  lease: "governance",
  profile: "about",
  lineage: "about",
  gaps: "about",
  // #6434: the Overview embed is a preview and owns `evidence-preview`; the
  // bare `evidence` id belongs to the About tab's full EvidencePanel, like
  // every other tab-owning section. Mirrors the preview-vs-full id split in
  // providers.$slug.tsx (`subnets-served-preview` vs `subnets-served`).
  "evidence-preview": "overview",
  evidence: "about",
};

export function SubnetDetailPage() {
  const { netuid } = useParams({ from: "/subnets/$netuid" });
  return (
    <AppShell flushTop crumbLabel={String(netuid).padStart(3, "0")}>
      <AsyncPanel
        context="subnet profile"
        fallback={<DetailSkeleton />}
        retryQueryKeys={[subnetProfileQuery(netuid).queryKey]}
      >
        <ProfileShell netuid={netuid} />
      </AsyncPanel>
      <BackToTop />
    </AppShell>
  );
}

function ProfileShell({ netuid }: { netuid: number }) {
  // #8225: non-suspending on purpose. The route loader already primed this
  // same query key via ensureQueryData (subnets.$netuid.tsx), so this never
  // introduces an extra fetch or a loading flash -- it only changes how a
  // FAILURE behaves. `/profile` isn't published for every network (e.g.
  // testnet), and every consumer of `profile` below already tolerates it
  // being undefined (SubnetMasthead falls back to "Subnet {netuid}",
  // ReadinessScorecard renders null, tab badge counts go blank). Using
  // useSuspenseQuery here used to throw that one failure up to the page's
  // root AsyncPanel and blank out the ENTIRE page -- masthead, tabs, and
  // every other independently-fetched section -- even though only the
  // profile-specific "Subnet profile" section (SubnetProfilePanel, which
  // re-reads this same query in its own AsyncPanel) actually needs it.
  const { data: profileResult } = useQuery(subnetProfileQuery(netuid));
  const profile = profileResult?.data;
  const meta = profileResult?.meta;
  const { data: gapsResult } = useQuery(subnetGapsQuery(netuid));
  const subnetGaps = gapsResult?.data;
  const stale = meta?.stale || isStaleFreshness(meta?.generated_at);
  const tab = useActiveTab("overview");
  useHashScroll(tab, SECTION_TO_TAB);

  const gapsCount = subnetGaps?.missing_kinds.length ?? profile?.missing_kinds?.length ?? 0;
  const tabsWithCounts = TABS.map((t) => {
    if (t.id === "api") return { ...t, count: profile?.endpoint_count };
    if (t.id === "about") return { ...t, count: gapsCount || undefined };
    return { ...t };
  });

  const evidenceCount = [
    profile?.website ?? profile?.homepage,
    profile?.docs,
    profile?.repo,
    profile?.dashboard,
  ].filter(Boolean).length;

  return (
    <TimeRangeProvider>
      <SubnetWindowProvider>
        <SubnetFilterProvider>
          <SubnetMasthead
            netuid={netuid}
            profile={profile}
            generatedAt={meta?.generated_at}
            stale={stale}
            evidenceCount={evidenceCount}
            refreshQueryKeys={[
              subnetProfileQuery(netuid).queryKey,
              subnetSurfacesQuery(netuid).queryKey,
              subnetEndpointsQuery(netuid).queryKey,
              subnetHealthQuery(netuid).queryKey,
              subnetCandidatesQuery(netuid).queryKey,
            ]}
            refreshLabel="Refresh health now"
          />

          <SubnetValidatorsPreview netuid={netuid} />

          <div className="mt-4">
            <MethodologyCallout generatedAt={meta?.generated_at} windowLabel="7d" />
          </div>

          <div className="mt-2">
            <ProfileTabs
              tabs={tabsWithCounts}
              defaultTab="overview"
              trailing={
                <>
                  {/* Star (#8256) pins this subnet to your homepage; Follow
                      (#8257) hands you a feed or webhook. Complementary, not
                      alternatives: one is for you, the other is for a machine. */}
                  <WatchStarButton kind="subnet" id={netuid} label={`SN${netuid}`} />
                  <WatchEntitySheet netuid={netuid} name={profile?.name ?? undefined} />
                  <SubnetWindowToggle />
                  {/* Restored, not removed: CopyLinkButton was imported here and
                      never rendered, and subnet detail had NO share affordance at
                      all while every comparable page has one (#8294). */}
                  <CopyLinkButton />
                  <SubnetCompareDrawer netuid={netuid} />
                </>
              }
            />
          </div>

          <div className="mt-6 min-w-0 space-y-8">
            {tab === "overview" ? <OverviewPanel netuid={netuid} profile={profile} /> : null}
            {tab === "api" ? <ApiEndpointsPanel netuid={netuid} /> : null}
            {tab === "metagraph" ? <MetagraphPanel netuid={netuid} /> : null}
            {tab === "economics" ? <EconomicsTabPanel netuid={netuid} /> : null}
            {tab === "activity" ? <ActivityPanel netuid={netuid} /> : null}
            {tab === "governance" ? <GovernancePanel netuid={netuid} /> : null}
            {tab === "about" ? <AboutPanel netuid={netuid} profile={profile} /> : null}
          </div>

          {/* #6558: the backend accepts netuid-scoped alert triggers, but only the
              validator page exposed a Watch UI. Extend the same pattern here.
              Outside the tab switch, so it's reachable from any tab -- same as the
              "Watch this validator" section on the validator page. */}
          <div className="mt-8">
            <SectionAnchor
              id="watch"
              title="Watch this subnet"
              subtitle="Alert on on-chain activity for this subnet, via the existing chain alert-triggers API."
              tone="accent"
            >
              <WatchSubnetAlert netuid={netuid} />
            </SectionAnchor>
          </div>

          {/* #6432: outside the tab switch, so the way back is there whichever
              tab a reader ends on -- this profile is the longest page in the app
              and the masthead breadcrumb is far behind by the time they finish.
              Same placement/styling as blocks.$ref.tsx and extrinsics.$hash.tsx. */}
          <div className="mt-6">
            <Link
              to="/subnets"
              className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
            >
              ← All subnets
            </Link>
          </div>
        </SubnetFilterProvider>
      </SubnetWindowProvider>
    </TimeRangeProvider>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

/* ----------------------------- overview ----------------------------- */

// #8247: Overview rebuilt as "one screen" answering is-it-up + how-do-I-call-it
// without scrolling past the fold — the masthead above already carries price
// (+7d spark), emission, stake, miners/validators, 24h uptime, and readiness,
// so none of those are restated here. Nine sections became five:
//   0 — Composed overview summary strip (status/curation/top-gap)
//   0b — Priority highlight strip
//   1 — "Start integrating" card (readiness + Start-here link + curl snippet)
//   2 — 90-day uptime strip (distinct window from the masthead's 24h tile)
//   3 — Recent activity (5 most recent decoded chain events)
//   4 — Open incidents (deep-linkable, lower-density context)
// Everything else moved to a tab that actually owns the question it answers:
// Economics (economics/volume/OHLC/stake-quote), API & Endpoints (operational
// status/resources/services/reliability), Governance & Ownership
// (conviction/ownership history/lease/hyperparameters), About (readiness
// detail/profile/lineage/evidence/gaps/identity history), Metagraph
// (validators + network history folded in). The old registry-activity heatmap
// + duplicate price/pool-composition mini (SubnetPulseStrip) are gone
// entirely, not relocated — they duplicated facts the masthead and Activity
// tab already state once each.
function OverviewPanel({ netuid, profile }: { netuid: number; profile?: SubnetProfile }) {
  return (
    <div className="space-y-6">
      {/* 0 — Composed overview summary strip (#3346) */}
      <AsyncPanel height="sm">
        <OverviewSummaryStrip netuid={netuid} />
      </AsyncPanel>

      {/* 0b — Priority highlight strip: at-a-glance jump-off to the four
          most-asked signals for this subnet. Mirrors SubnetsHighlights on
          the index route. */}
      <SubnetPriorityHighlights netuid={netuid} />

      {/* 1 — "Start integrating" card: the one new interaction the audit
          asked for -- readiness score, a jump to the tab that answers "how
          do I call it", and a copy-paste first request. */}
      <div id="start-integrating">
        <QueryErrorBoundary fallback={() => null}>
          <SubnetStartIntegratingCard netuid={netuid} profile={profile} />
        </QueryErrorBoundary>
      </div>

      {/* 2 — 90-day uptime strip: a longer window than the masthead's live
          24h tile, and distinct from the per-surface SLA/latency breakdown
          that now lives on the API & Endpoints tab. */}
      <div id="uptime-90d">
        <QueryErrorBoundary fallback={() => null}>
          <SubnetUptime90dStrip netuid={netuid} />
        </QueryErrorBoundary>
      </div>

      {/* 3 — Recent activity: a 5-item glance at the same first-party event
          stream the Activity tab lists in full. */}
      <div id="recent-activity">
        <QueryErrorBoundary fallback={() => null}>
          <SubnetRecentActivityFeed netuid={netuid} />
        </QueryErrorBoundary>
      </div>

      {/* 4 — Open incidents (deep-linkable, lower-density context) */}
      <MobileCollapse label="Open incidents" hint="Recent probe-derived incident timeline">
        <div id="incidents">
          <QueryErrorBoundary>
            <IncidentTimeline netuid={netuid} />
          </QueryErrorBoundary>
        </div>
      </MobileCollapse>
    </div>
  );
}

// #8247: readiness score (already computed for the masthead's KPI tile) +
// a jump to the tab that actually answers "how do I call it" + a copy-paste
// first request -- the one genuinely new Overview interaction the issue asks
// for. Deliberately thin: it links into API & Endpoints rather than
// duplicating ApiEndpointsPanel's content here.
function SubnetStartIntegratingCard({
  netuid,
  profile,
}: {
  netuid: number;
  profile?: SubnetProfile;
}) {
  const navigate = useNavigate({ from: "/subnets/$netuid" });
  const score = profile?.integration_readiness;
  const snippet = apiSnippet("curl", `/api/v1/subnets/${netuid}/profile`);
  return (
    <Panel dense bodyClassName="flex flex-wrap items-center gap-4" className="border-accent/30">
      <div className="min-w-0 shrink-0">
        <div className="mg-label">Start integrating</div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="font-display text-xl font-semibold tabular-nums text-ink-strong">
            {score != null ? score : "—"}
          </span>
          <span className="mg-type-data-sm text-ink-muted">/ 100 readiness</span>
        </div>
      </div>
      {/* #8247/CI: a second, `hidden`-gated copy of this same CopyableCode
          used to sit alongside a `sm:hidden` one for the mobile/desktop
          split -- CopyableCode's own base classes hardcode `inline-flex`
          unconditionally, so a plain (non-responsive) `hidden` utility on
          top of it loses the cascade to that hardcoded base class and never
          actually hides, overflowing the 375px viewport. One instance,
          shrinkable via `min-w-0`/`max-w-full`, truncates instead. */}
      <CopyableCode label="curl" value={snippet} className="min-w-0 max-w-full flex-1" />
      <button
        type="button"
        onClick={() =>
          navigate({
            to: ".",
            search: (prev: SearchParams) => ({ ...prev, tab: "api" }),
            replace: true,
          })
        }
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/40 bg-accent-surface px-3 py-1.5 mg-type-data font-medium text-accent-text hover:border-accent/70"
      >
        Start here →
      </button>
    </Panel>
  );
}

// #8247: a longer-window (90d, per subnetUptimeQuery's default) companion to
// the masthead's live 24h uptime tile -- same daily-series derivation
// (dailyHealthSeries) the masthead uses for its own trend delta, so the two
// never compute uptime two different ways.
function SubnetUptime90dStrip({ netuid }: { netuid: number }) {
  const { data: uptimeRes } = useQuery(subnetUptimeQuery(netuid));
  const surfaces = uptimeRes?.data?.surfaces;
  const window = uptimeRes?.data?.window ?? "90d";
  const days = (surfaces ?? []).flatMap((s) => s.days ?? []);
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const d of days) {
    if (!d.day || typeof d.uptime_ratio !== "number") continue;
    const cur = byDay.get(d.day) ?? { sum: 0, n: 0 };
    byDay.set(d.day, { sum: cur.sum + d.uptime_ratio * 100, n: cur.n + 1 });
  }
  const series = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v.sum / v.n);
  const mean = series.length ? series.reduce((a, b) => a + b, 0) / series.length : null;
  if (series.length === 0) return null;
  return (
    <Panel dense bodyClassName="flex items-center gap-4">
      <div className="shrink-0">
        <div className="mg-label">Uptime · {window}</div>
        <div className="mt-0.5 font-display text-lg font-semibold tabular-nums text-ink-strong">
          {mean != null ? `${mean.toFixed(2)}%` : "—"}
        </div>
      </div>
      <div className="h-8 min-w-0 flex-1">
        <Sparkline
          values={series}
          color="var(--health-ok)"
          height={32}
          ariaLabel={`${window} uptime trend`}
          formatValue={(v) => `${v.toFixed(2)}%`}
        />
      </div>
    </Panel>
  );
}

// #8247: the Overview's "what changed" glance -- a 5-item slice of the same
// first-party decoded-event stream the Activity tab renders in full, not a
// second data source.
function SubnetRecentActivityFeed({ netuid }: { netuid: number }) {
  const { data } = useQuery(subnetEventsQuery(netuid, {}));
  const events = ((data?.data.events ?? []) as AccountEvent[]).slice(0, 5);
  if (events.length === 0) return null;
  return (
    <Panel dense bodyClassName="space-y-2">
      <div className="mg-label">Recent activity</div>
      <ul className="space-y-1.5">
        {events.map((ev, i) => (
          <li
            key={`${ev.block_number}-${ev.event_index}-${i}`}
            className="flex min-w-0 items-center justify-between gap-3 mg-type-data"
          >
            {/* min-w-0 on both the row and the kind cell: the cell is
                whitespace-nowrap and the timestamp is shrink-0, so without a
                shrinkable box between them a long event-kind label pushes the
                timestamp past the viewport at 375px. Caught by the e2e
                overflow check on CI but not locally -- #8325 swapped these
                labels from mono to sans, and the two platforms disagree about
                how wide that is (#8250 follow-up). Truncation is the right
                behaviour here regardless of glyph metrics. */}
            <EventKindCell kind={ev.event_kind} className="min-w-0" />
            <TimeAgo at={ev.observed_at} className="shrink-0 text-ink-muted" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ----------------------------- API & Endpoints tab ----------------------------- */

// #8247: absorbs the old Overview's Operational status + Public resources,
// plus the old Callable-services/Surfaces/Endpoints/Schemas/Candidates/API
// tabs -- every "is it up, and how do I call it" question in one place.
// ResourceExplorer already supersedes the old standalone Endpoints/Surfaces/
// Schemas panels with a single segmented view (it superseded them once
// before, per its own header comment), so those three are not re-rendered
// here -- doing so would recreate exactly the kind of duplicate this issue
// exists to remove.
function ApiEndpointsPanel({ netuid }: { netuid: number }) {
  return (
    <div className="space-y-8">
      <MobileCollapse label="Operational status" hint="Timeline · incident ribbon" defaultOpen>
        <div id="operational">
          <AsyncPanel height="xl">
            <OperationalPanel netuid={netuid} />
          </AsyncPanel>
        </div>
      </MobileCollapse>

      <MobileCollapse label="Public resources" hint="Endpoints · surfaces · schemas" defaultOpen>
        <div id="resources">
          <QueryErrorBoundary>
            <ResourceExplorer netuid={netuid} />
          </QueryErrorBoundary>
        </div>
      </MobileCollapse>

      <CallableServicesPanel netuid={netuid} />

      <MobileCollapse label="Reliability" hint="Uptime SLA + latency percentiles">
        <SectionAnchor
          id="reliability"
          title="Reliability"
          subtitle="Per-surface uptime SLA and latency percentiles (p50/p95/p99) over 7d/30d."
          info="Live from the 2-minute health prober's D1 history: uptime ratio, reconstructed downtime incidents, and latency distribution per operational surface."
        >
          <ReliabilityPanel netuid={netuid} />
        </SectionAnchor>
      </MobileCollapse>

      {/* #8258: the registry knows each subnet's callable surfaces and already
          exposes a guarded way to call them; this is the first place a builder
          can actually try one without leaving the page. */}
      <SurfacePlayground netuid={netuid} />

      <CandidatesPanel netuid={netuid} />

      {/* #8329: the subnet-team flywheel -- a badge in their own README
          advertises the registry to exactly the audience we want, and it's
          honest in a way a self-reported one can't be. */}
      <UptimeBadgeEmbed netuid={netuid} />

      <ApiPanel netuid={netuid} />
    </div>
  );
}

/* ----------------------------- Economics tab ----------------------------- */

// #8247: economics/volume/OHLC/stake-quote grouped under their own tab
// instead of stacked on Overview. #8377 then promoted price history to the
// lead module -- every comparable explorer opens its market view on the
// price chart, and it's the one module here a visitor scrolls looking for.
function EconomicsTabPanel({ netuid }: { netuid: number }) {
  return (
    <div className="space-y-8">
      <SectionAnchor
        id="ohlc"
        title="Price history"
        subtitle="Open/high/low/close candles and traded volume, built from executed stake/unstake trades."
        info="GET /api/v1/subnets/{netuid}/ohlc — OHLCV candles over a ?days= window, bucketed by ?interval=1h|1d, from the same account_events StakeAdded/StakeRemoved stream as 24h Volume below. Each trade's price is amount_tao / alpha_amount; empty buckets are gaps, never synthesized flat candles."
      >
        <QueryErrorBoundary>
          <SubnetOhlcChart netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="economics"
        title="Economics"
        subtitle="On-chain emission share, stake, validators, and market data."
        info="Live chain economics from the Bittensor metagraph — emission share, alpha price, stake, validator/miner counts, and subnet volume."
      >
        <EconomicsPanel netuid={netuid} />
      </SectionAnchor>

      <SectionAnchor
        id="volume-24h"
        title="24h Volume"
        subtitle="Rolling 24h buy vs sell alpha volume — a windowed market-depth figure, distinct from the cumulative volume shown in Economics."
        info="GET /api/v1/subnets/{netuid}/volume — unsigned buy + sell alpha volume summed from the account_events stream over a fixed 24h window (not netted, no ?window= param)."
      >
        <QueryErrorBoundary>
          <AlphaVolumeScorecard netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="stake-quote"
        title="Stake-quote calculator"
        subtitle="Estimate the slippage and price impact of a stake or unstake before it happens."
        info="GET /api/v1/subnets/{netuid}/stake-quote?amount=&direction=stake|unstake — a read-only constant-product AMM estimate against the subnet's live pool reserves. Pure math, no chain write, no custody."
      >
        <StakeQuoteCalculator netuid={netuid} />
      </SectionAnchor>
    </div>
  );
}

/* ----------------------------- Governance & Ownership tab ----------------------------- */

// #8247: hyperparameters are governance-set config, and the ownership-contest
// + lease panels are all "who controls this subnet" questions -- one tab.
function GovernancePanel({ netuid }: { netuid: number }) {
  return (
    <div className="space-y-8">
      <SectionAnchor
        id="conviction"
        title="Ownership contest"
        subtitle="Who currently holds the most rolled conviction -- how close this subnet is to an automatic ownership flip."
        info="GET /api/v1/subnets/{netuid}/conviction — rolled forward from the periodically-captured lock snapshot to query time, using the live UnlockRate/MaturityRate governance values. Most subnets have no active challengers."
      >
        <QueryErrorBoundary>
          <SubnetConvictionLeaderboard netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="ownership-history"
        title="Ownership history"
        subtitle="Every automatic ownership transfer this subnet has undergone."
        info="GET /api/v1/subnets/{netuid}/ownership-history — decoded from the chain_events SubnetOwnerChanged stream. A subnet that has never changed hands returns an empty list, not an error."
      >
        <QueryErrorBoundary>
          <SubnetOwnershipHistory netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="lease"
        title="Subnet lease"
        subtitle="Live lease status, terms, and created/terminated history."
        info="GET /api/v1/subnets/{netuid}/lease and /lease/history — live RPC for current lease state (leased null = RPC failure, distinct from not leased) plus the SubnetLeaseCreated/Terminated event log."
      >
        <QueryErrorBoundary>
          <SubnetLeasePanel netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>

      <HyperparametersPanel netuid={netuid} />
      <HyperparamsHistoryPanel netuid={netuid} />
    </div>
  );
}

/* ----------------------------- About tab ----------------------------- */

// #8247: reference-shaped, low-churn content -- profile/lineage/readiness
// detail/identity history/evidence/gaps -- rendered as one-liners rather than
// framed "No X yet" panels wherever the sub-component supports it.
function AboutPanel({ netuid, profile }: { netuid: number; profile?: SubnetProfile }) {
  return (
    <div className="space-y-8">
      <div id="profile">
        <AsyncPanel height="lg">
          <SubnetProfilePanel netuid={netuid} />
        </AsyncPanel>
      </div>

      <ReadinessScorecard profile={profile} />

      {netuid === 74 ? (
        <QueryErrorBoundary>
          <GittensorRegisteredRepos slug="gittensor" />
        </QueryErrorBoundary>
      ) : null}

      <IdentityHistoryPanel netuid={netuid} />

      <SubnetLineageSection netuid={netuid} />

      <DevActivityPanel profile={profile} />

      <SectionAnchor
        id="evidence"
        title="Evidence & sources"
        subtitle="Primary links and recorded evidence backing this profile."
        info="GET /api/v1/evidence — source URLs and timestamps for verified registry entries."
      >
        <EvidencePanel netuid={netuid} />
      </SectionAnchor>

      <GapsPanel netuid={netuid} />
    </div>
  );
}

// #3346: the server-composed summary — counts + lifecycle status + curation
// level + (if any) the top gap-priority hint — sourced from the one dedicated
// /overview route instead of re-deriving equivalent state from the several
// separate calls the sub-panels below already make. `status` here is the
// subnet's on-chain lifecycle (e.g. "active"/"deregistered"), a different
// vocabulary than health.status's probe-derived ok/warn/down/unknown — so it
// renders as a plain badge rather than through HealthPill, which only knows
// the probe vocabulary and would otherwise mislabel e.g. "active" as
// "Unknown". health.status (when present) uses HealthPill correctly.
function OverviewSummaryStrip({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetOverviewQuery(netuid));
  const overview = data.data;
  const health = overview.health as Record<string, unknown> | undefined;
  const curation = overview.curation as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Surface / endpoint / candidate counts are already shown (and stay
          visible while scrolling) in the tab-bar badges above, so they're not
          restated as StatTiles here — the strip keeps only the status/curation
          chips (#5316). The top-gap hint that used to sit here was maintainer
          queue language ("Top gap: evaluate for subnet-specific adapter") --
          not subnet-page furniture; that same gap already renders on
          /contribute (#8363). */}
      {overview.status ? (
        <span className="mg-type-caption inline-flex items-center rounded border border-border bg-card px-2 py-0.5 text-ink-muted">
          {overview.status}
        </span>
      ) : null}
      {typeof health?.status === "string" ? <HealthPill state={health.status} /> : null}
      {typeof curation?.level === "string" ? <CurationChip level={curation.level} /> : null}
    </div>
  );
}

// #1113: cross-network lineage. Non-blocking (useQuery, shared cache across all
// subnet pages); renders nothing unless this netuid is paired with a counterpart.
// Reads lineageRes.data.links (NOT a top-level array).
function SubnetLineageSection({ netuid }: { netuid: number }) {
  const { data: lineageRes, isError, error, refetch } = useQuery(lineageQuery());
  const lineage = lineageRes?.data;

  if (isError) {
    return (
      <SectionAnchor
        id="lineage"
        title="Lineage"
        info="Cross-network lineage links the testnet and mainnet deployments of the same subnet, matched by chain name or source repo."
      >
        <TableState
          variant="error"
          title="Lineage unavailable"
          description="The cross-network lineage data failed to load."
          error={error}
          onRetry={() => void refetch()}
        />
      </SectionAnchor>
    );
  }

  const link = (lineage?.links ?? []).find(
    (l) => l.mainnet_netuid === netuid || l.testnet_netuid === netuid,
  );
  if (!lineage || !link) return null;

  const onMainnet = link.mainnet_netuid === netuid;
  const counterpartName = onMainnet ? link.testnet_name : link.mainnet_name;
  const counterpartNetuid = onMainnet ? link.testnet_netuid : link.mainnet_netuid;
  const selfNetwork = onMainnet ? lineage.source_network : lineage.target_network;
  const counterpartNetwork = onMainnet ? lineage.target_network : lineage.source_network;
  const matchedBy = link.matched_by?.replace(/_/g, " ");

  return (
    <SectionAnchor
      id="lineage"
      title="Lineage"
      subtitle={`Paired across networks — ${selfNetwork} ↔ ${counterpartNetwork}.`}
      info="Cross-network lineage links the testnet and mainnet deployments of the same subnet, matched by chain name or source repo."
    >
      <Panel dense bodyClassName="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="mg-label">{counterpartNetwork} counterpart</span>
          <span className="font-display text-sm font-semibold text-ink-strong">
            {counterpartName ?? `Subnet ${counterpartNetuid}`}
          </span>
          <span className="font-mono text-xs text-ink-muted">#{counterpartNetuid}</span>
        </div>
        {matchedBy ? (
          <span className="rounded-full border border-border px-2 py-0.5 mg-type-data text-ink-muted">
            matched by {matchedBy}
          </span>
        ) : null}
      </Panel>
    </SectionAnchor>
  );
}

/* ----------------------------- panels ----------------------------- */

function IdentityHistoryPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="identity"
      title="Identity history"
      subtitle="On-chain name, symbol, and metadata changes for this subnet, newest first."
      info="GET /api/v1/subnets/{netuid}/identity-history — each row is an observed on-chain SubnetIdentitiesV3 snapshot, so the timeline shows how the subnet's registered identity changed over time."
    >
      <AsyncPanel height="xl">
        <IdentityHistoryList netuid={netuid} />
      </AsyncPanel>
    </SectionAnchor>
  );
}

function IdentityHistoryList({ netuid }: { netuid: number }) {
  const { data: res } = useSuspenseQuery(subnetIdentityHistoryQuery(netuid));
  const entries = res.data.entries;

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No identity history yet"
        description="This subnet has no recorded on-chain identity changes."
      />
    );
  }

  return (
    <ol className="space-y-2">
      {entries.map((entry, i) => (
        <li
          key={`${entry.identity_hash}-${i}`}
          className="rounded-md border border-border bg-card p-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-display text-sm font-semibold text-ink-strong">
              {entry.subnet_name ?? "Unnamed"}
              {entry.symbol ? (
                <span className="ml-1.5 font-mono text-xs text-ink-muted">{entry.symbol}</span>
              ) : null}
            </span>
            <span className="mg-type-data text-ink-muted">
              {entry.observed_at ? <TimeAgo at={entry.observed_at} /> : "unknown time"}
              {entry.block_number != null ? ` · block #${formatNumber(entry.block_number)}` : ""}
            </span>
          </div>
          {entry.description ? (
            <p className="mt-1 text-xs text-ink-muted">{entry.description}</p>
          ) : null}
          {entry.subnet_url || entry.github_repo || entry.discord ? (
            <div className="mt-1.5 flex flex-wrap gap-3 text-[11px]">
              {entry.subnet_url ? (
                <ExternalLink href={entry.subnet_url} className="text-accent-text hover:underline">
                  website
                </ExternalLink>
              ) : null}
              {entry.github_repo ? (
                <ExternalLink href={entry.github_repo} className="text-accent-text hover:underline">
                  repo
                </ExternalLink>
              ) : null}
              {entry.discord ? (
                <ExternalLink href={entry.discord} className="text-accent-text hover:underline">
                  discord
                </ExternalLink>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// #4339/8.1: rolling 24h buy/sell alpha volume scorecard. A cold store returns
// all-zero totals (never 404) — non-blocking (useQuery, not suspense) so a
// slow/failed fetch never stalls the rest of the overview tab.
function AlphaVolumeScorecard({ netuid }: { netuid: number }) {
  const { data: res } = useQuery(subnetAlphaVolumeQuery(netuid));
  const card = res?.data;
  if (!card) return null;
  const sentimentIcon =
    card.sentiment === "bullish" ? TrendingUp : card.sentiment === "bearish" ? TrendingDown : Minus;
  const sentimentTone: "ok" | "down" | "default" =
    card.sentiment === "bullish" ? "ok" : card.sentiment === "bearish" ? "down" : "default";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        icon={ArrowLeftRight}
        eyebrow="Total volume"
        value={`${taoCompact(card.total_volume_tao)} τ`}
        hint={`${formatNumber(card.buy_count + card.sell_count)} txns · ${card.window}`}
      />
      <StatTile
        icon={ArrowDownToLine}
        eyebrow="Buy volume"
        value={`${taoCompact(card.buy_volume_tao)} τ`}
        hint={`${formatNumber(card.buy_count)} buys`}
      />
      <StatTile
        icon={ArrowUpFromLine}
        eyebrow="Sell volume"
        value={`${taoCompact(card.sell_volume_tao)} τ`}
        hint={`${formatNumber(card.sell_count)} sells`}
      />
      <StatTile
        icon={sentimentIcon}
        eyebrow="Sentiment"
        tone={sentimentTone}
        value={card.sentiment}
        hint={
          card.sentiment_ratio != null
            ? `ratio ${card.sentiment_ratio.toFixed(2)}`
            : "no volume yet"
        }
      />
    </div>
  );
}

const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"] as const;

// Same precision rule as accounts.$ss58.tsx's fmtAlphaPrice — the same
// alpha_price_tao-scale unit shown there and in subnet-price-ticker.tsx.
function fmtQuotePrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.001) return v.toExponential(2);
  return v < 1 ? v.toFixed(4) : v.toFixed(3);
}

// #5235: read-only constant-product stake/unstake slippage calculator — the
// one genuinely new interaction pattern on this page (a free-text amount
// driving a live query, no existing precedent elsewhere in the app). Direction
// gates the input/output units: "stake" takes a TAO amount and quotes alpha
// out; "unstake" takes an alpha amount and quotes TAO out (mirrors the
// chain's own swap direction, see src/stake-quote.ts).
function StakeQuoteCalculator({ netuid }: { netuid: number }) {
  const [amountInput, setAmountInput] = useState("");
  const [direction, setDirection] = useState<(typeof STAKE_QUOTE_DIRECTIONS)[number]>("stake");
  // #6391: arrow-key navigation for the role="tablist" direction toggle.
  const directionIndex = Math.max(0, STAKE_QUOTE_DIRECTIONS.indexOf(direction));
  const { tabRef: directionTabRef, onKeyDown: directionKeyDown } = useRovingTablist(
    STAKE_QUOTE_DIRECTIONS.length,
    (i) => setDirection(STAKE_QUOTE_DIRECTIONS[i]),
  );
  const amount = Number(amountInput);
  const hasValidAmount = amountInput.trim() !== "" && Number.isFinite(amount) && amount > 0;
  const result = useQuery(subnetStakeQuoteQuery(netuid, hasValidAmount ? amount : 0, direction));
  const quote = result.data?.data;
  const inputUnit = direction === "stake" ? "τ" : "α";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          {/* SearchInput sets its own aria-label from `placeholder` -- this is a
              visual label only, not `<label htmlFor>`, since SearchInput has no
              `id` prop to associate with. */}
          <span aria-hidden="true" className="mg-type-caption text-ink-muted">
            Amount ({inputUnit})
          </span>
          <SearchInput
            value={amountInput}
            onChange={setAmountInput}
            placeholder={`0.00 ${inputUnit}`}
            inputMode="decimal"
            className="w-40 flex-none font-mono tabular-nums"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="mg-type-caption text-ink-muted">Direction</span>
          <div
            role="tablist"
            aria-label="Stake or unstake"
            className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
          >
            {STAKE_QUOTE_DIRECTIONS.map((d, i) => {
              const active = d === direction;
              return (
                <button
                  key={d}
                  ref={directionTabRef(i)}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={rovingTabIndex(i, directionIndex)}
                  onClick={() => setDirection(d)}
                  onKeyDown={directionKeyDown(i)}
                  className={classNames(
                    "min-h-8 rounded px-3 py-1.5 mg-type-label uppercase transition-colors",
                    active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!hasValidAmount ? (
        <p className="mg-type-data text-ink-muted">
          Enter an amount to estimate slippage against the subnet's live pool reserves.
        </p>
      ) : result.isError ? (
        <p className="inline-flex items-center gap-1.5 mg-type-data text-health-down">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {result.error instanceof Error ? result.error.message : "Could not compute a quote."}
        </p>
      ) : result.isPending ? (
        <p className="mg-type-data text-ink-muted">Calculating…</p>
      ) : quote ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            icon={Calculator}
            eyebrow={`Expected ${quote.expected_out_unit}`}
            value={`${formatNumber(quote.expected_out)} ${quote.expected_out_unit === "tao" ? "τ" : "α"}`}
            hint={quote.is_root ? "root subnet · 1:1" : "live reserves"}
          />
          <StatTile
            icon={Waves}
            eyebrow="Spot price"
            value={`${fmtQuotePrice(quote.spot_price_tao)} τ`}
            hint="before this swap"
          />
          <StatTile
            icon={ArrowLeftRight}
            eyebrow="Effective price"
            value={`${fmtQuotePrice(quote.effective_price_tao)} τ`}
            hint="average, this swap"
          />
          <StatTile
            icon={quote.price_impact_pct > 0 ? TrendingDown : Minus}
            eyebrow="Price impact"
            tone={quote.price_impact_pct > 5 ? "down" : "default"}
            value={`${quote.price_impact_pct.toFixed(2)}%`}
            hint={quote.is_root ? "no AMM · zero impact" : "vs spot price"}
          />
        </div>
      ) : null}
    </div>
  );
}

// On-chain activity stream (#1345): first-party SubtensorModule events for this
// subnet, decoded direct from finney and served from /api/v1/subnets/{netuid}/events.
function StakeFlowScorecard({ netuid }: { netuid: number }) {
  const { data: res } = useQuery(subnetStakeFlowQuery(netuid));
  const card = res?.data;
  if (!card) return null;
  const net = card.net_flow_tao;
  const netTone: "ok" | "down" | "default" = net > 0 ? "ok" : net < 0 ? "down" : "default";
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        icon={ArrowDownToLine}
        eyebrow="Staked in"
        value={`${taoCompact(card.total_staked_tao)} τ`}
        hint={`${formatNumber(card.stake_events)} stake events`}
      />
      <StatTile
        icon={ArrowUpFromLine}
        eyebrow="Unstaked out"
        value={`${taoCompact(card.total_unstaked_tao)} τ`}
        hint={`${formatNumber(card.unstake_events)} unstake events`}
      />
      <StatTile
        icon={Waves}
        eyebrow="Net flow"
        tone={netTone}
        value={`${taoCompact(net)} τ`}
        hint={net > 0 ? "net inflow" : net < 0 ? "net outflow" : "balanced"}
      />
      <StatTile
        icon={Activity}
        eyebrow="Total events"
        value={formatNumber(card.stake_events + card.unstake_events)}
        hint={`over ${card.window}`}
      />
    </div>
  );
}

function ActivityPanel({ netuid }: { netuid: number }) {
  const { ev_kind } = useSearch({ from: "/subnets/$netuid" });
  const navigate = useNavigate({ from: "/subnets/$netuid" });
  return (
    <div className="space-y-6">
      {/* #8247: moved from the Overview's SubnetPulseStrip -- the registry
          activity heatmap belongs beside the rest of the activity data, not
          duplicated above every tab. */}
      <div id="registry-activity">
        <QueryErrorBoundary fallback={() => null}>
          <ActivityHeatmap netuid={netuid} />
        </QueryErrorBoundary>
      </div>

      <SectionAnchor
        id="activity"
        title="On-chain activity"
        info="First-party chain events for this subnet, newest first. Registrations, stake, weights, axon, delegation, lifecycle, and transfers decoded directly from finney System.Events for recent finalized blocks (the rolling first-party event window) — not Taostats."
        right={
          <EventKindFilterChip
            value={ev_kind ?? ""}
            onChange={(v) =>
              navigate({
                to: ".",
                search: (prev: SearchParams) => ({ ...prev, ev_kind: v || undefined }),
                replace: true,
              })
            }
          />
        }
      >
        <ActivityEventRollup netuid={netuid} />
        <StakeFlowScorecard netuid={netuid} />
        <AsyncPanel height="md">
          <ActivityTableLoader netuid={netuid} kind={ev_kind} />
        </AsyncPanel>
      </SectionAnchor>
    </div>
  );
}

// #7000: windowed rollup complementing the raw per-event Activity table below —
// total events / distinct kinds & categories / TAO+alpha moved (from
// subnetEventSummaryQuery's per-category breakdown) plus an axon-removals
// glance (from subnetAxonRemovalsQuery), so a visitor doesn't have to tally the
// raw event log by hand. Both queries already exist for other surfaces; this is
// the first place either is actually rendered.
const TOP_CATEGORY_COUNT = 3;

function ActivityEventRollup({ netuid }: { netuid: number }) {
  const { data: summaryRes } = useQuery(subnetEventSummaryQuery(netuid));
  const { data: axonRes } = useQuery(subnetAxonRemovalsQuery(netuid));
  const summary = summaryRes?.data;
  const axon = axonRes?.data;
  if (!summary && !axon) return null;

  const categories = summary?.categories ?? [];
  const topCategories = [...categories]
    .sort((a, b) => b.event_count - a.event_count)
    .slice(0, TOP_CATEGORY_COUNT)
    .map((c) => c.category)
    .join(", ");
  const totalTao = categories.reduce((sum, c) => sum + c.amount_tao, 0);
  const totalAlpha = categories.reduce((sum, c) => sum + c.alpha_amount, 0);

  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        icon={Activity}
        eyebrow="Events"
        value={formatNumber(summary?.total_events ?? 0)}
        hint={summary ? `over ${summary.window}` : "—"}
        tooltip="Total decoded chain events for this subnet in the window."
      />
      <StatTile
        icon={Layers}
        eyebrow="Kinds / categories"
        value={`${formatNumber(summary?.kind_count ?? 0)} / ${formatNumber(summary?.category_count ?? 0)}`}
        hint={topCategories || "—"}
        tooltip="Distinct event kinds and categories seen, with the top categories by volume."
      />
      <StatTile
        icon={Coins}
        eyebrow="TAO / alpha moved"
        value={`${taoCompact(totalTao)} τ`}
        hint={`${taoCompact(totalAlpha)} α`}
        tooltip="Summed TAO and alpha amounts across all categorized events in the window."
      />
      <StatTile
        icon={UserMinus}
        eyebrow="Axon removals"
        value={formatNumber(axon?.removals ?? 0)}
        hint={axon ? `${formatNumber(axon.distinct_removers)} removers · ${axon.window}` : "—"}
        tooltip="AxonInfoRemoved events and distinct removing hotkeys over the window."
      />
    </div>
  );
}

// Subnets have no per-subnet event_kinds summary to source filter options from
// (unlike AccountSummary.event_kinds on the account page) — use the full
// shared label map instead.
const EVENT_KIND_OPTIONS = Object.entries(EVENT_KIND_LABELS).map(([value, label]) => ({
  value,
  label,
}));

// Pill-shaped filter chip matching the EndpointKindTabs / window-toggle idiom
// used elsewhere for compact filters, rather than the generic bordered-box
// label+select pattern — a native <select> still drives it for a11y and
// mobile-native option picking, the Filter icon carries the "Kind" label so
// the chip stays narrow enough that it never pushes the section title onto
// multiple lines.
function EventKindFilterChip({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 text-ink-muted hover:border-ink/30 transition-colors">
      <Filter className="size-3 shrink-0" aria-hidden />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Filter by event kind"
        className="min-w-0 max-w-[85px] truncate bg-transparent mg-type-label uppercase text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <option value="">All</option>
        {EVENT_KIND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const EVENT_KIND_CATEGORY_DOT: Record<EventKindCategory, string> = {
  registration: "var(--chart-1)",
  stake: "var(--chart-2)",
  serving: "var(--chart-3)",
  consensus: "var(--chart-4)",
  delegation: "var(--chart-5)",
  identity: "var(--chart-6)",
  governance: "var(--accent)",
  transfer: "var(--health-warn)",
  other: "var(--health-unknown)",
};

function EventKindCell({
  kind,
  className,
  /** #8366: the aggregated-row count ("× 7") -- omitted (or 1) renders exactly as before. */
  count,
  /** #8366: "· last 12m" -- the issue's own worked-example format, only shown alongside a real count. */
  spanMinutes,
}: {
  kind: string | null | undefined;
  className?: string;
  count?: number;
  spanMinutes?: number | null;
}) {
  const category = eventKindCategory(kind);
  const categoryLabel = eventKindCategoryLabel(category);
  const label = eventKindLabel(kind);
  const grouped = count != null && count > 1;

  return (
    <span
      className={classNames("inline-flex items-center gap-1.5", className)}
      title={`${label} · ${categoryLabel}`}
    >
      <span
        role="img"
        aria-label={`Category: ${categoryLabel}`}
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: EVENT_KIND_CATEGORY_DOT[category] }}
      />
      <span className="truncate text-[11px] text-ink-strong">{label}</span>
      {grouped ? (
        <span className="mg-type-caption-lg text-ink-muted">
          × {count}
          {spanMinutes != null ? ` · last ${spanMinutes}m` : ""}
        </span>
      ) : null}
      <span className="inline-flex items-center rounded border border-border bg-surface/40 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
        {categoryLabel}
      </span>
    </span>
  );
}

/**
 * One event's row, exactly as it always rendered -- pulled out unchanged so
 * it can be reused both for an ungrouped event (a group of one -- the
 * common case, and every one of these renders byte-for-byte identically to
 * before #8366) and for each individual member row revealed when a
 * collapsed group is expanded.
 */
function ActivityEventRow({ ev, nested }: { ev: AccountEvent; nested?: boolean }) {
  return (
    <tr className={classNames("hover:bg-surface/40", nested && "bg-surface/20")}>
      <td className="px-4 py-2.5 font-mono mg-type-caption whitespace-nowrap">
        {ev.block_number != null ? (
          <Link
            to="/blocks/$ref"
            params={{ ref: String(ev.block_number) }}
            className="text-ink hover:underline"
          >
            #{formatNumber(ev.block_number)}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td className={classNames("px-4 py-2.5 whitespace-nowrap", nested && "pl-8")}>
        <EventKindCell kind={ev.event_kind} />
      </td>
      <td className="px-4 py-2.5 mg-type-data whitespace-nowrap">
        <AddressDisplay
          ss58={ev.hotkey}
          fallback="—"
          compact
          valueClassName="text-ink-muted hover:text-ink"
        />
      </td>
      <td className="px-4 py-2.5 text-right mg-type-data tabular-nums text-ink whitespace-nowrap">
        {ev.amount_tao != null ? `${formatNumber(ev.amount_tao)} τ` : "—"}
      </td>
      <td className="px-4 py-2.5 text-right mg-type-data text-ink-muted whitespace-nowrap">
        <TimeAgo at={ev.observed_at} />
      </td>
    </tr>
  );
}

/**
 * #8366: one row PER AGGREGATED GROUP instead of one per event -- the fix
 * for the audit's "five near-identical rows" monotony finding. A group of
 * one renders through {@link ActivityEventRow} completely unchanged (this
 * applies equally whether the table got here via a live stream refresh or
 * the static/poll fallback -- both feed the same `events` array through the
 * same {@link aggregateActivityEvents} call, so there's exactly one
 * rendering path either way). A group of more than one collapses to a
 * single summary row -- kind, "× N · last Mm", the newest member's block/
 * time, and the shared hotkey if every member has the SAME one ("multiple"
 * otherwise) -- clickable to reveal the individual rows beneath it.
 */
function ActivityGroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: ActivityGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (group.events.length === 1) {
    return <ActivityEventRow ev={group.events[0]!} />;
  }
  const latest = group.events[0]!;
  const span = activityGroupSpanMinutes(group);
  const sameHotkey = group.events.every((e) => e.hotkey === latest.hotkey);

  return (
    <>
      <tr
        className="cursor-pointer hover:bg-surface/40"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="px-4 py-2.5 font-mono mg-type-caption whitespace-nowrap">
          {latest.block_number != null ? (
            <Link
              to="/blocks/$ref"
              params={{ ref: String(latest.block_number) }}
              className="text-ink hover:underline"
              // The row itself toggles expand/collapse; this inner link must
              // navigate instead, not also fire the row's own onClick.
              onClick={(e) => e.stopPropagation()}
            >
              #{formatNumber(latest.block_number)}
            </Link>
          ) : (
            "—"
          )}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            <ChevronDown
              className={classNames(
                "size-3 shrink-0 text-ink-muted transition-transform",
                !expanded && "-rotate-90",
              )}
              aria-hidden
            />
            <EventKindCell kind={group.kind} count={group.events.length} spanMinutes={span} />
          </span>
        </td>
        <td className="px-4 py-2.5 mg-type-data whitespace-nowrap">
          {sameHotkey && latest.hotkey ? (
            // The row itself toggles expand/collapse; the address link/copy
            // button must navigate/copy instead, not also fire onToggle.
            <span onClick={(e) => e.stopPropagation()}>
              <AddressDisplay
                ss58={latest.hotkey}
                fallback="—"
                compact
                valueClassName="text-ink-muted hover:text-ink"
              />
            </span>
          ) : (
            <span className="text-ink-muted">multiple</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right mg-type-data tabular-nums text-ink-muted whitespace-nowrap">
          —
        </td>
        <td className="px-4 py-2.5 text-right mg-type-data text-ink-muted whitespace-nowrap">
          <TimeAgo at={latest.observed_at} />
        </td>
      </tr>
      {expanded
        ? group.events.map((ev, i) => (
            <ActivityEventRow key={`${ev.block_number}-${ev.event_index}-${i}`} ev={ev} nested />
          ))
        : null}
    </>
  );
}

function ActivityTableLoader({ netuid, kind }: { netuid: number; kind?: string }) {
  const navigate = useNavigate({ from: "/subnets/$netuid" });
  const queryClient = useQueryClient();
  const eventsQueryOptions = subnetEventsQuery(netuid, { kind });
  const { data } = useSuspenseQuery(eventsQueryOptions);
  const events = (data.data.events ?? []) as AccountEvent[];
  // #8366: same array, live-refreshed or static snapshot alike -- see
  // ActivityGroupRow's own comment for why that means one rendering path
  // covers both. Recomputed on every render rather than memoized: at most
  // 100 events (subnetEventsQuery's own limit), cheap enough that memoizing
  // it would cost more bookkeeping than it saves.
  const groups = aggregateActivityEvents(events);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<number>>(new Set());

  // #8445: subscribe to the firehose's `account_events` topic (the only one
  // that carries `netuid` on the payload -- `chain_events` doesn't) so a new
  // event for this subnet refreshes the table well under the existing poll.
  const { status: streamStatus } = useChainStream({
    topics: ["account_events"],
    matches: (payload) => accountEventMatchesNetuid(payload, netuid),
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: eventsQueryOptions.queryKey });
    },
  });
  if (events.length === 0) {
    return (
      <div className="space-y-3">
        <TableState
          variant="empty"
          title={kind ? `No ${kind} events` : "No recent on-chain activity"}
          description={
            kind
              ? "Try clearing the kind filter — this subnet may not have emitted that event recently."
              : "No first-party chain events are indexed for this subnet in the current window — a quiet or newly-added subnet may have none yet. Registrations, stake, weights, delegation, and transfers will appear here as they're decoded."
          }
          generatedAt={data.meta?.generated_at}
        />
        {kind ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() =>
                navigate({
                  to: ".",
                  search: (prev: SearchParams) => ({ ...prev, ev_kind: undefined }),
                  replace: true,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 mg-type-data text-ink-muted hover:border-ink/30 hover:text-ink-strong"
            >
              Clear filter
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    // #8365: shared 1s clock for every row's TimeAgo -- a subnet mid-epoch
    // can carry dozens of sub-minute-old rows at once, exactly the case a
    // per-row timer adds up for.
    <LiveTickerProvider>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="mg-type-caption text-ink-muted">
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <StreamStatusChip status={streamStatus} testId="subnet-activity-stream-status" />
            <RealtimeFreshness at={data.meta?.generated_at} />
          </div>
        </div>
        <ResponsiveTable className="rounded border border-border bg-card" minWidth={720}>
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/40">
              <tr>
                <th className="px-4 py-2.5 whitespace-nowrap">Block</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Kind</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Hotkey</th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Amount</th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Observed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groups.map((group, i) => (
                <ActivityGroupRow
                  key={`${group.kind}-${group.events[0]!.block_number}-${group.events[0]!.event_index}-${i}`}
                  group={group}
                  expanded={expandedGroups.has(i)}
                  onToggle={() =>
                    setExpandedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      </div>
    </LiveTickerProvider>
  );
}

/* ----------------------------- callable services (#9) ----------------------------- */

// #9: the agent-catalog capability view for this subnet — every callable service
// (subnet-api / openapi / sse / data-artifact) with its kind, base URL, auth,
// live probe health, and locally generated copy-paste snippets. Fed by /api/v1/agent-catalog/{netuid}.
function CallableServicesPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="services"
      title="Callable services"
      subtitle="Public-safe, agent-callable interfaces with live health and safely generated snippets."
      info="GET /api/v1/agent-catalog/{netuid}. Only public-safe callable surfaces (subnet-api, OpenAPI, SSE, data-artifact) appear here; health is probe-derived."
    >
      <AsyncPanel height="md">
        <CallableServicesList netuid={netuid} />
      </AsyncPanel>
    </SectionAnchor>
  );
}

function serviceHealthState(status?: string): string {
  if (status === "ok") return "ok";
  if (status === "degraded" || status === "warn") return "warn";
  if (status === "failed" || status === "down") return "down";
  return "unknown";
}

function CallableServicesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(agentCatalogDetailQuery(netuid));
  const detail = data.data;
  const services = (detail.services ?? []) as AgentCatalogService[];
  const readiness = detail.agent_readiness;
  const blockers = (readiness?.blockers ?? []) as AgentCatalogBlocker[];

  if (services.length === 0) {
    return (
      <div className="space-y-3">
        <AgentReadinessCard
          tier={detail.readiness?.readiness_tier ?? detail.readiness_tier}
          score={detail.integration_readiness}
          status={readiness?.status}
          blockers={blockers}
        />
        <TableState
          variant="empty"
          title="No callable service catalogued yet"
          description="This subnet has no public-safe callable surface in the agent catalog. The readiness card above lists exactly what's blocking it — help close those gaps via the public registry repo."
          generatedAt={detail.generated_at ?? data.meta?.generated_at}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AgentReadinessCard
        tier={detail.readiness?.readiness_tier ?? detail.readiness_tier}
        score={detail.integration_readiness}
        status={readiness?.status}
        blockers={blockers}
      />
      <ul className="space-y-3">
        {services.map((svc, i) => (
          <ServiceCard key={svc.surface_id ?? `${svc.kind}-${i}`} service={svc} />
        ))}
      </ul>
    </div>
  );
}

const SERVICE_READINESS_TONE: Record<string, string> = {
  buildable: "text-health-ok border-health-ok/40",
  emerging: "text-accent-text border-accent/40",
  "identity-only": "text-health-warn border-health-warn/40",
  dormant: "text-ink-muted border-border",
};

function AgentReadinessCard({
  tier,
  score,
  status,
  blockers,
}: {
  tier?: string;
  score?: number;
  status?: string;
  blockers: AgentCatalogBlocker[];
}) {
  const tone = SERVICE_READINESS_TONE[tier ?? ""] ?? "text-ink-muted border-border";
  return (
    <Panel dense>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="mg-label">Integration readiness</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-semibold tabular-nums text-ink-strong">
              {score != null ? score : "—"}
            </span>
            <span className="mg-type-data-sm text-ink-muted">/ 100</span>
          </div>
        </div>
        {tier ? (
          <span
            className={classNames(
              "mg-type-caption inline-flex items-center rounded border px-1.5 py-0.5",
              tone,
            )}
          >
            {tier}
          </span>
        ) : null}
        {status ? <span className="mg-type-caption text-ink-muted">{status}</span> : null}
      </div>
      {blockers.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mg-label mb-1.5">What's blocking buildability</div>
          <ul className="space-y-1.5">
            {blockers.map((b, i) => (
              <li key={b.code ?? i} className="mg-type-caption leading-relaxed text-ink">
                <span className="font-medium text-ink-strong">{b.message ?? b.code}</span>
                {b.next_action ? <span className="text-ink-muted"> — {b.next_action}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function ServiceCard({ service }: { service: AgentCatalogService }) {
  const callable = service.eligibility?.callable;
  return (
    <li className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mg-type-caption inline-flex items-center rounded border border-accent/40 bg-primary-soft px-1.5 py-0.5 text-accent-text">
          {service.kind ?? "service"}
        </span>
        <span className="font-medium text-ink-strong truncate">
          {service.capability ?? service.surface_id ?? "Service"}
        </span>
        {service.provider ? (
          <span className="mg-type-data-sm text-ink-muted">{service.provider}</span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-2">
          <span
            className={classNames(
              "inline-flex items-center rounded border px-1.5 py-0.5 mg-type-caption",
              service.auth_required
                ? "border-health-warn/40 text-health-warn"
                : "border-border text-ink-muted",
            )}
            title={
              service.auth_schemes && service.auth_schemes.length
                ? `Auth: ${service.auth_schemes.join(", ")}`
                : undefined
            }
          >
            {service.auth_required ? "auth" : "no auth"}
          </span>
          <HealthPill state={serviceHealthState(service.health?.status)} />
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 mg-type-data text-ink-muted">
        {service.base_url ? (
          <CopyableCode label="url" value={service.base_url} className="max-w-full" />
        ) : null}
        {service.health?.latency_ms != null ? (
          <span className="tabular-nums">{service.health.latency_ms} ms</span>
        ) : null}
        {service.eligibility?.live_status ? <span>{service.eligibility.live_status}</span> : null}
        {callable === false ? <span className="text-health-warn">not callable</span> : null}
        {service.schema_url ? (
          <ExternalLink href={service.schema_url} className="text-accent-text hover:underline">
            schema
          </ExternalLink>
        ) : null}
      </div>

      {service.base_url ? (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          <div className="mg-label mb-1">Call it</div>
          <CopyableCode
            label="curl"
            value={apiSnippet("curl", service.base_url)}
            truncate={false}
            className="w-full"
          />
          <CopyableCode
            label="python"
            value={apiSnippet("python", service.base_url)}
            truncate={false}
            className="w-full"
          />
          <CopyableCode
            label="ts"
            value={apiSnippet("js", service.base_url)}
            truncate={false}
            className="w-full"
          />
        </div>
      ) : null}
    </li>
  );
}

/* ----------------------------- metagraph depth ----------------------------- */

// Subnet economic depth (#1302+): the live metagraph snapshot — sortable neuron
// table + stake distribution + validator-permit filter — with a per-UID
// drill-in detail card (snapshot + history) driven by the `?uid=` search param.
function MetagraphPanel({ netuid }: { netuid: number }) {
  const { uid } = useSearch({ from: "/subnets/$netuid" });
  const navigate = useNavigate({ from: "/subnets/$netuid" });

  const select = (next: number | null) =>
    navigate({
      to: ".",
      search: (prev: SearchParams) => ({ ...prev, uid: next ?? undefined }),
      replace: true,
    });

  return (
    <div className="space-y-6">
      {uid != null ? (
        <SectionAnchor
          id="neuron"
          title={`Neuron UID ${uid}`}
          subtitle="Live snapshot and per-UID on-chain history for the selected neuron."
          info="GET /api/v1/subnets/{netuid}/neurons/{uid} and /neurons/{uid}/history"
          tone="accent"
        >
          <AsyncPanel height="lg">
            <NeuronDetailCard netuid={netuid} uid={uid} onClose={() => select(null)} />
          </AsyncPanel>
          <div className="mt-4">
            <QueryErrorBoundary>
              <NeuronHistoryChart netuid={netuid} uid={uid} />
            </QueryErrorBoundary>
          </div>
        </SectionAnchor>
      ) : null}

      <SectionAnchor
        id="metagraph"
        title="Metagraph"
        subtitle="Live neuron snapshot — stake, emission, rank, trust, consensus, and validator permits."
        info="GET /api/v1/subnets/{netuid}/metagraph — the full neuron set from the latest metagraph snapshot. Select a UID to drill into its snapshot + history."
      >
        <AsyncPanel height="xl">
          <MetagraphTableLoader netuid={netuid} onSelect={(u) => select(u)} selectedUid={uid} />
        </AsyncPanel>
      </SectionAnchor>

      {/* #8247: folded in from the old standalone Validators tab -- both are
          neuron-set views over the same live snapshot, and this one already
          linked UID selection back into Metagraph. */}
      <SectionAnchor
        id="validators"
        title="Validators"
        subtitle="Active validator set ranked by stake — emission, trust, and consensus."
        info="GET /api/v1/subnets/{netuid}/validators — the permitted, stake-ranked validator set from the latest snapshot. Select a UID to drill into its detail above."
      >
        <ValidatorGuide />
        <AsyncPanel height="xl">
          <ValidatorsTableLoader netuid={netuid} selectedUid={uid} onSelect={(u) => select(u)} />
        </AsyncPanel>
        <AsyncPanel height="sm">
          <WeightsSummaryLoader netuid={netuid} />
        </AsyncPanel>
        <AsyncPanel height="lg">
          <WeightSettersLoader netuid={netuid} />
        </AsyncPanel>
      </SectionAnchor>

      <SectionAnchor
        id="concentration"
        title="Concentration"
        subtitle="Stake, emission, and reward distribution: Gini, HHI, Nakamoto coefficient, and top-percentile shares with daily drift."
        info="GET /api/v1/subnets/{netuid}/concentration and /performance (plus their /history) — how concentrated stake, emission, and rewards (incentive/dividends) are across neurons."
        tone="muted"
      >
        <QueryErrorBoundary>
          <DistributionPanel netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="yield"
        title="Yield"
        subtitle="Per-UID emission yield (emission ÷ stake return rate): distribution summary, validator/miner split, and the ranked neuron leaderboard with daily drift."
        info="GET /api/v1/subnets/{netuid}/yield and /yield/history — the return-rate twin of concentration, computed per-UID from the live neuron snapshot."
      >
        <AsyncPanel height="lg">
          <YieldLoader netuid={netuid} />
        </AsyncPanel>
      </SectionAnchor>

      <SectionAnchor
        id="turnover"
        title="Turnover"
        subtitle="Validator-set and registration churn: entered/exited validators, deregistered UIDs, retention, and a stability score across the window."
        info="GET /api/v1/subnets/{netuid}/turnover — diffs the window's start/end metagraph snapshots into a validator-set + registration-churn scorecard."
        tone="muted"
      >
        <AsyncPanel height="lg">
          <TurnoverLoader netuid={netuid} />
        </AsyncPanel>
      </SectionAnchor>

      {/* #8247: folded in from the old Overview -- daily neuron/validator
          counts, stake, and emission are metagraph-shaped time-series data,
          a sibling of concentration/yield/turnover above. */}
      <SectionAnchor
        id="history"
        title="Network history"
        subtitle="Daily on-chain neuron/validator counts, total stake, and emission over time."
        info="GET /api/v1/subnets/{netuid}/history"
      >
        <QueryErrorBoundary>
          <SubnetHistoryChart netuid={netuid} />
        </QueryErrorBoundary>
      </SectionAnchor>
    </div>
  );
}

// Top-validator stake distribution + leaderboard. Rows drill into the same
// per-UID neuron view (switches to the Metagraph tab where the detail renders).
// #3479: aggregate weight-setting activity for this subnet over the trailing
// 30-day window, from the already-shipped subnetWeightsQuery. A compact KPI strip
// (distinct setters / total weight-sets / average per setter) summarising the
// per-validator breakdown below; complements, and does not duplicate, that table.
function WeightsSummaryLoader({ netuid }: { netuid: number }) {
  const { data: res } = useSuspenseQuery(subnetWeightsQuery(netuid));
  const w = res.data;
  const cells = [
    { label: "Distinct setters", value: formatNumber(w?.distinct_setters) },
    { label: "Weight-sets (30d)", value: formatNumber(w?.weight_sets) },
    {
      label: "Avg per setter",
      value: w?.sets_per_setter != null ? w.sets_per_setter.toFixed(1) : formatNumber(null),
    },
  ];
  return (
    // #3939: stack to a single column below `sm`, matching the breakpoint
    // AccountWeightSettingSection (accounts.$ss58.tsx) already uses for its
    // sibling weight-setting KPI strip -- divide-y/divide-x swap with it so
    // the stacked cells still get a separator line at mobile.
    <Panel
      as="div"
      flush
      className="mb-4"
      bodyClassName="grid grid-cols-1 divide-y divide-border overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      {cells.map((c) => (
        <div key={c.label} className="px-4 py-3">
          <div className="mg-type-caption text-ink-muted">{c.label}</div>
          <div className="mt-0.5 font-mono text-lg tabular-nums text-ink-strong">{c.value}</div>
        </div>
      ))}
    </Panel>
  );
}

// #3480: per-validator weight-setting leaderboard for this subnet over the
// trailing 30-day window, from the already-shipped subnetWeightSettersQuery.
// The API returns the setters pre-ranked by weight-set count; we show the top
// slice as a compact table complementing the stake-ranked validator set above.
function WeightSettersLoader({ netuid }: { netuid: number }) {
  const { data: res } = useSuspenseQuery(subnetWeightSettersQuery(netuid));
  const d = res.data;
  if (!d || d.setter_count === 0) {
    return (
      <p className="mt-6 text-sm text-ink-muted">
        No weight-setting activity recorded for this subnet in the last 30 days.
      </p>
    );
  }
  const rows = d.setters.slice(0, 15);
  const windowLabel = d.window ?? "30d";
  return (
    <div className="mt-6 min-w-0" data-weight-setters-leaderboard>
      <Panel flush className="overflow-hidden">
        <div className="flex flex-nowrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="shrink-0 mg-type-caption text-ink-muted sm:hidden">Weight-setters</span>
          <span className="hidden shrink-0 mg-type-caption text-ink-muted sm:inline">
            Weight-setters · per-validator breakdown
          </span>
          <span className="shrink-0 mg-type-data-sm text-ink-muted whitespace-nowrap">
            {formatNumber(d.setter_count)} validators · {windowLabel}
          </span>
        </div>
        {/* ResponsiveTable: horizontal scroll + edge-fade shadows on narrow
            viewports (#3942), same treatment as list-page tables. */}
        <ResponsiveTable minWidth={280}>
          <table className="w-full text-sm">
            <thead className="bg-surface/50 text-ink-muted">
              <tr>
                <th className="mg-type-micro px-3 py-2.5 text-left">#</th>
                <th className="mg-type-micro px-3 py-2.5 text-left">Validator</th>
                <th className="mg-type-micro px-3 py-2.5 text-right">Weight sets</th>
                <th className="mg-type-micro px-3 py-2.5 text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((setter, i) => (
                <tr key={setter.uid ?? setter.hotkey ?? i} className="border-t border-border">
                  <td className="px-3 py-2.5 font-mono mg-type-caption tabular-nums text-ink-muted">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2.5 font-mono mg-type-caption tabular-nums text-ink-strong">
                    {setter.uid != null ? `UID ${setter.uid}` : "validator"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink-strong">
                    {formatNumber(setter.weight_sets)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink">
                    {setter.share != null ? `${(setter.share * 100).toFixed(1)}%` : "0%"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      </Panel>
    </div>
  );
}

function CandidatesPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="candidates"
      title="Candidates"
      subtitle="Unverified leads from public sources. Always labeled."
      info="Discovered automatically and not yet reviewed by a maintainer. Submit corrections via GitHub."
    >
      <div className="mb-2 rounded border border-dashed border-ink-subtle bg-paper px-3 py-2 text-[11px] text-ink-muted flex items-start gap-2">
        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
        <span>
          Candidates are discovered automatically and have not been verified by a maintainer. Submit
          corrections via the public repo.
        </span>
      </div>
      <AsyncPanel height="sm">
        <CandidatesList netuid={netuid} />
      </AsyncPanel>
    </SectionAnchor>
  );
}

function GapsPanel({ netuid, compact }: { netuid: number; compact?: boolean }) {
  // Mirror the seven sibling tabs on this page: wrap the fetch in
  // QueryErrorBoundary + Suspense so a genuine failure surfaces the shared
  // red-bordered ErrorState (with Retry), instead of reusing the success-case
  // EmptyState look for an error (#3961).
  return (
    <SectionAnchor
      id="gaps"
      title={compact ? "Known gaps" : "Gaps"}
      subtitle="Missing resources, profile incompleteness, and curation notes."
      info="GET /api/v1/subnets/{netuid}/gaps"
    >
      <AsyncPanel height="sm">
        <GapsList netuid={netuid} />
      </AsyncPanel>
    </SectionAnchor>
  );
}

function GapsList({ netuid }: { netuid: number }) {
  // Same query key/config as before, now via useSuspenseQuery so the enclosing
  // boundary handles error/loading — no duplicate cache entry.
  const { data: gapsResult } = useSuspenseQuery(subnetGapsQuery(netuid));
  const gaps = gapsResult?.data;
  const missing = gaps?.missing_kinds ?? [];
  const notes = gaps?.gap_notes ?? [];
  if (missing.length === 0 && notes.length === 0) {
    return (
      <EmptyState
        title="No outstanding gaps"
        description="Profile looks complete."
        action={RECOVERY.gaps}
      />
    );
  }
  return (
    <Panel dense bodyClassName="space-y-3">
      {missing.length > 0 ? (
        <div>
          <div className="mg-label mb-1">Missing kinds</div>
          <div className="flex flex-wrap gap-1">
            {missing.map((k) => (
              <span
                key={k}
                className="rounded border border-dashed border-ink-subtle bg-paper px-1.5 py-0.5 mg-type-data-sm text-ink-muted"
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <ul className="space-y-1 mg-type-caption text-ink leading-relaxed">
          {notes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      ) : null}
      <div className="border-t border-border pt-2 text-[11px] text-ink-muted">
        Help close these gaps by opening a PR against the public registry repo.
      </div>
    </Panel>
  );
}

function ApiPanel({ netuid }: { netuid: number }) {
  const rows = [
    { label: "profile", path: `/api/v1/subnets/${netuid}/profile` },
    { label: "surfaces", path: `/api/v1/subnets/${netuid}/surfaces` },
    { label: "endpoints", path: `/api/v1/subnets/${netuid}/endpoints` },
    { label: "candidates", path: `/api/v1/subnets/${netuid}/candidates` },
    { label: "gaps", path: `/api/v1/subnets/${netuid}/gaps` },
    {
      label: "hyperparameters-history",
      path: `/api/v1/subnets/${netuid}/hyperparameters/history`,
    },
    { label: "volume", path: `/api/v1/subnets/${netuid}/volume` },
    {
      label: "stake-quote",
      path: `/api/v1/subnets/${netuid}/stake-quote?amount=100&direction=stake`,
    },
    { label: "recycled", path: `/api/v1/subnets/${netuid}/recycled` },
    { label: "health", path: `/api/v1/subnets/${netuid}/health` },
    { label: "agent-catalog", path: `/api/v1/agent-catalog/${netuid}` },
    { label: "artifact", path: `/metagraph/subnets/${netuid}.json` },
  ];
  return (
    <SectionAnchor
      id="api"
      title="API & artifacts"
      subtitle="Canonical URLs powering this profile."
      info="Pick a language and copy a ready-to-run snippet for any endpoint. /api/v1 endpoints return enveloped responses; /metagraph/*.json returns artifacts."
    >
      <EndpointSnippet rows={rows} />
    </SectionAnchor>
  );
}

/* ----------------------------- schema list ----------------------------- */

/* ----------------------------- hyperparameters ----------------------------- */

function ratioStr(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(2)}%`;
}

function numStr(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? formatNumber(v) : v.toFixed(4);
}

function boolBadge(v: boolean) {
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded border px-1.5 py-0.5 mg-type-caption",
        v ? "border-accent/40 bg-accent-surface text-accent-text" : "border-border text-ink-muted",
      )}
    >
      {v ? "Yes" : "No"}
    </span>
  );
}

type HyperparamField = {
  key: keyof SubnetHyperparameters;
  label: string;
  format: (h: SubnetHyperparameters) => ReactNode;
};

const HYPERPARAM_GROUPS: { title: string; fields: HyperparamField[] }[] = [
  {
    title: "Registration & weights",
    fields: [
      {
        key: "registration_allowed",
        label: "Registration allowed",
        format: (h) => boolBadge(h.registration_allowed),
      },
      {
        key: "target_regs_per_interval",
        label: "Target regs / interval",
        format: (h) => numStr(h.target_regs_per_interval),
      },
      {
        key: "max_regs_per_block",
        label: "Max regs / block",
        format: (h) => numStr(h.max_regs_per_block),
      },
      {
        key: "immunity_period",
        label: "Immunity period",
        format: (h) => `${numStr(h.immunity_period)} blocks`,
      },
      {
        key: "min_allowed_weights",
        label: "Min allowed weights",
        format: (h) => numStr(h.min_allowed_weights),
      },
      {
        key: "max_weight_limit_ratio",
        label: "Max weight limit",
        format: (h) => ratioStr(h.max_weight_limit_ratio),
      },
      {
        key: "weights_version",
        label: "Weights version",
        format: (h) => numStr(h.weights_version),
      },
      {
        key: "weights_rate_limit",
        label: "Weights rate limit",
        format: (h) => `${numStr(h.weights_rate_limit)} blocks`,
      },
      { key: "tempo", label: "Tempo", format: (h) => `${numStr(h.tempo)} blocks` },
      {
        key: "activity_cutoff",
        label: "Activity cutoff",
        format: (h) => `${numStr(h.activity_cutoff)} blocks`,
      },
      {
        key: "activity_cutoff_factor",
        label: "Activity cutoff factor",
        format: (h) => numStr(h.activity_cutoff_factor),
      },
      {
        key: "serving_rate_limit",
        label: "Serving rate limit",
        format: (h) => `${numStr(h.serving_rate_limit)} blocks`,
      },
      { key: "max_validators", label: "Max validators", format: (h) => numStr(h.max_validators) },
    ],
  },
  {
    title: "Burn & economics",
    fields: [
      { key: "min_burn_tao", label: "Min burn", format: (h) => taoCompact(h.min_burn_tao) },
      { key: "max_burn_tao", label: "Max burn", format: (h) => taoCompact(h.max_burn_tao) },
      {
        key: "burn_half_life",
        label: "Burn half-life",
        format: (h) => `${numStr(h.burn_half_life)} blocks`,
      },
      {
        key: "burn_increase_mult",
        label: "Burn increase multiplier",
        format: (h) => numStr(h.burn_increase_mult),
      },
      { key: "kappa_ratio", label: "Kappa", format: (h) => ratioStr(h.kappa_ratio) },
      {
        key: "bonds_moving_avg_raw",
        label: "Bonds moving avg (raw)",
        format: (h) => numStr(h.bonds_moving_avg_raw),
      },
    ],
  },
  {
    title: "Commit-reveal & alpha",
    fields: [
      {
        key: "commit_reveal_enabled",
        label: "Commit-reveal enabled",
        format: (h) => boolBadge(h.commit_reveal_enabled),
      },
      {
        key: "commit_reveal_period",
        label: "Commit-reveal period",
        format: (h) => numStr(h.commit_reveal_period),
      },
      {
        key: "liquid_alpha_enabled",
        label: "Liquid alpha enabled",
        format: (h) => boolBadge(h.liquid_alpha_enabled),
      },
      { key: "alpha_high_ratio", label: "Alpha high", format: (h) => ratioStr(h.alpha_high_ratio) },
      { key: "alpha_low_ratio", label: "Alpha low", format: (h) => ratioStr(h.alpha_low_ratio) },
      {
        key: "alpha_sigmoid_steepness",
        label: "Alpha sigmoid steepness",
        format: (h) => numStr(h.alpha_sigmoid_steepness),
      },
      { key: "yuma_version", label: "Yuma version", format: (h) => numStr(h.yuma_version) },
    ],
  },
  {
    title: "Network & ownership",
    fields: [
      {
        key: "subnet_is_active",
        label: "Subnet active",
        format: (h) => boolBadge(h.subnet_is_active),
      },
      {
        key: "transfers_enabled",
        label: "Transfers enabled",
        format: (h) => boolBadge(h.transfers_enabled),
      },
      {
        key: "bonds_reset_enabled",
        label: "Bonds reset enabled",
        format: (h) => boolBadge(h.bonds_reset_enabled),
      },
      {
        key: "user_liquidity_enabled",
        label: "User liquidity enabled",
        format: (h) => boolBadge(h.user_liquidity_enabled),
      },
      {
        key: "owner_cut_enabled",
        label: "Owner cut enabled",
        format: (h) => boolBadge(h.owner_cut_enabled),
      },
      {
        key: "owner_cut_auto_lock_enabled",
        label: "Owner cut auto-lock",
        format: (h) => boolBadge(h.owner_cut_auto_lock_enabled),
      },
      {
        key: "min_childkey_take_ratio",
        label: "Min childkey take",
        format: (h) => ratioStr(h.min_childkey_take_ratio),
      },
    ],
  },
];

function HyperparametersPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="hyperparameters"
      title="Hyperparameters"
      subtitle="Consensus, economic, and governance settings for this subnet."
      info="GET /api/v1/subnets/{netuid}/hyperparameters — refreshed daily from the subnet_hyperparams D1 tier."
    >
      <AsyncPanel height="xl">
        <HyperparametersTable netuid={netuid} />
      </AsyncPanel>
    </SectionAnchor>
  );
}

function HyperparametersTable({ netuid }: { netuid: number }) {
  const { data: res } = useSuspenseQuery(subnetHyperparametersQuery(netuid));
  const h = res.data.hyperparameters;

  if (!h) {
    return (
      <EmptyState
        title="No hyperparameters captured yet"
        description="The refresh-subnet-hyperparams cron fills this in daily — check back shortly."
      />
    );
  }

  return (
    <div className="space-y-6">
      {res.data.captured_at ? (
        <p className="mg-type-data text-ink-muted">
          Captured <TimeAgo at={res.data.captured_at} />
          {res.data.block_number != null ? ` · block #${formatNumber(res.data.block_number)}` : ""}
        </p>
      ) : null}
      <HyperparamGroupsTable h={h} />
    </div>
  );
}

// Shared full-detail render for one hyperparameter snapshot — used both for
// the current-value table above and each expanded entry in the change-history
// timeline below, since both are the same 33-field SubnetHyperparameters shape.
function HyperparamGroupsTable({ h }: { h: SubnetHyperparameters }) {
  return (
    <div className="space-y-6">
      {HYPERPARAM_GROUPS.map((group) => (
        <Panel as="div" flush key={group.title}>
          <div className="border-b border-border px-4 py-2.5">
            <h3 className="font-display text-sm font-semibold text-ink-strong">{group.title}</h3>
          </div>
          <div className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
            {group.fields.map((field) => (
              <div key={field.key} className="px-4 py-2.5">
                <div className="mg-type-caption text-ink-muted">{field.label}</div>
                <div className="mt-1 font-mono mg-type-caption-lg text-ink-strong">
                  {field.format(h)}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

/* ----------------------------- hyperparameters history ----------------------------- */

function HyperparamsHistoryPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="hyperparameters-history"
      title="Hyperparameter history"
      subtitle="Every recorded change to this subnet's consensus, economic, and governance settings, newest first."
      info="GET /api/v1/subnets/{netuid}/hyperparameters/history — an append-only timeline of full hyperparameter snapshots, one entry per detected change. Forward-only: rows only exist from when this tier started tracking, so an established subnet may show fewer entries than its full history."
    >
      <AsyncPanel height="xl">
        <HyperparamsHistoryList netuid={netuid} />
      </AsyncPanel>
    </SectionAnchor>
  );
}

function HyperparamsHistoryList({ netuid }: { netuid: number }) {
  const { data: res } = useSuspenseQuery(subnetHyperparamsHistoryQuery(netuid));
  const entries = res.data.entries;
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No hyperparameter history yet"
        description="This subnet has no recorded hyperparameter changes since this tier started tracking."
      />
    );
  }

  return (
    <ol className="space-y-2">
      {entries.map((entry) => {
        const expanded = expandedHash === entry.hyperparams_hash;
        return (
          <li key={entry.hyperparams_hash} className="rounded-md border border-border bg-card p-3">
            <button
              type="button"
              onClick={() => setExpandedHash(expanded ? null : entry.hyperparams_hash)}
              aria-expanded={expanded}
              className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left"
            >
              <span className="inline-flex items-center gap-1.5 font-display text-sm font-semibold text-ink-strong">
                <ChevronDown
                  aria-hidden
                  className={classNames(
                    "size-3.5 text-ink-muted transition-transform",
                    expanded ? "rotate-180" : "",
                  )}
                />
                {entry.observed_at ? <TimeAgo at={entry.observed_at} /> : "unknown time"}
              </span>
              <span className="mg-type-data text-ink-muted">
                {entry.block_number != null ? `block #${formatNumber(entry.block_number)} · ` : ""}
                {entry.hyperparams_hash.slice(0, 10)}
              </span>
            </button>
            {expanded && entry.hyperparameters ? (
              <div className="mt-3">
                <HyperparamGroupsTable h={entry.hyperparameters} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ----------------------------- candidates list ----------------------------- */

function CandidatesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetCandidatesQuery(netuid));
  const meta = data.meta;
  const rows = (data.data ?? []) as Candidate[];
  if (rows.length === 0)
    return (
      <EmptyState
        title="No candidate leads"
        description="Submit corrections via the public repo."
        lastChecked={meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-2">
      {rows.map((c) => (
        <li key={c.id} className="rounded-md border border-dashed border-ink-subtle bg-paper p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <CandidateChip />
                <span className="mg-type-data-sm uppercase text-ink-muted">{c.kind ?? "lead"}</span>
                {(c as Record<string, unknown>).provider ? (
                  <span className="mg-type-data-sm text-ink-muted">
                    via {(c as Record<string, unknown>).provider as string}
                  </span>
                ) : null}
              </div>
              {c.url ? (
                <ExternalLink href={c.url} className="mt-1 text-xs">
                  {c.url}
                </ExternalLink>
              ) : null}
              {c.notes ? (
                <p className="mt-1 text-xs text-ink-muted leading-relaxed">{c.notes}</p>
              ) : null}
            </div>
            <span className="mg-type-data-sm text-ink-muted shrink-0">
              <TimeAgo at={c.discovered_at} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
