import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo, useState, useEffect } from "react";
import { Search, X, ChevronDown, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { HealthPill, HealthDot } from "@/components/metagraphed/chips";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { EmptyState, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { SectionHeading } from "@/components/metagraphed/section-heading";
import { PageHero } from "@/components/metagraphed/page-hero";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { Radio, Server, ShieldCheck, Activity } from "lucide-react";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { IncidentCard } from "@/components/metagraphed/incident-card";
import { LatencyHeatmap } from "@/components/metagraphed/charts/latency-heatmap";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EndpointKindTabs } from "@/components/metagraphed/endpoint-kind-tabs";
import { ProxyHero, ProxyUsagePanel } from "@/components/metagraphed/rpc-proxy";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
import { endpointsQuery, endpointIncidentsQuery, rpcPoolsQuery } from "@/lib/metagraphed/queries";
import {
  endpointCategory,
  endpointEligibility,
  indexPoolsById,
  ELIGIBILITY_LABEL,
  ELIGIBILITY_TONE,
  type EndpointCategory,
  type PoolEligibility,
} from "@/lib/metagraphed/endpoint-pool";

import type { Endpoint, EndpointIncident, HealthState, RpcPool } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/endpoints")({
  head: () => ({
    meta: [
      { title: "Endpoints — Metagraphed" },
      {
        name: "description",
        content:
          "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility.",
      },
      { property: "og:title", content: "Endpoints — Metagraphed" },
      {
        property: "og:description",
        content:
          "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility.",
      },
    ],
  }),
  component: EndpointsPage,
});

function EndpointsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Infrastructure"
        live
        title="Endpoints"
        description="A load-balanced reverse proxy for Bittensor RPC, plus the registry of callable Subtensor and subnet endpoints behind it."
      />
      <div className="space-y-section">
        {/* The headline feature: the live reverse proxy + its usage analytics. */}
        <section>
          <ProxyHero />
        </section>
        <section>
          <SectionHeading title="Proxy usage" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>
              <ProxyUsagePanel />
            </Suspense>
          </QueryErrorBoundary>
        </section>

        <QueryErrorBoundary>
          <Suspense
            fallback={
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            }
          >
            <EndpointsStatStrip />
          </Suspense>
        </QueryErrorBoundary>

        <section>
          <SectionHeading title="Latency by provider" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <LatencyHeatmapSection />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <SectionHeading title="RPC pools" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <PoolsTable />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <SectionHeading title="Callable endpoints" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <EndpointsTable />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <SectionHeading title="Recent incidents" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <IncidentsSection />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter
        paths={[
          "/rpc/v1/finney",
          "/api/v1/rpc/usage",
          "/api/v1/endpoints",
          "/api/v1/rpc/pools",
          "/api/v1/endpoint-incidents",
        ]}
      />
    </AppShell>
  );
}

function EndpointsStatStrip() {
  const rows = (useSuspenseQuery(endpointsQuery()).data.data ?? []) as Endpoint[];
  const pools = (useSuspenseQuery(rpcPoolsQuery()).data.data ?? []) as RpcPool[];
  const total = rows.length;
  const archive = rows.filter((e) => e.archive).length;
  const proxy = pools.filter((p) => p.proxy_enabled).length;
  const ok = rows.filter((e) => e.health === "ok").length;
  const okPct = total > 0 ? Math.round((ok / total) * 100) : null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile icon={Radio} eyebrow="Endpoints" value={total} hint="tracked" />
      <StatTile
        icon={Server}
        eyebrow="RPC pools"
        value={pools.length}
        hint={proxy ? `${proxy} proxy` : undefined}
        tone="accent"
      />
      <StatTile icon={ShieldCheck} eyebrow="Archive-capable" value={archive} />
      <StatTile
        icon={Activity}
        eyebrow="Healthy"
        value={okPct != null ? `${okPct}%` : "—"}
        hint={`${ok}/${total}`}
        tone={okPct != null && okPct > 90 ? "ok" : okPct != null && okPct < 70 ? "warn" : "default"}
      />
    </div>
  );
}

