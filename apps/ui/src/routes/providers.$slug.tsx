import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  EmptyState,
  PageHeading,
  Skeleton,
  StaleBanner,
  RECOVERY,
} from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  ProfileHero,
  BrandIcon,
  PrimaryLinksRail,
  CopyableCode,
  SectionAnchor,
} from "@jsonbored/ui-kit";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { EndpointsGlance } from "@/components/metagraphed/endpoints-glance";
import { EndpointList } from "@/components/metagraphed/endpoint-list";
import { useHashScroll } from "@/components/metagraphed/use-hash-scroll";
import { providerQuery, providerEndpointsQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import type { Endpoint, Subnet } from "@/lib/metagraphed/types";

type SearchParams = { tab?: string };

export const Route = createFileRoute("/providers/$slug")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  parseParams: ({ slug }) => {
    if (!slug) throw notFound();
    return { slug };
  },
  // Prime the page's provider query (shared cache → no double fetch) so head()
  // can use the real provider name in the OG/social card. Non-fatal: falls back
  // to the slug on any failure.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(providerQuery(params.slug));
      return { name: data.name ?? null };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    const name = loaderData?.name ?? params.slug;
    const title = `${name} — Provider — Metagraphed`;
    const description = `${name}: Bittensor infrastructure provider — public endpoints, operational surfaces, and live health on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: ProviderDetail,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Provider not found" />
      <Link to="/providers" className="text-sm underline">
        Back to providers
      </Link>
    </AppShell>
  ),
});

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "endpoints", label: "Endpoints" },
  { id: "subnets", label: "Subnets served" },
  { id: "api", label: "API" },
] as const;

const SECTION_TO_TAB: Record<string, string> = {
  "endpoints-glance": "overview",
  endpoints: "endpoints",
  "subnets-served": "subnets",
  api: "api",
};

function ProviderDetail() {
  const { slug } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <ProviderShell slug={slug} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function ProviderShell({ slug }: { slug: string }) {
  const { data: p, meta } = useSuspenseQuery(providerQuery(slug)).data;
  const summary = p?.endpoint_summary;
  const tab = useActiveTab("overview");
  useHashScroll(tab, SECTION_TO_TAB);
  const stale = meta?.stale || isStaleFreshness(meta?.generated_at);

  return (
    <>
      <ProfileHero
        icon={
          <BrandIcon
            url={p?.website ?? p?.homepage}
            iconUrl={p?.icon_url}
            repoUrl={p?.repo}
            providerSlug={slug}
            name={p?.name ?? slug}
            fallback={slug}
            size={48}
          />
        }
        eyebrow={
          <span>
            Provider
            {p?.kind ? <> · {p.kind}</> : null}
            {p?.authority ? <> · {p.authority}</> : null}
          </span>
        }
        title={p?.name ?? slug}
        subtitle={<>· {slug}</>}
        description={p?.notes}
        links={<PrimaryLinksRail website={p?.website ?? p?.homepage} docs={p?.docs} />}
        stats={[
          { label: "Endpoints", value: formatNumber(summary?.endpoint_count) },
          { label: "Monitored", value: formatNumber(summary?.monitored_count) },
          { label: "OK", value: formatNumber(summary?.by_status?.ok) },
          { label: "Pool-eligible", value: formatNumber(summary?.pool_eligible_count) },
        ]}
        banner={
          stale ? (
            <StaleBanner
              generatedAt={meta?.generated_at}
              refreshQueryKeys={[
                providerQuery(slug).queryKey,
                providerEndpointsQuery(slug).queryKey,
              ]}
            />
          ) : null
        }
      />

      <ProfileTabs
        tabs={TABS.map((t) =>
          t.id === "endpoints" ? { ...t, count: summary?.endpoint_count } : t,
        )}
        defaultTab="overview"
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-8">
          {tab === "overview" ? <OverviewPanel slug={slug} /> : null}
          {tab === "endpoints" ? <EndpointsPanel slug={slug} /> : null}
          {tab === "subnets" ? <SubnetsServedPanel slug={slug} /> : null}
          {tab === "api" ? <ApiPanel slug={slug} /> : null}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-32 self-start">
          {summary?.by_kind ? <BreakdownCard title="By kind" data={summary.by_kind} /> : null}
          {summary?.by_status ? <BreakdownCard title="By status" data={summary.by_status} /> : null}
          {summary?.by_layer ? <BreakdownCard title="By layer" data={summary.by_layer} /> : null}
        </aside>
      </div>
    </>
  );
}

function OverviewPanel({ slug }: { slug: string }) {
  return (
    <>
      <SectionAnchor
        id="endpoints-glance"
        title="Endpoints at a glance"
        subtitle="Root RPC/WSS, SSE/data streams, and open incidents — one tap to expand."
        info="Compact operational summary across this provider's endpoints."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <EndpointsGlanceLoader slug={slug} />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="subnets-served-preview"
        title="Subnets served"
        subtitle="Active netuids where this provider operates endpoints."
        info="Grouped by netuid — click any to open the subnet profile."
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <SubnetsServedGrid slug={slug} compact />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>
    </>
  );
}

function EndpointsPanel({ slug }: { slug: string }) {
  return (
    <SectionAnchor
      id="endpoints"
      title="Endpoints"
      subtitle="Probe-derived health, latency, and freshness."
      info="Each endpoint is probed periodically. Health reflects the most recent probe."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <EndpointsTableLoader slug={slug} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

function SubnetsServedPanel({ slug }: { slug: string }) {
  return (
    <SectionAnchor
      id="subnets-served"
      title="Subnets served"
      subtitle="Active netuids where this provider operates endpoints."
    >
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <SubnetsServedGrid slug={slug} />
        </Suspense>
      </QueryErrorBoundary>
    </SectionAnchor>
  );
}

function EndpointsGlanceLoader({ slug }: { slug: string }) {
  const { data } = useSuspenseQuery(providerEndpointsQuery(slug));
  const meta = data.meta;
  const rows = (data.data ?? []) as Endpoint[];
  return (
    <EndpointsGlance
      endpoints={rows}
      lastChecked={meta?.generated_at}
      fullList={() => <EndpointList rows={rows} showNetuid showProvider={false} />}
    />
  );
}

function EndpointsTableLoader({ slug }: { slug: string }) {
  const { data } = useSuspenseQuery(providerEndpointsQuery(slug));
  const meta = data.meta;
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No endpoints for this provider"
        description="This provider has no tracked endpoints yet."
        lastChecked={meta?.generated_at}
        action={RECOVERY.endpoints}
      />
    );
  }
  return <EndpointList rows={rows} showNetuid showProvider={false} />;
}

function SubnetsServedGrid({ slug, compact }: { slug: string; compact?: boolean }) {
  const { data } = useSuspenseQuery(providerEndpointsQuery(slug));
  const meta = data.meta;
  const rows = useMemo(() => (data.data ?? []) as Endpoint[], [data]);
  // Join the subnet index so each tile can show the subnet's logo + name
  // (BrandIcon resolves icon_url → netuid brand-override → favicon → monogram).
  const subnetIndex = useSuspenseQuery(subnetsQuery({ limit: 256 })).data;
  const subnetByNetuid = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (subnetIndex.data ?? []) as Subnet[]) {
      if (s.netuid != null) m.set(s.netuid, s);
    }
    return m;
  }, [subnetIndex]);
  const grouped = useMemo(() => {
    const m = new Map<number, Endpoint[]>();
    for (const r of rows) {
      if (r.netuid == null) continue;
      const arr = m.get(r.netuid) ?? [];
      arr.push(r);
      m.set(r.netuid, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [rows]);
  if (grouped.length === 0)
    return (
      <EmptyState
        title="No per-subnet endpoints recorded"
        description="This provider may serve root or unattributed endpoints only."
        lastChecked={meta?.generated_at}
      />
    );
  const visible = compact ? grouped.slice(0, 8) : grouped;
  return (
    <>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map(([netuid, items]) => {
          const sn = subnetByNetuid.get(netuid);
          return (
            <li key={netuid}>
              <Link
                to="/subnets/$netuid"
                params={{ netuid: netuid }}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-3 hover:border-ink/30 mg-row-hover"
              >
                <BrandIcon
                  url={sn?.website}
                  iconUrl={sn?.icon_url}
                  netuid={netuid}
                  name={sn?.name ?? `Subnet ${netuid}`}
                  fallback={netuid}
                  size={30}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-display text-sm font-semibold text-ink-strong">
                      {sn?.name ?? "Subnet"}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted tabular-nums">
                      {String(netuid).padStart(3, "0")}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                    {items.length} endpoint{items.length === 1 ? "" : "s"}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {compact && grouped.length > visible.length ? (
        <div className="mt-2 text-[11px] text-ink-muted">
          + {grouped.length - visible.length} more — open the Subnets served tab.
        </div>
      ) : null}
    </>
  );
}

function BreakdownCard({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map((e) => e[1]));
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {entries.map(([kk, v]) => (
          <li key={kk}>
            <div className="flex items-baseline justify-between gap-2 mb-0.5">
              <span className="font-mono text-[11px] text-ink truncate">{kk}</span>
              <span className="font-mono text-[11px] text-ink-muted tabular-nums">{v}</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded bg-surface">
              <div
                className="h-full bg-accent"
                style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApiPanel({ slug }: { slug: string }) {
  const rows: Array<{ label: string; path: string }> = [
    { label: "provider", path: `/api/v1/providers/${slug}` },
    { label: "endpoints", path: `/api/v1/providers/${slug}/endpoints` },
    { label: "artifact", path: `/metagraph/providers/${slug}.json` },
  ];
  return (
    <SectionAnchor
      id="api"
      title="API & artifacts"
      subtitle="Canonical URLs powering this profile."
      info="Copy any of these URLs to fetch the raw JSON directly."
    >
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
    </SectionAnchor>
  );
}
