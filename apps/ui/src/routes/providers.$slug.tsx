import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading, StaleBanner, RECOVERY } from "@/components/metagraphed/states";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import {
  BrandIcon,
  PrimaryLinksRail,
  CopyableCode,
  SectionAnchor,
  ShareButton,
} from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  Breadcrumbs,
  PageMasthead,
  RoutePending,
  TabStrip,
} from "@/components/metagraphed/primitives";
import { EndpointsGlance } from "@/components/metagraphed/endpoints-glance";
import { EndpointList } from "@/components/metagraphed/endpoint-list";
import { useHashScroll } from "@/components/metagraphed/use-hash-scroll";
import {
  providerQuery,
  providerEndpointsQuery,
  subnetsQuery,
  metagraphedQueryKey,
} from "@/lib/metagraphed/queries";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { shouldShowProviderSlugSubtitle } from "@/lib/metagraphed/provider-hero-fields";
import type { Endpoint, Subnet } from "@/lib/metagraphed/types";

type ProviderTab = "overview" | "endpoints" | "subnets" | "evidence";
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
  pendingComponent: () => <RoutePending panels={3} />,
  component: ProviderDetail,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Provider not found" />
      <EmptyState
        title="Provider not found"
        description="No provider matches this slug. Browse the provider directory to find the one you're looking for."
        action={{ label: "Back to providers", href: "/providers" }}
      />
    </AppShell>
  ),
});

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "endpoints", label: "Endpoints" },
  { id: "subnets", label: "Subnets" },
  { id: "evidence", label: "Evidence" },
] as const;

const SECTION_TO_TAB: Record<string, string> = {
  "endpoints-glance": "overview",
  endpoints: "endpoints",
  "subnets-served": "subnets",
  evidence: "evidence",
};

function ProviderDetail() {
  const { slug } = Route.useParams();
  return (
    <AppShell>
      <AsyncPanel
        height="md"
        context="provider"
        retryQueryKeys={[metagraphedQueryKey("provider", slug)]}
      >
        <ProviderShell slug={slug} />
      </AsyncPanel>
    </AppShell>
  );
}

function ProviderShell({ slug }: { slug: string }) {
  const { data: p, meta } = useSuspenseQuery(providerQuery(slug)).data;
  const summary = p?.endpoint_summary;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab = (
    TABS.some((item) => item.id === search.tab) ? search.tab : "overview"
  ) as ProviderTab;
  useHashScroll(tab, SECTION_TO_TAB);
  const stale = meta?.stale || isStaleFreshness(meta?.generated_at);
  const setTab = (next: ProviderTab) =>
    navigate({
      search: { tab: next === "overview" ? undefined : next },
      replace: true,
      resetScroll: false,
    });

  return (
    <>
      <Breadcrumbs
        crumbs={[
          { to: "/", label: "Home" },
          { to: "/providers", label: "Providers" },
          { to: `/providers/${slug}`, label: p?.name ?? slug },
        ]}
        className="mb-2"
      />

      <PageMasthead
        eyebrow={["Provider", p?.kind, p?.authority].filter(Boolean).join(" · ")}
        title={p?.name ?? slug}
        description={
          p?.notes ?? "Public Bittensor infrastructure, endpoints, and supporting evidence."
        }
        live={(summary?.by_status?.ok ?? 0) > 0}
        actions={
          <div className="inline-flex items-center rounded-md border border-border bg-card divide-x divide-border overflow-hidden">
            <PrimaryLinksRail
              bare
              website={p?.website ?? p?.homepage}
              docs={p?.docs}
              repo={p?.repo}
            />
            <ShareButton connected />
          </div>
        }
      />
      {shouldShowProviderSlugSubtitle(p?.name, slug) ? (
        <div className="-mt-2 mb-3 font-mono text-[11px] text-ink-muted">{slug}</div>
      ) : null}

      <div className="mg-kpi-strip">
        <ProviderPulseTile label="Endpoints" value={formatNumber(summary?.endpoint_count)} />
        <ProviderPulseTile label="Monitored" value={formatNumber(summary?.monitored_count)} />
        <ProviderPulseTile label="Healthy" value={formatNumber(summary?.by_status?.ok)} tone="ok" />
        <ProviderPulseTile
          label="Pool eligible"
          value={formatNumber(summary?.pool_eligible_count)}
        />
      </div>
      {stale ? (
        <StaleBanner
          generatedAt={meta?.generated_at}
          refreshQueryKeys={[providerQuery(slug).queryKey, providerEndpointsQuery(slug).queryKey]}
        />
      ) : null}

      <TabStrip
        items={TABS.map((item) =>
          item.id === "endpoints" ? { ...item, meta: summary?.endpoint_count } : item,
        )}
        value={tab}
        onChange={setTab}
        ariaLabel="Provider profile sections"
        className="mt-4 overflow-x-auto"
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-6">
          {tab === "overview" ? <OverviewPanel slug={slug} /> : null}
          {tab === "endpoints" ? <EndpointsPanel slug={slug} /> : null}
          {tab === "subnets" ? <SubnetsServedPanel slug={slug} /> : null}
          {tab === "evidence" ? <EvidencePanel slug={slug} provider={p} /> : null}
        </div>

        <aside className="space-y-3 border-t border-border pt-4 lg:sticky lg:top-32 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 self-start">
          {summary?.by_kind ? <BreakdownCard title="By kind" data={summary.by_kind} /> : null}
          {summary?.by_status ? <BreakdownCard title="By status" data={summary.by_status} /> : null}
          {summary?.by_layer ? <BreakdownCard title="By layer" data={summary.by_layer} /> : null}
        </aside>
      </div>

      <ApiSourceFooter
        paths={[`/api/v1/providers/${slug}`, `/api/v1/providers/${slug}/endpoints`]}
      />
    </>
  );
}

