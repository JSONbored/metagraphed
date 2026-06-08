import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import {
  AlertTriangle,
  BookOpen,
  Code2,
  Database,
  FileCode,
  Github,
  Globe,
  LayoutDashboard,
  Radio,
  Wrench,
} from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CandidateChip, CurationChip, HealthDot, HealthPill } from "@/components/metagraphed/chips";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import { FreshnessIndicator } from "@/components/metagraphed/freshness";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ProfileHero } from "@/components/metagraphed/profile-hero";
import { PrimaryLinksRail } from "@/components/metagraphed/primary-links-rail";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { CoverageCard } from "@/components/metagraphed/coverage-card";
import { SchemaDriftSummary } from "@/components/metagraphed/schema-drift";
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
  head: ({ params }) => ({
    meta: [
      { title: `Subnet ${params.netuid} — Metagraphed` },
      {
        name: "description",
        content: `Public-interface registry for Bittensor subnet ${params.netuid}: surfaces, endpoints, schemas, health.`,
      },
    ],
  }),
  component: SubnetDetailPage,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Subnet not found" description="No active Finney netuid matches this URL." />
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

  const categoryChips = (profile?.categories ?? []).slice(0, 4);

  return (
    <>
      <ProfileHero
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
          { label: "Block", value: formatNumber(profile?.block) },
          { label: "Surfaces", value: formatNumber(profile?.surface_count) },
          { label: "Endpoints", value: formatNumber(profile?.endpoint_count) },
          {
            label: "Completeness",
            value:
              profile?.completeness != null
                ? `${Math.round(profile.completeness * 100)}%`
                : "",
          },
        ]}
        banner={stale ? <StaleBanner generatedAt={meta?.generated_at} /> : null}
      />

      <ProfileTabs tabs={tabsWithCounts} defaultTab="overview" />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {tab === "overview" ? <OverviewPanel netuid={netuid} profile={profile} /> : null}
          {tab === "surfaces" ? <SurfacesPanel netuid={netuid} /> : null}
          {tab === "endpoints" ? <EndpointsPanel netuid={netuid} /> : null}
          {tab === "schemas" ? <SchemasPanel netuid={netuid} /> : null}
          {tab === "candidates" ? <CandidatesPanel netuid={netuid} /> : null}
          {tab === "gaps" ? <GapsPanel profile={profile} /> : null}
          {tab === "evidence" ? (
            <Section title="Evidence & sources" subtitle="Every claim should be traceable.">
              <EvidencePanel netuid={netuid} />
            </Section>
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
          {(profile?.operational_interface_kinds?.length ?? 0) > 0 ||
          (profile?.supported_interface_kinds?.length ?? 0) > 0 ? (
            <KindsCard
              operational={profile?.operational_interface_kinds ?? []}
              supported={profile?.supported_interface_kinds ?? []}
            />
          ) : null}
        </aside>
      </div>
    </>
  );
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-32">
      <div className="mb-2">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 text-[11px] text-ink-muted">{subtitle}</p> : null}
      </div>
      {children}
    </section>
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
  // The hero already shows description + primary links + stats, so the
  // Overview goes straight to the operational data developers need first:
  // endpoints, surfaces, drift, then gaps. No duplicated "About" or
  // "At a glance" rail.
  const hasDescription = !!profile?.description;
  const hasExtraNotes = !!profile?.notes && profile.notes !== profile.description;
  return (
    <>
      <Section
        title="Endpoints"
        subtitle="Probe-derived health and latency for every tracked resource."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <EndpointsList netuid={netuid} compact />
          </Suspense>
        </QueryErrorBoundary>
      </Section>

      <Section
        title="Surfaces"
        subtitle="Curated public interfaces, grouped by kind."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <SurfacesList netuid={netuid} compact />
          </Suspense>
        </QueryErrorBoundary>
      </Section>

      <Section
        title="Schema drift"
        subtitle="OpenAPI/JSON Schema snapshots joined from /api/v1/schemas."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-20 w-full" />}>
            <SchemaDriftSummary netuid={netuid} compact />
          </Suspense>
        </QueryErrorBoundary>
      </Section>

      {hasExtraNotes && !hasDescription ? (
        <Section title="Notes">
          <div className="rounded border border-border bg-card p-3 text-sm leading-relaxed text-ink">
            {profile?.notes}
          </div>
        </Section>
      ) : null}

      {(profile?.missing_kinds?.length ?? 0) > 0 ||
      (profile?.gap_notes?.length ?? 0) > 0 ? (
        <GapsPanel profile={profile} compact />
      ) : null}
    </>
  );
}


