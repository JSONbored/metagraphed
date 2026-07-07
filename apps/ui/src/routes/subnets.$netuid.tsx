import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CandidateChip, CurationChip, ReviewChip } from "@/components/metagraphed/chips";
import { ExternalLink } from "@/components/metagraphed/external-link";
import {
  EmptyState,
  PageHeading,
  Skeleton,
  StaleBanner,
  RECOVERY,
} from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { SchemaDriftSummary } from "@/components/metagraphed/schema-drift";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { ReadinessScorecard } from "@/components/metagraphed/readiness-scorecard";
import { EndpointList } from "@/components/metagraphed/endpoint-list";
import { SurfaceFixture } from "@/components/metagraphed/surface-fixture";
import { VerifySurfaceButton } from "@/components/metagraphed/verify-surface-button";
import { ReliabilityPanel } from "@/components/metagraphed/reliability-panel";
import { EconomicsPanel } from "@/components/metagraphed/economics-panel";
import { EndpointSnippet, apiSnippet } from "@/components/metagraphed/endpoint-snippet";
import { SubnetHistoryChart } from "@/components/metagraphed/subnet-history-chart";
import { MetagraphTableLoader } from "@/components/metagraphed/metagraph-panel";
import { ValidatorsTableLoader } from "@/components/metagraphed/validators-panel";
import { DistributionPanel } from "@/components/metagraphed/concentration-panel";
import { YieldLoader } from "@/components/metagraphed/yield-panel";
import { NeuronDetailCard } from "@/components/metagraphed/neuron-detail-card";
import { NeuronHistoryChart } from "@/components/metagraphed/neuron-history-chart";
import { useHashScroll } from "@/components/metagraphed/use-hash-scroll";
import {
  subnetProfileQuery,
  subnetSurfacesQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetCandidatesQuery,
  subnetEventsQuery,
  subnetGapsQuery,
  fixturesIndexQuery,
  lineageQuery,
  agentCatalogDetailQuery,
  subnetWeightSettersQuery,
} from "@/lib/metagraphed/queries";
import { isStaleFreshness, formatNumber, classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { TableState } from "@/components/metagraphed/table-state";
import type {
  AccountEvent,
  Endpoint,
  Surface,
  Candidate,
  SubnetProfile,
  FixtureIndexEntry,
  AgentCatalogService,
  AgentCatalogBlocker,
} from "@/lib/metagraphed/types";
import { HealthPill } from "@/components/metagraphed/chips";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { IncidentTimeline } from "@/components/metagraphed/incident-timeline";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { SubnetMasthead } from "@/components/metagraphed/subnet-masthead";
import { OperationalPanel } from "@/components/metagraphed/operational-panel";
import { ResourceExplorer } from "@/components/metagraphed/resource-explorer";
import { SubnetProfilePanel } from "@/components/metagraphed/subnet-profile-panel";
import { SubnetPulseStrip } from "@/components/metagraphed/subnet-pulse-strip";
import { SubnetFilterProvider } from "@/components/metagraphed/subnet-filter-context";
import { MethodologyCallout } from "@/components/metagraphed/methodology-callout";
import { SubnetCompareDrawer } from "@/components/metagraphed/subnet-compare-drawer";

type SearchParams = {
  tab?: string;
  sev?: string;
  uid?: number;
};

export const Route = createFileRoute("/subnets/$netuid")({
  validateSearch: (s: Record<string, unknown>): SearchParams => {
    const uidNum = Number(s.uid);
    return {
      tab: typeof s.tab === "string" ? s.tab : undefined,
      sev: typeof s.sev === "string" ? s.sev : undefined,
      uid: Number.isInteger(uidNum) && uidNum >= 0 ? uidNum : undefined,
    };
  },
  parseParams: ({ netuid }) => {
    const n = Number(netuid);
    if (!Number.isFinite(n) || n < 0) throw notFound();
    return { netuid: n };
  },
  stringifyParams: ({ netuid }) => ({ netuid: String(netuid) }),
  // Prime the same query the page uses (shared cache → no double fetch) so head()
  // can build a richer OG/social card from the live subnet name + health. Non-
  // fatal: any failure returns null, head() falls back to the netuid-only copy,
  // and the page's own useSuspenseQuery still drives the error/notFound path.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(subnetProfileQuery(params.netuid));
      return { name: data.name ?? null, health: data.health ?? null };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    const title = loaderData?.name
      ? `${loaderData.name} (Subnet ${params.netuid}) — Metagraphed`
      : `Subnet ${params.netuid} — Metagraphed`;
    const health = loaderData?.health && loaderData.health !== "unknown" ? loaderData.health : null;
    const description = loaderData?.name
      ? `${loaderData.name}: Bittensor subnet ${params.netuid} — interfaces, endpoints, schemas${
          health ? ` and live health (${health})` : ""
        }, machine-readable on Metagraphed.`
      : `Public-interface registry for Bittensor subnet ${params.netuid}: surfaces, endpoints, schemas, health.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: SubnetDetailPage,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        title="Subnet not found"
        description="No active Finney netuid matches this URL."
      />
      <Link to="/subnets" className="text-sm underline">
        Back to registry
      </Link>
    </AppShell>
  ),
});

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "metagraph", label: "Metagraph" },
  { id: "validators", label: "Validators" },
  { id: "activity", label: "Activity" },
  { id: "services", label: "Callable services" },
  { id: "surfaces", label: "Surfaces" },
  { id: "endpoints", label: "Endpoints" },
  { id: "schemas", label: "Schemas" },
  { id: "candidates", label: "Candidates" },
  { id: "gaps", label: "Gaps" },
  { id: "evidence", label: "Evidence" },
  { id: "api", label: "API" },
] as const;

// Which tab does each section anchor live under? Drives cross-tab deep links.
const SECTION_TO_TAB: Record<string, string> = {
  "endpoints-glance": "overview",
  "health-trends": "overview",
  incidents: "overview",
  economics: "overview",
  reliability: "overview",
  lineage: "overview",
  evidence: "overview",
  metagraph: "metagraph",
  neuron: "metagraph",
  concentration: "metagraph",
  yield: "metagraph",
  validators: "validators",
  services: "services",
  "agent-readiness": "services",
  surfaces: "surfaces",
  endpoints: "endpoints",
  "schema-drift": "schemas",
  candidates: "candidates",
  gaps: "gaps",
  api: "api",
};

function SubnetDetailPage() {
  const { netuid } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <ProfileShell netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function ProfileShell({ netuid }: { netuid: number }) {
  const { data: profile, meta } = useSuspenseQuery(subnetProfileQuery(netuid)).data;
  const { data: gapsResult } = useQuery(subnetGapsQuery(netuid));
  const subnetGaps = gapsResult?.data;
  const stale = meta?.stale || isStaleFreshness(meta?.generated_at);
  const tab = useActiveTab("overview");
  useHashScroll(tab, SECTION_TO_TAB);

  const gapsCount = subnetGaps?.missing_kinds.length ?? profile?.missing_kinds?.length ?? 0;
  const tabsWithCounts = TABS.map((t) => {
    if (t.id === "surfaces") return { ...t, count: profile?.surface_count };
    if (t.id === "endpoints") return { ...t, count: profile?.endpoint_count };
    if (t.id === "candidates") return { ...t, count: profile?.candidate_count };
    if (t.id === "gaps") return { ...t, count: gapsCount || undefined };
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
      <SubnetFilterProvider>
        <SubnetMasthead
          netuid={netuid}
          profile={profile}
          generatedAt={meta?.generated_at}
          stale={stale}
          evidenceCount={evidenceCount}
          banner={
            stale ? (
              <StaleBanner
                generatedAt={meta?.generated_at}
                refreshQueryKeys={[
                  subnetProfileQuery(netuid).queryKey,
                  subnetSurfacesQuery(netuid).queryKey,
                  subnetEndpointsQuery(netuid).queryKey,
                  subnetHealthQuery(netuid).queryKey,
                  subnetCandidatesQuery(netuid).queryKey,
                ]}
                refreshLabel="Refresh health now"
              />
            ) : null
          }
        />

        <SubnetPulseStrip netuid={netuid} />

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <SubnetCompareDrawer netuid={netuid} />
        </div>

        <div className="mt-4">
          <MethodologyCallout generatedAt={meta?.generated_at} windowLabel="7d" />
        </div>

        <div className="mt-2">
          <ProfileTabs tabs={tabsWithCounts} defaultTab="overview" />
        </div>

        <div className="mt-6 min-w-0 space-y-8">
          {tab === "overview" ? <OverviewPanel netuid={netuid} profile={profile} /> : null}
          {tab === "metagraph" ? <MetagraphPanel netuid={netuid} /> : null}
          {tab === "validators" ? <ValidatorsPanel netuid={netuid} /> : null}
          {tab === "activity" ? <ActivityPanel netuid={netuid} /> : null}
          {tab === "services" ? <CallableServicesPanel netuid={netuid} /> : null}
          {tab === "surfaces" ? <SurfacesPanel netuid={netuid} /> : null}
          {tab === "endpoints" ? <EndpointsPanel netuid={netuid} /> : null}
          {tab === "schemas" ? <SchemasPanel netuid={netuid} /> : null}
          {tab === "candidates" ? <CandidatesPanel netuid={netuid} /> : null}
          {tab === "gaps" ? <GapsPanel netuid={netuid} /> : null}
          {tab === "evidence" ? (
            <SectionAnchor
              id="evidence"
              title="Evidence & sources"
              subtitle="Every claim should be traceable."
              info="Source URLs and timestamps for verified registry entries."
            >
              <EvidencePanel netuid={netuid} />
            </SectionAnchor>
          ) : null}
          {tab === "api" ? <ApiPanel netuid={netuid} /> : null}
        </div>
      </SubnetFilterProvider>
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

// Single-column slab overview (Lovable redesign), with the UI's wired
// KEEP-OURS panels re-homed into the new layout:
//   1 — Readiness scorecard (#369, dropped by Lovable, restored here)
//   2 — Operational status (timeline + ribbon + incidents)
//   3 — Public resources (segmented endpoints/surfaces/schemas)
//   4 — Subnet profile (lineage + economics + ownership + curation)
//   5 — Economics (live chain economics — UI's wired EconomicsPanel)
//   6 — Reliability (per-surface SLA + latency percentiles — kept)
//   7 — Cross-network lineage (UI's section, reads lineage.links — kept)
//   8 — Sources & evidence (UI's EvidencePanel, NOT evidence-clusters)
//   9 — Open incidents (deep-linkable timeline)
function OverviewPanel({ netuid, profile }: { netuid: number; profile?: SubnetProfile }) {
  const { data: gapsResult } = useQuery(subnetGapsQuery(netuid));
  const subnetGaps = gapsResult?.data;
  return (
    <div className="space-y-6">
      {/* 1 — Readiness scorecard: the "can I build on this, where do I start?"
          answer, up top before the operational/resource detail. */}
      <ReadinessScorecard profile={profile} />

      {/* 2 — Operational status (timeline + ribbon + incidents) */}
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <OperationalPanel netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>

      {/* 3 — Public resources (segmented endpoints/surfaces/schemas) */}
      <QueryErrorBoundary>
        <ResourceExplorer netuid={netuid} />
      </QueryErrorBoundary>

      {/* 4 — Subnet profile (lineage + economics + ownership + curation) */}
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <SubnetProfilePanel netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>

      {/* 5 — Live chain economics (#1112) — UI's wired EconomicsPanel. */}
      <SectionAnchor
        id="economics"
        title="Economics"
        subtitle="On-chain emission share, stake, validators, and market data."
        info="Live chain economics from the Bittensor metagraph — emission share, alpha price, stake, validator/miner counts, and subnet volume."
      >
        <EconomicsPanel netuid={netuid} />
      </SectionAnchor>

      {/* 5b — On-chain network history (#1302): daily neuron/validator counts,
          total stake + emission over a selectable window. Optional detail —
          renders an empty-state until chain history accumulates. */}
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

      {/* 6 — Per-surface reliability (#1114): uptime SLA + latency percentiles. */}
      <SectionAnchor
        id="reliability"
        title="Reliability"
        subtitle="Per-surface uptime SLA and latency percentiles (p50/p95/p99) over 7d/30d."
        info="Live from the 2-minute health prober's D1 history: uptime ratio, reconstructed downtime incidents, and latency distribution per operational surface."
      >
        <ReliabilityPanel netuid={netuid} />
      </SectionAnchor>

      {/* 7 — Cross-network lineage (#1113): renders only when paired. */}
      <SubnetLineageSection netuid={netuid} />

      {/* 8 — Sources & evidence — UI's wired EvidencePanel (NOT evidence-clusters). */}
      <SectionAnchor
        id="evidence"
        title="Sources & evidence"
        subtitle="Primary links and recorded evidence backing this profile."
        info="GET /api/v1/evidence"
        tone="muted"
      >
        <EvidencePanel netuid={netuid} />
      </SectionAnchor>

      {/* 9 — Open incidents (deep-linkable, lower-density context) */}
      <QueryErrorBoundary>
        <IncidentTimeline netuid={netuid} />
      </QueryErrorBoundary>

      {(subnetGaps?.missing_kinds.length ?? 0) > 0 ||
      (subnetGaps?.gap_notes.length ?? 0) > 0 ||
      (profile?.gap_notes?.length ?? 0) > 0 ? (
        <GapsPanel netuid={netuid} compact />
      ) : null}
    </div>
  );
}

// #1113: cross-network lineage. Non-blocking (useQuery, shared cache across all
// subnet pages); renders nothing unless this netuid is paired with a counterpart.
// Reads lineageRes.data.links (NOT a top-level array).
function SubnetLineageSection({ netuid }: { netuid: number }) {
  const { data: lineageRes } = useQuery(lineageQuery());
  const lineage = lineageRes?.data;
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
      <section className="rounded-lg border border-border bg-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="mg-label">{counterpartNetwork} counterpart</span>
          <span className="font-display text-sm font-semibold text-ink-strong">
            {counterpartName ?? `Subnet ${counterpartNetuid}`}
          </span>
          <span className="font-mono text-xs text-ink-muted">#{counterpartNetuid}</span>
        </div>
        {matchedBy ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-mono text-ink-muted">
            matched by {matchedBy}
          </span>
        ) : null}
      </section>
    </SectionAnchor>
  );
}

/* ----------------------------- panels ----------------------------- */

function SurfacesPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="surfaces"
      title="Verified surfaces"
      subtitle="Curated public interfaces with provenance."
      info="Only surfaces that have been verified appear here. Unverified leads live in the Candidates tab."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <SurfacesList netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

// On-chain activity stream (#1345): first-party SubtensorModule events for this
// subnet, decoded direct from finney and served from /api/v1/subnets/{netuid}/events.
function ActivityPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="activity"
      title="On-chain activity"
      subtitle="First-party chain events for this subnet, newest first."
      info="Registrations, stake, weights, axon, delegation, lifecycle, and transfers decoded directly from finney System.Events for recent finalized blocks (the rolling first-party event window) — not Taostats."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <ActivityTableLoader netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

function ActivityTableLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetEventsQuery(netuid));
  const events = (data.data.events ?? []) as AccountEvent[];
  if (events.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No recent on-chain activity"
        description="No first-party chain events are indexed for this subnet in the current window — a quiet or newly-added subnet may have none yet. Registrations, stake, weights, delegation, and transfers will appear here as they're decoded."
        generatedAt={data.meta?.generated_at}
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface/40">
          <tr>
            <th className="px-4 py-2.5">Block</th>
            <th className="px-4 py-2.5">Kind</th>
            <th className="px-4 py-2.5">Hotkey</th>
            <th className="px-4 py-2.5 text-right">Amount</th>
            <th className="px-4 py-2.5 text-right">Observed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {events.map((ev, i) => (
            <tr key={`${ev.block_number}-${ev.event_index}-${i}`} className="hover:bg-surface/40">
              <td className="px-4 py-2.5 font-mono text-[12px]">
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
              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
                {ev.event_kind ?? "—"}
              </td>
              <td className="px-4 py-2.5 font-mono text-[11px]">
                {ev.hotkey ? (
                  <Link
                    to="/accounts/$ss58"
                    params={{ ss58: ev.hotkey }}
                    className="text-ink-muted hover:text-ink hover:underline"
                  >
                    {shortHash(ev.hotkey) ?? ev.hotkey}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
                {ev.amount_tao != null ? `${formatNumber(ev.amount_tao)} τ` : "—"}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                <TimeAgo at={ev.observed_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <CallableServicesList netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
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
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="mg-label">Integration readiness</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-semibold tabular-nums text-ink-strong">
              {score != null ? score : "—"}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">/ 100</span>
          </div>
        </div>
        {tier ? (
          <span
            className={classNames(
              "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest",
              tone,
            )}
          >
            {tier}
          </span>
        ) : null}
        {status ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {status}
          </span>
        ) : null}
      </div>
      {blockers.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mg-label mb-1.5">What's blocking buildability</div>
          <ul className="space-y-1.5">
            {blockers.map((b, i) => (
              <li key={b.code ?? i} className="text-[12px] leading-relaxed text-ink">
                <span className="font-medium text-ink-strong">{b.message ?? b.code}</span>
                {b.next_action ? <span className="text-ink-muted"> — {b.next_action}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ServiceCard({ service }: { service: AgentCatalogService }) {
  const callable = service.eligibility?.callable;
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded border border-accent/40 bg-primary-soft px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accent-text">
          {service.kind ?? "service"}
        </span>
        <span className="font-medium text-ink-strong truncate">
          {service.capability ?? service.surface_id ?? "Service"}
        </span>
        {service.provider ? (
          <span className="font-mono text-[10px] text-ink-muted">{service.provider}</span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-2">
          <span
            className={classNames(
              "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest",
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

      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] text-ink-muted">
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
  const { uid } = Route.useSearch();
  const navigate = Route.useNavigate();

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
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <NeuronDetailCard netuid={netuid} uid={uid} onClose={() => select(null)} />
            </Suspense>
          </QueryErrorBoundary>
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
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <MetagraphTableLoader netuid={netuid} onSelect={(u) => select(u)} selectedUid={uid} />
          </Suspense>
        </QueryErrorBoundary>
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
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <YieldLoader netuid={netuid} />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>
    </div>
  );
}

// Top-validator stake distribution + leaderboard. Rows drill into the same
// per-UID neuron view (switches to the Metagraph tab where the detail renders).
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
  return (
    <div className="mt-6">
      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-ink-muted">
        Weight-setters (30d): {formatNumber(d.distinct_setters)} validators,{" "}
        {formatNumber(d.weight_sets)} sets
      </h3>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/50 text-ink-muted">
              <tr>
                <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                  #
                </th>
                <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                  Validator
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Weight sets
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((setter, i) => (
                <tr key={setter.uid ?? setter.hotkey ?? i} className="border-t border-border">
                  <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink-muted">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink-strong">
                    {setter.uid != null ? `UID ${setter.uid}` : "validator"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                    {formatNumber(setter.weight_sets)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                    {setter.share != null ? `${(setter.share * 100).toFixed(1)}%` : "0%"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ValidatorsPanel({ netuid }: { netuid: number }) {
  const { uid } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <SectionAnchor
      id="validators"
      title="Validators"
      subtitle="Active validator set ranked by stake — emission, trust, and consensus."
      info="GET /api/v1/subnets/{netuid}/validators — the permitted, stake-ranked validator set from the latest snapshot. Select a UID to open it in the Metagraph tab."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <ValidatorsTableLoader
            netuid={netuid}
            selectedUid={uid}
            onSelect={(u) =>
              navigate({
                to: ".",
                search: (prev: SearchParams) => ({ ...prev, tab: "metagraph", uid: u }),
                replace: true,
              })
            }
          />
        </Suspense>
      </QueryErrorBoundary>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <WeightSettersLoader netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

function EndpointsPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="endpoints"
      title="Endpoints"
      subtitle="Probe-derived health, latency, and freshness."
      info="Each endpoint is probed periodically. Health and latency reflect the most recent probe."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <EndpointsTableLoader netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

function EndpointsTableLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetEndpointsQuery(netuid));
  const meta = data.meta;
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No endpoints recorded"
        description="This subnet has no tracked endpoints yet — public RPC, WSS, SSE, and data streams will appear here once registered."
        generatedAt={meta?.generated_at}
        cta={{ label: "Browse all endpoints", href: "/endpoints" }}
      />
    );
  }
  return <EndpointList rows={rows} showProvider />;
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
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <CandidatesList netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

function GapsPanel({ netuid, compact }: { netuid: number; compact?: boolean }) {
  const { data: gapsResult, isLoading, error } = useQuery(subnetGapsQuery(netuid));
  const gaps = gapsResult?.data;
  const missing = gaps?.missing_kinds ?? [];
  const notes = gaps?.gap_notes ?? [];
  if (isLoading) {
    return (
      <SectionAnchor id="gaps" title={compact ? "Known gaps" : "Gaps"}>
        <Skeleton className="h-24 w-full" />
      </SectionAnchor>
    );
  }
  if (error) {
    return (
      <SectionAnchor id="gaps" title={compact ? "Known gaps" : "Gaps"}>
        <EmptyState
          title="Gaps unavailable"
          description="The subnet gaps endpoint did not respond."
          action={RECOVERY.gaps}
        />
      </SectionAnchor>
    );
  }
  if (missing.length === 0 && notes.length === 0) {
    return (
      <SectionAnchor id="gaps" title="Gaps">
        <EmptyState
          title="No outstanding gaps"
          description="Profile looks complete."
          action={RECOVERY.gaps}
        />
      </SectionAnchor>
    );
  }
  return (
    <SectionAnchor
      id="gaps"
      title={compact ? "Known gaps" : "Gaps"}
      subtitle="Missing resources, profile incompleteness, and curation notes."
      info="GET /api/v1/subnets/{netuid}/gaps"
    >
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        {missing.length > 0 ? (
          <div>
            <div className="mg-label mb-1">Missing kinds</div>
            <div className="flex flex-wrap gap-1">
              {missing.map((k) => (
                <span
                  key={k}
                  className="rounded border border-dashed border-ink-subtle bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {notes.length > 0 ? (
          <ul className="space-y-1 text-[12px] text-ink leading-relaxed">
            {notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        ) : null}
        <div className="border-t border-border pt-2 text-[11px] text-ink-muted">
          Help close these gaps by opening a PR against the public registry repo.
        </div>
      </div>
    </SectionAnchor>
  );
}

function ApiPanel({ netuid }: { netuid: number }) {
  const rows = [
    { label: "profile", path: `/api/v1/subnets/${netuid}/profile` },
    { label: "surfaces", path: `/api/v1/subnets/${netuid}/surfaces` },
    { label: "endpoints", path: `/api/v1/subnets/${netuid}/endpoints` },
    { label: "candidates", path: `/api/v1/subnets/${netuid}/candidates` },
    { label: "gaps", path: `/api/v1/subnets/${netuid}/gaps` },
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

function SchemasPanel({ netuid }: { netuid: number }) {
  return (
    <SectionAnchor
      id="schema-drift"
      title="Schemas & drift"
      subtitle="OpenAPI/JSON Schema snapshots joined from /api/v1/schemas, with hash diffs."
      info="Drift means the latest schema hash differs from the previous one — review for breaking changes."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <SchemaDriftSummary netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

/* ----------------------------- surfaces list (tab view) ----------------------------- */

function SurfacesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetSurfacesQuery(netuid));
  // #748: join surfaces with the fixtures index so a card can show a real
  // captured request/response sample.
  const { data: fixturesRes } = useQuery(fixturesIndexQuery());
  const fixtureMap = new Map<string, FixtureIndexEntry>(
    (fixturesRes?.data ?? []).map((f) => [f.surface_id, f]),
  );
  const meta = data.meta;
  const rows = (data.data ?? []) as Surface[];
  if (rows.length === 0)
    return (
      <EmptyState
        title="No verified surfaces yet"
        description="Candidates may exist — check the Candidates tab."
        lastChecked={meta?.generated_at}
        action={RECOVERY.surfaces}
      />
    );

  const groups = new Map<string, Surface[]>();
  for (const s of rows) {
    const kk = s.kind ?? "other";
    const arr = groups.get(kk) ?? [];
    arr.push(s);
    groups.set(kk, arr);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="space-y-4">
      {ordered.map(([kind, items]) => (
        <div key={kind}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="mg-label">{kind}</span>
            <span className="font-mono text-[10px] text-ink-muted">{items.length}</span>
          </div>
          <ul className="space-y-2">
            {items.map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-card p-3 mg-row-hover">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-strong">{s.name ?? s.url}</span>
                      <CurationChip level={s.curation_level} />
                      <ReviewChip state={s.review?.state} />
                      {s.provider ? (
                        <Link
                          to="/providers/$slug"
                          params={{ slug: s.provider }}
                          className="font-mono text-[10px] text-ink-muted hover:text-ink-strong"
                        >
                          {s.provider}
                        </Link>
                      ) : null}
                    </div>
                    {s.url ? (
                      <ExternalLink
                        href={s.url}
                        authRequired={s.auth_required}
                        publicSafe={s.public_safe ?? true}
                        className="mt-0.5 text-xs"
                      >
                        {s.url}
                      </ExternalLink>
                    ) : null}
                  </div>
                  <span className="font-mono text-[10px] text-ink-muted shrink-0">
                    <TimeAgo at={s.updated_at} />
                  </span>
                </div>
                <div className="mt-2 border-t border-border pt-2">
                  <VerifySurfaceButton surfaceId={s.id} />
                </div>
                {fixtureMap.has(s.id) ? (
                  <SurfaceFixture surfaceId={s.id} entry={fixtureMap.get(s.id)!} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
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
        <li key={c.id} className="rounded-lg border border-dashed border-ink-subtle bg-paper p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <CandidateChip />
                <span className="font-mono text-[10px] uppercase text-ink-muted">
                  {c.kind ?? "lead"}
                </span>
                {(c as Record<string, unknown>).provider ? (
                  <span className="font-mono text-[10px] text-ink-muted">
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
            <span className="font-mono text-[10px] text-ink-muted shrink-0">
              <TimeAgo at={c.discovered_at} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
