import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, type ReactNode } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Globe, Github, BookOpen, Radio, Layers, Network } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import {
  providersQuery,
  endpointsQuery,
  sourceHealthProvidersQuery,
  type ProviderCounts,
} from "@/lib/metagraphed/queries";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import { matchesQuery } from "@/lib/metagraphed/url-state";
import { matchesProviderAuthority } from "@/lib/metagraphed/providers-url-state";
import { buildUrl } from "@/lib/metagraphed/client";
import { resolveProviderCard } from "@/lib/metagraphed/provider-card-fields";
import { healthStatusSegments } from "@/lib/metagraphed/health-segments";
import {
  BrandIcon,
  prefetchBrandIcon,
  PageHero,
  ViewModeToggle,
  ShareButton,
  DownloadCsvButton,
  TimeAgo,
  ActionBar,
  Donut,
  DonutLegend,
  Sparkline,
} from "@jsonbored/ui-kit";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import type { Provider } from "@/lib/metagraphed/types";

const providerSortKeys = ["name", "surfaces", "endpoints", "subnets", "updated"] as const;
type ProviderSortKey = (typeof providerSortKeys)[number];

const providersSearchSchema = z.object({
  view: fallback(z.enum(["grid", "table"]), "grid").default("grid"),
  q: fallback(z.string(), "").default(""),
  kind: fallback(z.string(), "").default(""),
  // `high` is a nav shortcut for official + provider-claimed (see nav-mega-menu-data).
  authority: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(providerSortKeys), "name").default("name"),
});

export const Route = createFileRoute("/providers/")({
  validateSearch: zodValidator(providersSearchSchema),
  head: () => ({
    meta: [
      { title: "Providers — Metagraphed" },
      {
        name: "description",
        content: "Subnet teams, infrastructure providers, docs registries, and resource sources.",
      },
      { property: "og:title", content: "Providers — Metagraphed" },
      {
        property: "og:description",
        content: "Subnet teams, infrastructure providers, docs registries, and resource sources.",
      },
    ],
  }),
  component: ProvidersPage,
});

function ProvidersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const view = search.view ?? "grid";
  const filtersActive = Boolean(
    search.q || search.kind || search.authority || (search.sort && search.sort !== "name"),
  );
  const onReset = () => navigate({ search: { view: search.view } as never, replace: true });
  const providersCsvUrl = buildUrl("/api/v1/providers");
  return (
    <AppShell>
      <PageHero
        eyebrow="Infrastructure"
        live
        title="Providers"
        description="Teams, infra operators, docs registries, and community sources behind public interfaces."
        actions={
          <>
            <ViewModeToggle
              value={view}
              options={["table", "grid"]}
              onChange={(v) =>
                navigate({
                  search: (prev: Record<string, unknown>) => ({ ...prev, view: v }) as never,
                  replace: true,
                })
              }
            />
            <ActionBar>
              <ResetFiltersButton active={filtersActive} onReset={onReset} bare />
              <DownloadCsvButton url={providersCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<ProvidersSkeleton />}>
          <ProvidersGrid view={view} />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={["/api/v1/providers", "/api/v1/source-health"]}
        artifacts={["/metagraph/providers.json"]}
      />
    </AppShell>
  );
}

function ProvidersSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 animate-pulse h-[180px]"
        >
          <div className="flex items-start gap-3">
            <div className="size-9 rounded bg-surface" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-1/2 rounded bg-surface" />
              <div className="h-3 w-2/3 rounded bg-surface" />
              <div className="h-2 w-1/3 rounded bg-surface" />
            </div>
          </div>
          <div className="mt-4 h-8 rounded bg-surface" />
        </div>
      ))}
    </div>
  );
}

function maskHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? null;
  }
}

function authorityTone(a?: string): string {
  switch (a) {
    case "official":
      return "border-curation-verified/40 bg-curation-verified/10 text-curation-verified";
    case "provider-claimed":
      return "border-curation-pilot/40 bg-curation-pilot/10 text-curation-pilot";
    case "community":
      return "border-curation-machine/40 bg-curation-machine/10 text-curation-machine";
    default:
      return "border-border bg-paper text-ink-muted";
  }
}