/* ----------------------------- right rail ----------------------------- */

function LiveHealthCard({ netuid }: { netuid: number }) {
  const { data, meta } = useSuspenseQuery(subnetHealthQuery(netuid)).data;
  const h = data;
  const total = (h?.ok ?? 0) + (h?.warn ?? 0) + (h?.down ?? 0) + (h?.unknown ?? 0);
  return (
    <section className="rounded border border-border bg-card p-3">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        Live health
      </h3>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <HCell color="bg-health-ok" label="OK" value={formatNumber(h?.ok)} />
        <HCell color="bg-health-warn" label="Warn" value={formatNumber(h?.warn)} pulse />
        <HCell color="bg-health-down" label="Down" value={formatNumber(h?.down)} pulse />
        <HCell color="bg-health-unknown" label="Unknown" value={formatNumber(h?.unknown)} />
      </div>
      <div className="flex items-baseline justify-between border-t border-border pt-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Uptime 24h
        </span>
        <span className="font-display text-sm font-semibold text-ink-strong tabular-nums">
          {h?.uptime_24h != null ? `${(h.uptime_24h * 100).toFixed(2)}%` : "—"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <FreshnessIndicator at={meta?.generated_at ?? h?.generated_at} />
        <span className="font-mono text-ink-muted">
          {total} tracked
        </span>
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
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</span>
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
    <section className="rounded border border-border bg-card p-3">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        Primary app surface
      </h3>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {surface.kind ?? "surface"}
        </span>
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

function KindsCard({
  operational,
  supported,
}: {
  operational: string[];
  supported: string[];
}) {
  const opSet = new Set(operational);
  const all = Array.from(new Set([...operational, ...supported]));
  if (all.length === 0) return null;
  return (
    <section className="rounded border border-border bg-card p-3">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        Interface kinds
      </h3>
      <div className="flex flex-wrap gap-1">
        {all.map((k) => {
          const isOp = opSet.has(k);
          return (
            <span
              key={k}
              className={classNames(
                "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                isOp
                  ? "border-curation-verified/30 bg-curation-verified/10 text-curation-verified"
                  : "border-ink-subtle border-dashed bg-paper text-ink-muted",
              )}
              title={isOp ? "Operational (verified)" : "Supported (claimed)"}
            >
              {k}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------- panels ----------------------------- */

function SurfacesPanel({ netuid }: { netuid: number }) {
  return (
    <Section title="Verified surfaces" subtitle="Curated public interfaces with provenance.">
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <SurfacesList netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </Section>
  );
}

function EndpointsPanel({ netuid }: { netuid: number }) {
  return (
    <Section title="Endpoints" subtitle="Probe-derived health, latency, and score.">
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <EndpointsList netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </Section>
  );
}

function CandidatesPanel({ netuid }: { netuid: number }) {
  return (
    <Section
      title="Candidates"
      subtitle="Unverified leads from public sources. Always labeled."
    >
      <div className="mb-2 rounded border border-dashed border-ink-subtle bg-paper px-3 py-2 text-[11px] text-ink-muted flex items-start gap-2">
        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
        <span>
          Candidates are discovered automatically and have not been verified by a maintainer.
          Submit corrections via the public repo.
        </span>
      </div>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <CandidatesList netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </Section>
  );
}

function GapsPanel({
  profile,
  compact,
}: {
  profile?: SubnetProfile;
  compact?: boolean;
}) {
  const missing = profile?.missing_kinds ?? [];
  const notes = profile?.gap_notes ?? [];
  if (missing.length === 0 && notes.length === 0) {
    return (
      <Section title="Gaps">
        <EmptyState title="No outstanding gaps" description="Profile looks complete." />
      </Section>
    );
  }
  return (
    <Section
      title={compact ? "Known gaps" : "Gaps"}
      subtitle="Missing resources, profile incompleteness, and curation notes."
    >
      <div className="rounded border border-border bg-card p-3 space-y-3">
        {missing.length > 0 ? (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1">
              Missing kinds
            </div>
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
    </Section>
  );
}

function ApiPanel({ netuid }: { netuid: number }) {
  const rows: Array<{ label: string; path: string }> = [
    { label: "profile", path: `/api/v1/subnets/${netuid}/profile` },
    { label: "surfaces", path: `/api/v1/subnets/${netuid}/surfaces` },
    { label: "endpoints", path: `/api/v1/subnets/${netuid}/endpoints` },
    { label: "candidates", path: `/api/v1/subnets/${netuid}/candidates` },
    { label: "health", path: `/api/v1/subnets/${netuid}/health` },
    { label: "artifact", path: `/metagraph/subnets/${netuid}.json` },
  ];
  return (
    <Section title="API & artifacts" subtitle="Canonical URLs powering this profile.">
      <div className="space-y-2">
        {rows.map((r) => (
          <CopyableCode
            key={r.label}
            label={r.label}
            value={`${API_BASE}${r.path}`}
            truncate={false}
            className="w-full"
          />
        ))}
      </div>
    </Section>
  );
}

/* ----------------------------- schema list ----------------------------- */

function SchemasPanel({ netuid }: { netuid: number }) {
  return (
    <Section
      title="Schemas & drift"
      subtitle="OpenAPI/JSON Schema snapshots joined from /api/v1/schemas, with hash diffs."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <SchemaDriftSummary netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </Section>
  );
}


/* ----------------------------- surfaces list ----------------------------- */

function SurfacesList({ netuid, compact }: { netuid: number; compact?: boolean }) {
  const { data } = useSuspenseQuery(subnetSurfacesQuery(netuid));
  const rows = (data.data ?? []) as Surface[];
  if (rows.length === 0)
    return (
      <EmptyState
        title="No verified surfaces yet"
        description="Candidates may exist — check the Candidates tab."
      />
    );

  // Group surfaces by kind for clearer scanning
  const groups = new Map<string, Surface[]>();
  for (const s of rows) {
    const k = s.kind ?? "other";
    const arr = groups.get(k) ?? [];
    arr.push(s);
    groups.set(k, arr);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  const visible = compact ? ordered.slice(0, 3) : ordered;

  return (
    <div className="space-y-4">
      {visible.map(([kind, items]) => (
        <div key={kind}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {kind}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">{items.length}</span>
          </div>
          <ul className="space-y-2">
            {(compact ? items.slice(0, 3) : items).map((s) => (
              <li key={s.id} className="rounded border border-border bg-card p-3">
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

/* ----------------------------- endpoints list ----------------------------- */

function EndpointsList({ netuid, compact }: { netuid: number; compact?: boolean }) {
  const { data } = useSuspenseQuery(subnetEndpointsQuery(netuid));
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) return <EmptyState title="No endpoints" />;
  const visible = compact ? rows.slice(0, 6) : rows;
  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">URL</th>
              <th className="px-3 py-2 text-left">Provider</th>
              <th className="px-3 py-2 text-center">Health</th>
              <th className="px-3 py-2 text-right">Latency</th>
              <th className="px-3 py-2 text-right hidden md:table-cell">Probed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">{e.kind ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[28ch]">
                  {e.url ?? "—"}
                </td>
                <td className="px-3 py-2 text-[12px]">
                  {e.provider ? (
                    <Link
                      to="/providers/$slug"
                      params={{ slug: e.provider_slug ?? e.provider }}
                      className="hover:text-ink-strong"
                    >
                      {e.provider}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className="inline-flex justify-center">
                    <HealthDot state={e.health} />
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                  {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted hidden md:table-cell">
                  <TimeAgo at={e.last_probed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {compact && rows.length > visible.length ? (
        <div className="border-t border-border bg-surface/30 px-3 py-2 text-[11px] text-ink-muted">
          + {rows.length - visible.length} more — open the Endpoints tab.
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------- candidates list ----------------------------- */

function CandidatesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetCandidatesQuery(netuid));
  const rows = (data.data ?? []) as Candidate[];
  if (rows.length === 0)
    return <EmptyState title="No candidate leads" description="Submit corrections via the public repo." />;
  return (
    <ul className="space-y-2">
      {rows.map((c) => (
        <li key={c.id} className="rounded border border-dashed border-ink-subtle bg-paper p-3">
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
