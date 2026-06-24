import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CandidateChip, CurationChip, ReviewChip } from "@/components/metagraphed/chips";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
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
import { SubnetHistoryChart } from "@/components/metagraphed/subnet-history-chart";
import { useHashScroll } from "@/components/metagraphed/use-hash-scroll";
import {
  subnetProfileQuery,
  subnetSurfacesQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetCandidatesQuery,
  fixturesIndexQuery,
  lineageQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
import { TableState } from "@/components/metagraphed/table-state";
import type {
  Endpoint,
  Surface,
  Candidate,
  SubnetProfile,
  FixtureIndexEntry,
} from "@/lib/metagraphed/types";
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
};

export const Route = createFileRoute("/subnets/$netuid")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
    sev: typeof s.sev === "string" ? s.sev : undefined,
  }),
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
  const stale = meta?.stale || isStaleFreshness(meta?.generated_at);
  const tab = useActiveTab("overview");
  useHashScroll(tab, SECTION_TO_TAB);

  // Counts shown next to tab labels
  const tabsWithCounts = TABS.map((t) => {
    if (t.id === "surfaces") return { ...t, count: profile?.surface_count };
    if (t.id === "endpoints") return { ...t, count: profile?.endpoint_count };
    if (t.id === "candidates") return { ...t, count: profile?.candidate_count };
    if (t.id === "gaps") return { ...t, count: (profile?.missing_kinds?.length ?? 0) || undefined };
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
          {tab === "surfaces" ? <SurfacesPanel netuid={netuid} /> : null}
          {tab === "endpoints" ? <EndpointsPanel netuid={netuid} /> : null}
          {tab === "schemas" ? <SchemasPanel netuid={netuid} /> : null}
          {tab === "candidates" ? <CandidatesPanel netuid={netuid} /> : null}
          {tab === "gaps" ? <GapsPanel profile={profile} /> : null}
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

      {(profile?.missing_kinds?.length ?? 0) > 0 || (profile?.gap_notes?.length ?? 0) > 0 ? (
        <GapsPanel profile={profile} compact />
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

function GapsPanel({ profile, compact }: { profile?: SubnetProfile; compact?: boolean }) {
  const missing = profile?.missing_kinds ?? [];
  const notes = profile?.gap_notes ?? [];
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
      info="Submit a PR against the public registry to help close any of these gaps."
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

const API_SNIPPET_LANGS = [
  { id: "url", label: "URL" },
  { id: "curl", label: "curl" },
  { id: "js", label: "JavaScript" },
  { id: "python", label: "Python" },
] as const;
type ApiSnippetLang = (typeof API_SNIPPET_LANGS)[number]["id"];

// One-liner copy snippets for a GET against a registry URL. Kept single-line so
// they render and copy cleanly through CopyableCode.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function apiSnippet(lang: ApiSnippetLang, url: string): string {
  switch (lang) {
    case "curl":
      return `curl -sS ${shellSingleQuote(url)}`;
    case "js":
      return `fetch(${JSON.stringify(url)}).then((r) => r.json())`;
    case "python":
      return `requests.get(${JSON.stringify(url)}).json()`;
    case "url":
    default:
      return url;
  }
}

function ApiPanel({ netuid }: { netuid: number }) {
  const [lang, setLang] = useState<ApiSnippetLang>("url");
  const rows: Array<{ label: string; path: string }> = [
    { label: "profile", path: `/api/v1/subnets/${netuid}/profile` },
    { label: "surfaces", path: `/api/v1/subnets/${netuid}/surfaces` },
    { label: "endpoints", path: `/api/v1/subnets/${netuid}/endpoints` },
    { label: "candidates", path: `/api/v1/subnets/${netuid}/candidates` },
    { label: "health", path: `/api/v1/subnets/${netuid}/health` },
    { label: "artifact", path: `/metagraph/subnets/${netuid}.json` },
  ];
  return (
    <SectionAnchor
      id="api"
      title="API & artifacts"
      subtitle="Canonical URLs powering this profile."
      info="Pick a language and copy a ready-to-run snippet for any endpoint. /api/v1 endpoints return enveloped responses; /metagraph/*.json returns artifacts."
    >
      <div
        className="mb-3 inline-flex rounded border border-border bg-card p-0.5"
        role="tablist"
        aria-label="Snippet language"
      >
        {API_SNIPPET_LANGS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={lang === l.id}
            onClick={() => setLang(l.id)}
            className={classNames(
              "rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors",
              lang === l.id ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <CopyableCode
            key={r.label}
            label={r.label}
            value={apiSnippet(lang, `${API_BASE}${r.path}`)}
            truncate={false}
            className="w-full"
          />
        ))}
      </div>
      {lang === "python" ? (
        <p className="mt-2 font-mono text-[10px] text-ink-muted">
          requires <code className="text-ink-strong">pip install requests</code>
        </p>
      ) : null}
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