function ProvidersGrid({ view }: { view: "grid" | "table" }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      replace: true,
    });

  const { data: providersRes } = useSuspenseQuery(providersQuery());
  const rows = useMemo(() => (providersRes.data ?? []) as Provider[], [providersRes]);
  // The /api/v1/providers list already carries per-provider tallies
  // (endpoint_count / surface_count / subnet_count, normalized to the *_count
  // fields). Derive the counts map from those rows instead of re-fetching the
  // full surfaces + endpoints collections — the server computes these the same
  // way, so the rendered numbers are identical.
  const counts = useMemo<Record<string, ProviderCounts>>(() => {
    const out: Record<string, ProviderCounts> = {};
    for (const p of rows) {
      if (!p.slug) continue;
      out[p.slug] = {
        surfaces: p.surfaces_count ?? 0,
        endpoints: p.endpoints_count ?? 0,
        subnets: (p.subnet_count as number | undefined) ?? 0,
      };
    }
    return out;
  }, [rows]);
  const generatedAt = providersRes.meta?.generated_at;
  const stale = isStaleFreshness(generatedAt);

  const q = search.q;
  const kind = search.kind;
  const authority = search.authority;
  const sortKey: ProviderSortKey = search.sort ?? "name";

  const kinds = useMemo(
    () => Array.from(new Set(rows.map((p) => p.kind).filter(Boolean) as string[])).sort(),
    [rows],
  );
  const authorities = useMemo(
    () => Array.from(new Set(rows.map((p) => p.authority).filter(Boolean) as string[])).sort(),
    [rows],
  );

  const authorityOptions = useMemo(() => {
    const fromRows = authorities.filter((a) => a !== "high");
    return ["high", ...fromRows];
  }, [authorities]);

  const filtered = useMemo(() => {
    return rows.filter((p) => {
      if (kind && p.kind !== kind) return false;
      if (!matchesProviderAuthority(p, authority)) return false;
      const host = maskHost(p.website ?? p.homepage) ?? "";
      return matchesQuery([p.name, p.slug, p.notes, host], q);
    });
  }, [rows, q, kind, authority]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortKey === "name")
        return String(a.name ?? a.slug).localeCompare(String(b.name ?? b.slug));
      if (sortKey === "updated") {
        const ta = String(a.updated_at ?? "");
        const tb = String(b.updated_at ?? "");
        return tb.localeCompare(ta);
      }
      const ca = counts[a.slug];
      const cb = counts[b.slug];
      const va = (ca?.[sortKey] as number | undefined) ?? 0;
      const vb = (cb?.[sortKey] as number | undefined) ?? 0;
      return vb - va;
    });
    return arr;
  }, [filtered, sortKey, counts]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ric =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const handle = ric(() => {
      for (const p of sorted)
        prefetchBrandIcon(p.website ?? p.homepage, 36, {
          iconUrl: p.icon_url,
          repoUrl: p.repo,
          lookup: { providerSlug: p.slug },
        });
    });
    return () => {
      const cic =
        (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback ??
        window.clearTimeout;
      cic(handle as number);
    };
  }, [sorted]);

  if (rows.length === 0)
    return (
      <EmptyState
        title="No providers tracked yet"
        description="Once provider entries are registered, they'll be listed here."
        action={{ label: "Browse all endpoints", href: "/endpoints" }}
      />
    );

  const hasFilters = Boolean(q || kind || authority || (sortKey && sortKey !== "name"));

  return (
    <div className="space-y-3">
      {stale ? (
        <StaleBanner
          generatedAt={generatedAt}
          refreshQueryKeys={[providersQuery().queryKey, endpointsQuery({ limit: 1000 }).queryKey]}
        />
      ) : null}

      <ProviderOverview providers={rows} counts={counts} />
      <SourceHealthRollup />

      {/* Filter toolbar — every control stretches to fill its track so the row stays
          justified (flush on both ends), reflowing cleanly down to narrow viewports. */}
      <div className="sticky top-14 z-20 -mx-4 border-y border-border bg-paper/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-paper/80 md:mx-0 md:rounded-lg md:border md:bg-card md:px-3">
        <div className="flex w-full flex-wrap items-stretch gap-2">
          <div className="flex w-full basis-full md:w-auto md:flex-[2] md:basis-0">
            <SearchInput
              value={q}
              onChange={(v) => setSearch({ q: v })}
              placeholder="Search providers, slugs, hosts…"
            />
          </div>
          <div className="flex flex-1 basis-full min-[480px]:min-w-[7rem] min-[480px]:basis-0">
            <SelectFilter
              fill
              label="Kind"
              value={kind}
              onChange={(v) => setSearch({ kind: v })}
              options={kinds.map((k) => ({ value: k, label: k }))}
            />
          </div>
          <div className="flex flex-1 basis-full min-[480px]:min-w-[7rem] min-[480px]:basis-0">
            <SelectFilter
              fill
              label="Authority"
              value={authority}
              onChange={(v) => setSearch({ authority: v })}
              options={authorityOptions.map((a) => ({ value: a, label: a }))}
            />
          </div>
          <div className="flex flex-1 basis-full min-[480px]:min-w-[7rem] min-[480px]:basis-0">
            <SelectFilter
              fill
              label="Sort"
              value={sortKey}
              onChange={(v) => setSearch({ sort: v as ProviderSortKey })}
              options={providerSortKeys.map((s) => ({ value: s, label: s }))}
              allowEmpty={false}
            />
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <ResetFiltersButton
            active={hasFilters}
            onReset={() => setSearch({ q: "", kind: "", authority: "", sort: "name" })}
          />
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted tabular-nums">
            {sorted.length} of {rows.length} providers
          </span>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          title="No providers match this filter"
          description="Try clearing filters or adjusting your search."
          action={{ label: "Browse all endpoints", href: "/endpoints" }}
        />
      ) : view === "table" ? (
        <>
          {/* < lg: the 7-column table pushes the Subnets/Surfaces/Endpoints
              columns off-screen behind an undiscoverable horizontal scroll on
              phone/tablet widths (the audit flagged 768px specifically), so
              narrow viewports get a stacked card per provider instead —
              mirrors the leaderboards/validators mobile fallback split
              (#5320/#5321). Wider than those 5-column boards, so the cutover
              is `lg` (1024px) rather than `md`. */}
          <div className="space-y-2 lg:hidden">
            {sorted.map((p) => {
              const f = resolveProviderCard(p, counts[p.slug]);
              const host = maskHost(p.website ?? p.homepage);
              return (
                <Link
                  key={p.slug}
                  to="/providers/$slug"
                  params={{ slug: p.slug }}
                  className="block rounded border border-border bg-card p-3 transition-colors hover:border-accent/60"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <BrandIcon
                        url={p.website ?? p.homepage}
                        iconUrl={p.icon_url}
                        repoUrl={p.repo}
                        providerSlug={p.slug}
                        name={f.name}
                        fallback={p.slug}
                        size={20}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink-strong">{f.name}</span>
                        <span className="block truncate font-mono text-[10px] text-ink-muted">
                          {p.slug}
                        </span>
                      </span>
                    </span>
                    {p.authority ? (
                      <span
                        className={classNames(
                          "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                          authorityTone(p.authority),
                        )}
                      >
                        {p.authority}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[11px] text-ink-muted">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span className="shrink-0">{f.kindLabel}</span>
                      {host ? <span className="max-w-[20ch] truncate">{host}</span> : null}
                    </span>
                    <TimeAgo
                      at={typeof p.updated_at === "string" ? p.updated_at : undefined}
                      className="shrink-0"
                    />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border/60 pt-2">
                    <ProviderCardStat label="Subnets" value={f.subnetsLabel} />
                    <ProviderCardStat label="Surfaces" value={f.surfacesLabel} />
                    <ProviderCardStat label="Endpoints" value={f.endpointsLabel} />
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="hidden overflow-x-auto rounded border border-border bg-card lg:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
                <tr>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Authority</th>
                  <th className="px-3 py-2">Host</th>
                  <th className="px-3 py-2 text-right">Subnets</th>
                  <th className="px-3 py-2 text-right">Surfaces</th>
                  <th className="px-3 py-2 text-right">Endpoints</th>
                  <th className="px-3 py-2 text-right">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((p) => {
                  const host = maskHost(p.website ?? p.homepage);
                  const c = counts[p.slug];
                  return (
                    <tr key={p.slug} className="hover:bg-surface/40">
                      <td className="px-3 py-2">
                        <Link
                          to="/providers/$slug"
                          params={{ slug: p.slug }}
                          className="inline-flex items-center gap-2 min-w-0"
                        >
                          <BrandIcon
                            url={p.website ?? p.homepage}
                            iconUrl={p.icon_url}
                            repoUrl={p.repo}
                            providerSlug={p.slug}
                            name={p.name ?? p.slug}
                            fallback={p.slug}
                            size={20}
                          />
                          <span className="font-medium text-ink-strong truncate">
                            {p.name ?? p.slug}
                          </span>
                          <span className="font-mono text-[10px] text-ink-muted truncate">
                            {p.slug}
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                        {p.kind ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {p.authority ? (
                          <span
                            className={classNames(
                              "font-mono text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5",
                              authorityTone(p.authority),
                            )}
                          >
                            {p.authority}
                          </span>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-muted truncate max-w-[22ch]">
                        {host ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                        {c?.subnets ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                        {c?.surfaces ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                        {c?.endpoints ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                        <TimeAgo at={typeof p.updated_at === "string" ? p.updated_at : undefined} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((p) => {
            const webHost = maskHost(p.website);
            const repoHost = maskHost(p.repo);
            const docsHost = maskHost(p.docs);
            const isOfficial = p.authority === "official";
            return (
              <EntityHoverCard key={p.slug} kind="provider" slug={p.slug}>
                <Link
                  to="/providers/$slug"
                  params={{ slug: p.slug }}
                  className={classNames(
                    "group block rounded-lg border border-border bg-card p-4 transition-colors",
                    "hover:border-accent/60 hover:shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-3 min-w-0">
                      <BrandIcon
                        url={p.website ?? p.homepage}
                        iconUrl={p.icon_url}
                        repoUrl={p.repo}
                        providerSlug={p.slug}
                        name={p.name ?? p.slug}
                        fallback={p.slug}
                        size={36}
                      />
                      <div className="min-w-0">
                        <div className="mg-label">{p.kind ?? "provider"}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {isOfficial ? (
                            <span
                              aria-label="Official provider"
                              title="Official"
                              className="inline-block size-1.5 rounded-full bg-accent shrink-0"
                            />
                          ) : null}
                          <div className="font-display text-base font-semibold text-ink-strong line-clamp-2 leading-tight">
                            {p.name ?? p.slug}
                          </div>
                        </div>
                        <div className="font-mono text-[10px] text-ink-muted truncate">
                          {p.slug}
                        </div>
                      </div>
                    </div>
                    {p.authority ? (
                      <span
                        className={classNames(
                          "font-mono text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5 shrink-0",
                          authorityTone(p.authority),
                        )}
                      >
                        {p.authority}
                      </span>
                    ) : null}
                  </div>
                  {p.notes ? (
                    <p className="mt-3 text-[12px] text-ink-muted leading-relaxed line-clamp-2">
                      {p.notes}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
                    {webHost ? (
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <Globe className="size-3 shrink-0" />
                        <span className="font-mono truncate max-w-[18ch]">{webHost}</span>
                      </span>
                    ) : null}
                    {repoHost ? (
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <Github className="size-3 shrink-0" />
                        <span className="font-mono truncate max-w-[18ch]">{repoHost}</span>
                      </span>
                    ) : null}
                    {docsHost ? (
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <BookOpen className="size-3 shrink-0" />
                        <span className="font-mono truncate max-w-[18ch]">{docsHost}</span>
                      </span>
                    ) : null}
                    {!webHost && !repoHost && !docsHost ? (
                      <span className="font-mono text-[10px]">no public links yet</span>
                    ) : null}
                    <TimeAgo
                      at={typeof p.updated_at === "string" ? p.updated_at : undefined}
                      className="font-mono"
                    />
                  </div>
                  <ProviderCountsRow counts={counts[p.slug]} />
                </Link>
              </EntityHoverCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProviderCountsRow({
  counts,
}: {
  counts?: { surfaces: number; endpoints: number; subnets: number };
}) {
  const s = counts?.surfaces ?? 0;
  const e = counts?.endpoints ?? 0;
  const n = counts?.subnets ?? 0;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
      <CountTile icon={<Layers className="size-3" />} label="Surfaces" value={s} />
      <CountTile icon={<Radio className="size-3" />} label="Endpoints" value={e} />
      <CountTile icon={<Network className="size-3" />} label="Subnets" value={n} />
    </div>
  );
}

function ProviderCardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[9px] uppercase tracking-wider text-ink-muted">{label}</span>
      <span className="font-mono text-[13px] tabular-nums text-ink-strong">{value}</span>
    </div>
  );
}

function CountTile({ icon, label, value }: { icon?: ReactNode; label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-ink-muted">
        {icon}
        {label}
      </span>
      <span
        className={classNames(
          "font-mono text-sm tabular-nums",
          value > 0 ? "text-ink-strong" : "text-ink-muted",
        )}
      >
        {value > 0 ? value : "—"}
      </span>
    </div>
  );
}

// #3353: compact source-health status-mix rollup for the /providers page — the
// summary-level companion to the full sortable provider table on /status, from
// the same /api/v1/source-health query already wired for that page. Suspends
// within the ProvidersGrid boundary alongside ProviderOverview.
function SourceHealthRollup() {
  const summary = useSuspenseQuery(sourceHealthProvidersQuery()).data.data.summary;
  const status = summary.status_counts;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 rounded border border-border bg-card p-3 font-mono text-[12px] tabular-nums">
      <span className="mg-label">Source health</span>
      <span className="text-health-ok">{status.ok ?? 0} ok</span>
      <span className="text-health-warn">{status.degraded ?? 0} degraded</span>
      <span className="text-health-down">{status.failed ?? 0} failed</span>
      <span className="text-ink-muted">{status.unknown ?? 0} unknown</span>
      <span className="ml-auto text-ink-muted">
        {summary.provider_count ?? 0} providers · {summary.endpoint_count ?? 0} endpoints
      </span>
    </div>
  );
}

function ProviderOverview({
  providers,
  counts,
}: {
  providers: Provider[];
  counts: Record<string, { surfaces: number; endpoints: number; subnets: number }>;
}) {
  const kinds = providers.reduce<Record<string, number>>((acc, p) => {
    const k = p.kind ?? "other";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const kindPalette = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)",
  ];
  const kindSegs = Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({ label, value, color: kindPalette[i % kindPalette.length]! }));

  // The /providers list omits per-provider endpoint_summary (only the detail
  // route has it), so derive the cross-provider endpoint health from the
  // endpoints collection directly.
  const endpoints = useSuspenseQuery(endpointsQuery({ limit: 1000 })).data.data ?? [];
  const endpointStatus = endpoints.reduce(
    (acc, e) => {
      const h = e.health ?? "unknown";
      if (h === "ok") acc.ok += 1;
      else if (h === "warn") acc.warn += 1;
      else if (h === "down") acc.down += 1;
      else acc.unknown += 1;
      return acc;
    },
    { ok: 0, warn: 0, down: 0, unknown: 0 },
  );
  const statusSegs = healthStatusSegments(endpointStatus, { warnLabel: "Warn" });

  // Top providers by endpoint count, as a sparkline of counts.
  const topCounts = providers
    .map((p) => counts[p.slug]?.endpoints ?? 0)
    .sort((a, b) => b - a)
    .slice(0, 20);
  const totalEndpoints = providers.reduce((a, p) => a + (counts[p.slug]?.endpoints ?? 0), 0);

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded border border-border bg-card p-3 flex items-center gap-4">
        <Donut
          segments={kindSegs}
          size={88}
          strokeWidth={11}
          centerLabel={String(providers.length)}
          centerSub="providers"
        />
        <div className="min-w-0 flex-1">
          <div className="mg-label mb-1">By kind</div>
          <DonutLegend segments={kindSegs.slice(0, 5)} />
        </div>
      </div>
      <div className="rounded border border-border bg-card p-3 flex items-center gap-4">
        <Donut
          segments={statusSegs}
          size={88}
          strokeWidth={11}
          centerLabel={String(
            endpointStatus.ok + endpointStatus.warn + endpointStatus.down + endpointStatus.unknown,
          )}
          centerSub="endpoints"
        />
        <div className="min-w-0 flex-1">
          <div className="mg-label mb-1">Endpoint health</div>
          <DonutLegend segments={statusSegs} />
        </div>
      </div>
      <div className="rounded border border-border bg-card p-3">
        <div className="mg-label mb-1">Top providers · endpoints</div>
        <div className="font-display text-lg font-semibold text-ink-strong tabular-nums">
          {totalEndpoints}
        </div>
        <Sparkline
          values={topCounts}
          width={260}
          height={48}
          ariaLabel="Top providers by endpoint count"
        />
        <div className="mt-1 font-mono text-[10px] text-ink-muted">
          across {providers.length} providers
        </div>
      </div>
    </div>
  );
}
