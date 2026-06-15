import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CandidateChip, CurationChip, HealthPill } from "@/components/metagraphed/chips";
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
import { FreshnessIndicator } from "@/components/metagraphed/freshness";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ProfileHero } from "@/components/metagraphed/profile-hero";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { PrimaryLinksRail } from "@/components/metagraphed/primary-links-rail";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { CoverageCard } from "@/components/metagraphed/coverage-card";
import { SchemaDriftSummary } from "@/components/metagraphed/schema-drift";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { EndpointsGlance } from "@/components/metagraphed/endpoints-glance";
import { EndpointList } from "@/components/metagraphed/endpoint-list";
import { useHashScroll } from "@/components/metagraphed/use-hash-scroll";
import {
  subnetProfileQuery,
  subnetSurfacesQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetCandidatesQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import type { Endpoint, Surface, Candidate, SubnetProfile } from "@/lib/metagraphed/types";

type SearchParams = {
  tab?: string;
};

export const Route = createFileRoute("/subnets/$netuid")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
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
  endpoints: "endpoints",
  surfaces: "surfaces",
  "schema-drift": "schemas",
  candidates: "candidates",
  gaps: "gaps",
  evidence: "evidence",
  api: "api",
  notes: "overview",
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
    if (t.id === "gaps")
      return {
        ...t,
        count: (profile?.missing_kinds?.length ?? 0) || undefined,
      };
    return { ...t };
  });

  const categoryChips = (profile?.categories ?? []).slice(0, 3);

  return (
    <>
      <ProfileHero
        icon={
          <BrandIcon
            url={profile?.website ?? profile?.homepage}
            iconUrl={profile?.icon_url}
            netuid={netuid}
            subnetSlug={profile?.slug}
            name={profile?.name}
            fallback={netuid}
            size={48}
          />
        }
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <span>Netuid {String(netuid).padStart(3, "0")}</span>
            {profile?.subnet_type ? <span>· {profile.subnet_type}</span> : null}
            {categoryChips.length > 0 ? (
              <span className="hidden sm:inline">· {categoryChips.join(" · ")}</span>
            ) : null}
          </span>
        }
        title={profile?.name ?? `Subnet ${netuid}`}
        subtitle={profile?.symbol ? `· ${profile.symbol}` : null}
        description={profile?.description}
        chips={
          <>
            <CurationChip level={profile?.curation_level} />
            <HealthPill state={profile?.health} />
          </>
        }
        links={
          <PrimaryLinksRail
            website={profile?.website}
            docs={profile?.docs}
            repo={profile?.repo}
            dashboard={profile?.dashboard}
          />
        }
        stats={[
          { label: "Participants", value: formatNumber(profile?.participants) },
          { label: "Tempo", value: profile?.tempo != null ? String(profile.tempo) : "" },
          { label: "Endpoints", value: formatNumber(profile?.endpoint_count) },
          {
            label: "Completeness",
            value:
              profile?.completeness != null ? `${Math.round(profile.completeness * 100)}%` : "",
          },
        ]}
        banner={stale ? <StaleBanner generatedAt={meta?.generated_at} /> : null}
      />

      <ProfileTabs tabs={tabsWithCounts} defaultTab="overview" />

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-8">
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

        <aside className="space-y-4 lg:sticky lg:top-32 self-start">
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <LiveHealthCard netuid={netuid} />
            </Suspense>
          </QueryErrorBoundary>
          <CoverageCard
            curationLevel={profile?.curation_level}
            coverageLevel={profile?.coverage_level}
            reviewState={profile?.review_state}
            reviewedAt={profile?.reviewed_at}
            confidence={profile?.confidence}
            completeness={profile?.completeness}
            missingKinds={profile?.missing_kinds}
            gapNotes={profile?.gap_notes}
          />
          {profile?.primary_app_surface ? (
            <PrimaryAppSurfaceCard surface={profile.primary_app_surface} />
          ) : null}
        </aside>
      </div>
    </>
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

function OverviewPanel({ netuid, profile }: { netuid: number; profile?: SubnetProfile }) {
  return (
    <>
      <SectionAnchor
        id="endpoints-glance"
        title="Endpoints at a glance"
        subtitle="Root RPC/WSS, SSE/data streams, and open incidents — one tap to expand."
        info="Compact operational summary. Click 'Show all endpoints' to reveal the full table inline."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <EndpointsGlanceLoader netuid={netuid} />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="surfaces"
        title="Surfaces"
        subtitle="Curated public interfaces, grouped by kind."
        info="APIs, docs, dashboards, repos, SSE streams, data artifacts, SDKs, and examples that have been verified."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <SurfacesList netuid={netuid} compact />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="schema-drift"
        title="Schema drift"
        subtitle="OpenAPI/JSON Schema snapshots joined from /api/v1/schemas."
        info="Compares the latest schema hash against the previous snapshot to flag breaking changes."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-20 w-full" />}>
            <SchemaDriftSummary netuid={netuid} compact />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>

      {(profile?.missing_kinds?.length ?? 0) > 0 || (profile?.gap_notes?.length ?? 0) > 0 ? (
        <GapsPanel profile={profile} compact />
      ) : null}
    </>
  );
}

function EndpointsGlanceLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetEndpointsQuery(netuid));
  const meta = data.meta;
  const rows = (data.data ?? []) as Endpoint[];
  return (
    <EndpointsGlance
      endpoints={rows}
      lastChecked={meta?.generated_at}
      fullList={() => <EndpointList rows={rows} showProvider />}
    />
  );
}

/* ----------------------------- right rail ----------------------------- */

function LiveHealthCard({ netuid }: { netuid: number }) {
  const { data, meta } = useSuspenseQuery(subnetHealthQuery(netuid)).data;
  const h = data;
  const total = (h?.ok ?? 0) + (h?.warn ?? 0) + (h?.down ?? 0) + (h?.unknown ?? 0);
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-3">
        Live health
      </h3>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <HCell color="bg-health-ok" label="OK" value={formatNumber(h?.ok)} />
        <HCell color="bg-health-warn" label="Warn" value={formatNumber(h?.warn)} pulse />
        <HCell color="bg-health-down" label="Down" value={formatNumber(h?.down)} pulse />
        <HCell color="bg-health-unknown" label="Unknown" value={formatNumber(h?.unknown)} />
      </div>
      <div className="flex items-baseline justify-between border-t border-border pt-2">
        <span className="mg-label">Uptime 24h</span>
        <span className="font-display text-sm font-semibold text-ink-strong tabular-nums">
          {h?.uptime_24h != null ? `${(h.uptime_24h * 100).toFixed(2)}%` : "—"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <FreshnessIndicator at={meta?.generated_at ?? h?.generated_at} />
        <span className="font-mono text-ink-muted">{total} tracked</span>
      </div>
    </section>
  );
}

function HCell({
  label,
  value,
  color,
  pulse,
}: {
  label: string;
  value: string;
  color: string;
  pulse?: boolean;
}) {
  return (
    <div className="rounded border border-border bg-surface/30 p-2">
      <div className="flex items-center gap-1.5">
        <span className={classNames("size-1.5 rounded-full", color, pulse && "mg-pulse")} />
        <span className="mg-label">{label}</span>
      </div>
      <div className="mt-0.5 font-display text-sm font-semibold text-ink-strong tabular-nums">
        {value}
      </div>
    </div>
  );
}

function PrimaryAppSurfaceCard({
  surface,
}: {
  surface: NonNullable<SubnetProfile["primary_app_surface"]>;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        Primary app surface
      </h3>
      <div className="flex items-center gap-2 mb-1">
        <span className="mg-label">{surface.kind ?? "surface"}</span>
      </div>
      <div className="font-medium text-ink-strong text-sm">{surface.name ?? surface.url}</div>
      {surface.provider ? (
        <Link
          to="/providers/$slug"
          params={{ slug: surface.provider }}
          className="mt-0.5 inline-block text-xs text-ink-muted hover:text-ink-strong"
        >
          via {surface.provider}
        </Link>
      ) : null}
      {surface.url ? (
        <div className="mt-2">
          <CopyableCode label="url" value={surface.url} truncate={false} className="w-full" />
        </div>
      ) : null}
    </section>
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
      <EmptyState
        title="No endpoints recorded"
        description="This subnet has no tracked endpoints yet."
        lastChecked={meta?.generated_at}
        action={RECOVERY.endpoints}
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

/* ----------------------------- surfaces list ----------------------------- */

function SurfacesList({ netuid, compact }: { netuid: number; compact?: boolean }) {
  const { data } = useSuspenseQuery(subnetSurfacesQuery(netuid));
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
  const visible = compact ? ordered.slice(0, 3) : ordered;

  return (
    <div className="space-y-4">
      {visible.map(([kind, items]) => (
        <div key={kind}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="mg-label">{kind}</span>
            <span className="font-mono text-[10px] text-ink-muted">{items.length}</span>
          </div>
          <ul className="space-y-2">
            {(compact ? items.slice(0, 3) : items).map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-card p-3 mg-row-hover">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-strong">{s.name ?? s.url}</span>
                      <CurationChip level={s.curation_level} />
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
              </li>
            ))}
          </ul>
        </div>
      ))}
      {compact && ordered.length > visible.length ? (
        <div className="text-[11px] text-ink-muted">
          + {ordered.length - visible.length} more group
          {ordered.length - visible.length === 1 ? "" : "s"} — open the Surfaces tab.
        </div>
      ) : null}
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