function LatencyHeatmapSection() {
  const rows = (useSuspenseQuery(endpointsQuery()).data.data ?? []) as Endpoint[];
  return <LatencyHeatmap endpoints={rows} />;
}

function PoolsTable() {
  const { data } = useSuspenseQuery(rpcPoolsQuery());
  const rows = (data.data ?? []) as RpcPool[];
  const stale = isStaleFreshness(data.meta?.generated_at);
  if (rows.length === 0)
    return (
      <EmptyState
        title="No RPC pools tracked"
        description="The proxy routes across registered pools — pool members and their eligibility appear here once registered."
      />
    );
  return (
    <div className="space-y-2">
      {stale ? <StaleBanner generatedAt={data.meta?.generated_at} /> : null}
      <div className="rounded border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Pool</th>
              <th className="px-3 py-2 text-left">Region</th>
              <th className="px-3 py-2 text-right">Members</th>
              <th className="px-3 py-2">Archive</th>
              <th className="px-3 py-2">Eligibility</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((p) => {
              const eligibility: PoolEligibility = p.proxy_enabled
                ? "proxy-enabled"
                : p.archive_capable
                  ? "archive-capable"
                  : "pool-member";
              return (
                <tr key={p.id} className="mg-row-hover">
                  <td className="px-3 py-2 font-medium text-ink-strong">{p.name ?? p.id}</td>
                  <td className="px-3 py-2 text-[12px]">{p.region ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">{p.members_count ?? "—"}</td>
                  <td className="px-3 py-2 text-[11px] text-ink-muted">
                    {p.archive_capable ? "yes" : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={classNames(
                        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest",
                        ELIGIBILITY_TONE[eligibility],
                      )}
                    >
                      {ELIGIBILITY_LABEL[eligibility]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-1 font-mono text-[10px] text-ink-muted">
        Proxy-eligible members serve live traffic through the reverse proxy above; the proxy prefers
        in-sync, healthy nodes and fails over automatically.
      </p>
    </div>
  );
}

type SortKey = "netuid" | "kind" | "provider" | "region" | "health" | "latency" | "probed";
type SortOrder = "asc" | "desc";

const HEALTH_RANK: Record<string, number> = { ok: 0, warn: 1, down: 2, unknown: 3 };

function endpointValue(e: Endpoint, k: SortKey): string | number | null {
  switch (k) {
    case "netuid":
      return e.netuid ?? null;
    case "kind":
      return e.kind ?? "";
    case "provider":
      return e.provider ?? e.provider_slug ?? "";
    case "region":
      return e.region ?? "";
    case "health":
      return HEALTH_RANK[String(e.health ?? "unknown")] ?? 99;
    case "latency":
      return e.latency_ms ?? Number.POSITIVE_INFINITY;
    case "probed":
      return e.last_probed_at ? Date.parse(e.last_probed_at) : 0;
  }
}

function EndpointsTable() {
  const { data } = useSuspenseQuery(endpointsQuery());
  const { data: poolsRes } = useSuspenseQuery(rpcPoolsQuery());
  const rows = useMemo(() => (data.data ?? []) as Endpoint[], [data]);
  const pools = useMemo(() => (poolsRes.data ?? []) as RpcPool[], [poolsRes]);
  const poolsById = useMemo(() => indexPoolsById(pools), [pools]);

  const [q, setQ] = useState("");
  const [callableOnly, setCallableOnly] = useState(true);
  const [category, setCategory] = useState<EndpointCategory | "all">("all");
  const [provider, setProvider] = useState<string>("");
  const [health, setHealth] = useState<string>("");
  const [netuid, setNetuid] = useState<string>("");
  const [region, setRegion] = useState<string>("");
  const [eligibility, setEligibility] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("netuid");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const providers = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.provider ?? r.provider_slug).filter(Boolean) as string[]),
      ).sort(),
    [rows],
  );
  const regions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.region).filter(Boolean) as string[])).sort(),
    [rows],
  );

  // Pre-compute category + eligibility per endpoint once.
  const enriched = useMemo(
    () =>
      rows.map((e) => ({
        e,
        cat: endpointCategory(e.kind),
        eli: endpointEligibility(e, poolsById),
      })),
    [rows, poolsById],
  );

  // "Callable" = anything an agent can actually POST/GET against (rpc/wss/api/
  // sse/data). The registry also carries non-callable directory links (websites,
  // docs, dashboards → category "other"); those are hidden by default so the
  // table answers "what can I call?" rather than burying it under reference URLs.
  const directoryCount = useMemo(
    () => enriched.filter((x) => x.cat === "other").length,
    [enriched],
  );
  const scoped = useMemo(
    () => (callableOnly ? enriched.filter((x) => x.cat !== "other") : enriched),
    [enriched, callableOnly],
  );

  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<EndpointCategory | "all", number>> = { all: scoped.length };
    for (const x of scoped) counts[x.cat] = (counts[x.cat] ?? 0) + 1;
    return counts;
  }, [scoped]);

  const netuidNum = netuid.trim() === "" ? null : Number(netuid);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return scoped
      .filter(({ e, cat, eli }) => {
        if (category !== "all" && cat !== category) return false;
        if (provider && (e.provider ?? e.provider_slug) !== provider) return false;
        if (health && (e.health ?? "unknown") !== health) return false;
        if (region && e.region !== region) return false;
        if (eligibility && eli !== eligibility) return false;
        if (netuidNum != null && Number.isFinite(netuidNum) && e.netuid !== netuidNum) return false;
        if (!needle) return true;
        return [e.url, e.provider, e.provider_slug, e.region, String(e.netuid ?? ""), e.kind, e.id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle));
      })
      .map((x) => x.e);
  }, [scoped, q, category, provider, health, region, eligibility, netuidNum]);

  const sorted = useMemo(() => {
    const mul = sortOrder === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = endpointValue(a, sortKey);
      const vb = endpointValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [filtered, sortKey, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const hasFilters =
    q || category !== "all" || provider || health || netuid || region || eligibility;

  // Reset to page 1 whenever any filter changes.
  useEffect(() => {
    setPage(1);
  }, [q, category, provider, health, netuid, region, eligibility]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortOrder("asc");
    }
  }

  if (rows.length === 0) return <EmptyState title="No endpoints" />;

  return (
    <div className="space-y-3">
      {/* Kind chip rail */}
      <EndpointKindTabs value={category} counts={categoryCounts} onChange={setCategory} />

      {/* Toolbar */}
      <div className="sticky top-14 z-10 -mx-1 px-1 py-2 backdrop-blur bg-paper/85 border-b border-border/60 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search URL, provider, netuid…"
            className="w-full rounded border border-border bg-card pl-7 pr-2 py-1.5 text-[12px] focus:outline-none focus:border-ink/30"
            aria-label="Search endpoints"
          />
        </div>
        <label className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
          <span className="font-mono uppercase tracking-widest text-[10px]">Netuid</span>
          <input
            value={netuid}
            onChange={(e) => setNetuid(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="any"
            className="w-16 rounded border border-border bg-card px-1.5 py-1 text-[11px] focus:outline-none focus:border-ink/30"
            aria-label="Filter by netuid"
          />
        </label>
        <FilterSelect
          label="Provider"
          value={provider}
          onChange={setProvider}
          options={providers}
        />
        <FilterSelect label="Region" value={region} onChange={setRegion} options={regions} />
        <FilterSelect
          label="Health"
          value={health}
          onChange={setHealth}
          options={["ok", "warn", "down", "unknown"]}
        />
        <FilterSelect
          label="Eligibility"
          value={eligibility}
          onChange={setEligibility}
          options={["proxy-enabled", "pool-member", "archive-capable", "unassigned"]}
        />
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setCategory("all");
              setProvider("");
              setHealth("");
              setNetuid("");
              setRegion("");
              setEligibility("");
            }}
            className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> Clear
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setCallableOnly((v) => {
              if (!v && category === "other") setCategory("all");
              return !v;
            });
          }}
          aria-pressed={callableOnly}
          title={
            callableOnly
              ? `Showing callable endpoints — ${directoryCount} directory links hidden`
              : "Showing all endpoints, including directory links"
          }
          className={classNames(
            "ml-auto inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
            callableOnly
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border bg-card text-ink-muted hover:text-ink-strong",
          )}
        >
          <span className={classNames("size-1.5 rounded-full", callableOnly && "bg-accent")} />
          Callable only
          {directoryCount > 0 ? (
            <span className="text-ink-muted">· {directoryCount} links</span>
          ) : null}
        </button>
        <span className="font-mono text-[10px] text-ink-muted">
          {sorted.length} of {scoped.length}
        </span>
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="No endpoints match this filter" />
      ) : (
        <>
          <div className="rounded border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
                <tr>
                  <Th
                    label="Netuid"
                    k="netuid"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                  />
                  <Th
                    label="Kind"
                    k="kind"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                  />
                  <th className="px-3 py-2 text-left">URL</th>
                  <Th
                    label="Provider"
                    k="provider"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                  />
                  <Th
                    label="Region"
                    k="region"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                  />
                  <Th
                    label="Health"
                    k="health"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                    align="center"
                  />
                  <Th
                    label="Latency"
                    k="latency"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                    align="right"
                  />
                  <Th
                    label="Probed"
                    k="probed"
                    sortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                    align="right"
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageRows.map((e) => (
                  <tr key={e.id} className="hover:bg-surface/40">
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                      {e.netuid != null ? (
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: e.netuid }}
                          className="hover:text-ink-strong"
                        >
                          {String(e.netuid).padStart(3, "0")}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px] max-w-[36ch]">
                      {e.url ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <ExternalLink href={e.url} className="truncate text-[11px]">
                            {e.url}
                          </ExternalLink>
                          <CopyButton value={e.url} label="URL" />
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {e.provider ?? e.provider_slug ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[12px]">{e.region ?? "—"}</td>
                    <td className="px-3 py-2 text-center">
                      <HealthPill state={e.health} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                      <TimeAgo at={e.last_probed_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 px-1 py-1 text-[11px] text-ink-muted">
            <span className="font-mono">
              Page {safePage} of {totalPages} · showing {pageRows.length} of {sorted.length}
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <label htmlFor="ep-page-size" className="font-mono">
                Per page
              </label>
              <select
                id="ep-page-size"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="rounded border border-border bg-card px-1 py-0.5 text-[11px]"
              >
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </span>
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-border bg-card px-2 py-0.5 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border border-border bg-card px-2 py-0.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortOrder,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortOrder: SortOrder;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const active = sortKey === k;
  const arrow = active ? (sortOrder === "asc" ? "▲" : "▼") : "";
  const alignCls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th className={classNames("px-3 py-2", alignCls)}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={classNames(
          "inline-flex items-center gap-1 uppercase tracking-widest hover:text-ink-strong",
          active ? "text-ink-strong" : "text-ink-muted",
        )}
      >
        {label}
        <span className="text-[8px]">{arrow}</span>
      </button>
    </th>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
      <span className="font-mono uppercase tracking-widest text-[10px]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-card px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-ink/30"
      >
        <option value="">all</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Same host-grouping shape as /health so incidents read the same way in
 * both places. State filter chips + show-more toggle.
 */
function hostKeyFromEndpointId(id: unknown): string {
  if (id === null || id === undefined || id === "") return "—";
  const text = String(id);
  const m = text.match(/^endpoint-sn-?\d+-(.+)$/i);
  return m ? m[1]! : text;
}

function severityRank(state: HealthState | undefined): number {
  if (state === "down") return 3;
  if (state === "warn") return 2;
  if (state === "unknown") return 1;
  return 0;
}

type StateFilter = "all" | "down" | "warn" | "resolved";

function IncidentsSection() {
  const { data } = useSuspenseQuery(endpointIncidentsQuery());
  const rows = useMemo(() => (data.data ?? []) as EndpointIncident[], [data]);
  const [filter, setFilter] = useState<StateFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const filtered = useMemo(
    () =>
      rows.filter((i) => {
        const ongoing = !i.ended_at;
        if (filter === "all") return true;
        if (filter === "down") return ongoing && i.state === "down";
        if (filter === "warn") return ongoing && i.state === "warn";
        if (filter === "resolved") return !ongoing;
        return true;
      }),
    [rows, filter],
  );

  const groups = useMemo(() => {
    const byHost = new Map<string, EndpointIncident[]>();
    for (const i of filtered) {
      const key = hostKeyFromEndpointId(i.endpoint_id);
      const list = byHost.get(key) ?? [];
      list.push(i);
      byHost.set(key, list);
    }
    return Array.from(byHost.entries())
      .map(([host, items]) => {
        const ongoing = items.filter((i) => !i.ended_at).length;
        const top = items.reduce<EndpointIncident>(
          (acc, cur) => (severityRank(cur.state) > severityRank(acc.state) ? cur : acc),
          items[0]!,
        );
        return { host, items, ongoing, dominantState: top.state };
      })
      .sort((a, b) => {
        const sev = severityRank(b.dominantState) - severityRank(a.dominantState);
        if (sev !== 0) return sev;
        return b.items.length - a.items.length;
      });
  }, [filtered]);

  if (rows.length === 0) return <EmptyState title="No incidents in window" />;

  const FILTER_OPTIONS: Array<{ value: StateFilter; label: string; count: number }> = [
    { value: "all", label: "All", count: rows.length },
    {
      value: "down",
      label: "Down",
      count: rows.filter((i) => !i.ended_at && i.state === "down").length,
    },
    {
      value: "warn",
      label: "Degraded",
      count: rows.filter((i) => !i.ended_at && i.state === "warn").length,
    },
    { value: "resolved", label: "Resolved", count: rows.filter((i) => i.ended_at).length },
  ];

  const INITIAL = 8;
  const visible = showAll ? groups : groups.slice(0, INITIAL);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {FILTER_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              setFilter(o.value);
              setShowAll(false);
            }}
            className={classNames(
              "inline-flex items-center gap-1 rounded border px-2 py-1 font-mono uppercase tracking-widest transition-colors",
              filter === o.value
                ? "border-ink/40 bg-surface text-ink-strong"
                : "border-border bg-card text-ink-muted hover:text-ink",
            )}
          >
            {o.label}
            <span className="text-[10px] tabular-nums opacity-80">{o.count}</span>
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          {groups.length} {groups.length === 1 ? "host" : "hosts"} · {filtered.length} incidents
        </span>
      </div>
      {groups.length === 0 ? (
        <EmptyState title="No incidents match this filter" />
      ) : (
        <>
          <ul className="space-y-2">
            {visible.map((g) => {
              const open = !!openGroups[g.host];
              if (g.items.length === 1) return <IncidentCard key={g.host} incident={g.items[0]!} />;
              return (
                <li key={g.host} className="rounded border border-border bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenGroups((s) => ({ ...s, [g.host]: !open }))}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface/40 transition-colors min-h-11"
                    aria-expanded={open}
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 text-ink-muted shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 text-ink-muted shrink-0" />
                    )}
                    <HealthDot state={g.dominantState} />
                    <span className="font-mono text-[12px] text-ink-strong truncate">{g.host}</span>
                    <span className="ml-auto inline-flex items-center gap-2 mg-label shrink-0">
                      {g.ongoing > 0 ? (
                        <span className="text-health-down">{g.ongoing} ongoing</span>
                      ) : null}
                      <span>{g.items.length} total</span>
                    </span>
                  </button>
                  {open ? (
                    <ul className="grid gap-2 p-2 md:grid-cols-2 border-t border-border bg-paper/40">
                      {g.items.map((i) => (
                        <IncidentCard key={i.id} incident={i} />
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {groups.length > INITIAL ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="block w-full rounded border border-border bg-card px-3 py-2 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30 min-h-9"
            >
              {showAll ? "Show fewer" : `Show all ${groups.length} grouped incidents`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