function ProviderPulseTile({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  return (
    <div>
      <div className="mg-label">{label}</div>
      <div
        className={
          tone === "ok"
            ? "mt-1 font-mono text-xl text-health-ok"
            : "mt-1 font-mono text-xl text-ink-strong"
        }
      >
        {value}
      </div>
    </div>
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
        <AsyncPanel
          height="md"
          context="endpoints"
          retryQueryKeys={[metagraphedQueryKey("provider-endpoints", slug)]}
        >
          <EndpointsGlanceLoader slug={slug} />
        </AsyncPanel>
      </SectionAnchor>

      <SectionAnchor
        id="subnets-served-preview"
        title="Subnets served"
        subtitle="Active netuids where this provider operates endpoints."
        info="Grouped by netuid — click any to open the subnet profile."
      >
        <AsyncPanel
          height="sm"
          context="subnets served"
          retryQueryKeys={[
            metagraphedQueryKey("provider-endpoints", slug),
            metagraphedQueryKey("subnets"),
          ]}
        >
          <SubnetsServedGrid slug={slug} compact />
        </AsyncPanel>
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
      <AsyncPanel
        height="lg"
        context="endpoints"
        retryQueryKeys={[metagraphedQueryKey("provider-endpoints", slug)]}
      >
        <EndpointsTableLoader slug={slug} />
      </AsyncPanel>
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
      <AsyncPanel
        height="md"
        context="subnets served"
        retryQueryKeys={[
          metagraphedQueryKey("provider-endpoints", slug),
          metagraphedQueryKey("subnets"),
        ]}
      >
        <SubnetsServedGrid slug={slug} />
      </AsyncPanel>
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

function EvidencePanel({
  slug,
  provider,
}: {
  slug: string;
  provider: { website?: string; homepage?: string; docs?: string; repo?: string };
}) {
  return (
    <SectionAnchor
      id="evidence"
      title="Evidence & source links"
      subtitle="Public references and canonical data behind this profile."
      info="Provider links are source context; canonical API and artifact URLs expose the normalized registry record."
    >
      <div className="space-y-2">
        {(provider.website ?? provider.homepage) ? (
          <CopyableCode
            label="website"
            value={provider.website ?? provider.homepage ?? ""}
            truncate={false}
            className="w-full"
          />
        ) : null}
        {provider.docs ? (
          <CopyableCode label="docs" value={provider.docs} truncate={false} className="w-full" />
        ) : null}
        {provider.repo ? (
          <CopyableCode
            label="repository"
            value={provider.repo}
            truncate={false}
            className="w-full"
          />
        ) : null}
      </div>
    </SectionAnchor>
  );
}
