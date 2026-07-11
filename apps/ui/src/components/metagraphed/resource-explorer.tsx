import { Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Copy, Check, ExternalLink as ExternalLinkIcon, Filter, X } from "lucide-react";
import {
  subnetEndpointsQuery,
  subnetSurfacesQuery,
  rpcPoolsQuery,
  subnetSchemasQuery,
} from "@/lib/metagraphed/queries";
import { SchemaDriftSummary } from "@/components/metagraphed/schema-drift";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  HealthDot,
  CurationChip,
  ReviewChip,
  TimeAgo,
  safeExternalUrl,
} from "@jsonbored/ui-kit";
import { PanelShell } from "@/components/metagraphed/panel-shell";
import { useCopy } from "@/hooks/use-copy";
import { classNames } from "@/lib/metagraphed/format";
import {
  useSubnetFilter,
  ALL_SEVERITIES,
  type Severity,
} from "@/components/metagraphed/subnet-filter-context";
import type { Endpoint, RpcPool, Surface } from "@/lib/metagraphed/types";

type Seg = "endpoints" | "surfaces" | "schemas";

/**
 * Public resources slab — segmented view replacing the old "Endpoints at a
 * glance" + Surfaces + Schema Drift triple-card stack. One container, one
 * scan path.
 */

export function ResourceExplorer({ netuid }: { netuid: number }) {
  const [seg, setSeg] = useState<Seg>("endpoints");
  const filter = useSubnetFilter();
  const endpointOpts = subnetEndpointsQuery(netuid);
  const surfaceOpts = subnetSurfacesQuery(netuid);
  const schemaOpts = subnetSchemasQuery(netuid);
  const poolOpts = rpcPoolsQuery();

  const controls = (
    <div className="flex items-center gap-2">
      {/* Inline on sm+, sheet on mobile */}
      <div className="hidden sm:block">
        <SegmentBar value={seg} onChange={setSeg} />
      </div>
      <div className="sm:hidden">
        <SegmentBar value={seg} onChange={setSeg} compact />
      </div>
      <FiltersTrigger filter={filter} />
    </div>
  );

  return (
    <PanelShell
      id="endpoints-glance"
      title="Public resources"
      subtitle="Endpoints, curated surfaces, and tracked schemas for this subnet."
      info="Probe-derived health and curation metadata. Full detail lives in the dedicated tabs."
      right={controls}
      tone="accent"
      refreshQueryKeys={[
        endpointOpts.queryKey,
        surfaceOpts.queryKey,
        schemaOpts.queryKey,
        poolOpts.queryKey,
      ]}
    >
      {!filter.isAll ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-paper/40 px-2.5 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Filter
          </span>
          {ALL_SEVERITIES.filter((s) => filter.isActive(s)).map((s) => (
            <span
              key={s}
              className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-strong"
            >
              {s}
            </span>
          ))}
          <button
            type="button"
            onClick={filter.reset}
            className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> clear
          </button>
        </div>
      ) : null}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {seg === "endpoints" ? (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <EndpointsView netuid={netuid} filter={filter} />
          </Suspense>
        ) : null}
        {seg === "surfaces" ? (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <SurfacesView netuid={netuid} filter={filter} />
          </Suspense>
        ) : null}
        {seg === "schemas" ? (
          <div className="p-4">
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <SchemaDriftSummary netuid={netuid} />
            </Suspense>
          </div>
        ) : null}
      </div>
    </PanelShell>
  );
}

function FiltersTrigger({ filter }: { filter: ReturnType<typeof useSubnetFilter> }) {
  const activeCount = filter.isAll ? 0 : Array.from(filter.severity).length;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-ink-strong hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open resource filters"
        >
          <Filter className="size-3" />
          <span className="hidden sm:inline">Filters</span>
          {activeCount > 0 ? (
            <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">
              {activeCount}
            </span>
          ) : null}
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-xl">
        <SheetHeader>
          <SheetTitle>Filter resources by health</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex flex-wrap gap-2">
          {ALL_SEVERITIES.map((s) => {
            const active = filter.isActive(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => filter.toggle(s)}
                aria-pressed={active}
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                  active
                    ? "border-accent bg-accent/10 text-ink-strong"
                    : "border-border bg-card text-ink-muted hover:text-ink-strong",
                )}
              >
                <span
                  className={classNames(
                    "size-2 rounded-full",
                    s === "ok" && "bg-health-ok",
                    s === "warn" && "bg-health-warn",
                    s === "down" && "bg-health-down",
                    s === "unknown" && "bg-health-unknown/70",
                  )}
                />
                {s}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={filter.reset}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> Reset
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SegmentBar({
  value,
  onChange,
  compact,
}: {
  value: Seg;
  onChange: (s: Seg) => void;
  compact?: boolean;
}) {
  const segs: Array<{ id: Seg; label: string; short: string }> = [
    { id: "endpoints", label: "Endpoints", short: "EP" },
    { id: "surfaces", label: "Surfaces", short: "SF" },
    { id: "schemas", label: "Schemas", short: "SC" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Resource view"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {segs.map((s) => {
        const active = s.id === value;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.id)}
            className={classNames(
              "px-2.5 py-1 text-[11px] font-medium rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {compact ? s.short : s.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------- Endpoints ------------------------------ */

const KIND_ORDER = ["rpc", "wss", "archive", "api", "grpc", "sse", "data", "other"] as const;
const KIND_LABEL: Record<string, string> = {
  rpc: "RPC",
  wss: "WebSocket",
  archive: "Archive",
  api: "REST API",
  grpc: "gRPC",
  sse: "Server-sent events",
  data: "Data artifact",
  other: "Other",
};

function host(u?: string) {
  if (!u) return "—";
  try {
    return new URL(u).host;
  } catch {
    return u.replace(/^https?:\/\//, "").split("/")[0] ?? u;
  }
}
function pathOf(u?: string) {
  if (!u) return "";
  try {
    const url = new URL(u);
    const p = url.pathname + (url.search || "");
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

function EndpointsView({
  netuid,
  filter,
}: {
  netuid: number;
  filter: ReturnType<typeof useSubnetFilter>;
}) {
  const queryClient = useQueryClient();
  const endpointOpts = subnetEndpointsQuery(netuid);
  const poolOpts = rpcPoolsQuery();
  const epQ = useQuery(endpointOpts);
  const poolsQ = useQuery(poolOpts);
  const epRes = epQ.data;
  const allRows = (epRes?.data ?? []) as Endpoint[];
  void (poolsQ.data?.data as RpcPool[] | undefined);

  const retry = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: endpointOpts.queryKey, refetchType: "active" }),
      queryClient.invalidateQueries({ queryKey: poolOpts.queryKey, refetchType: "active" }),
    ]);

  if (epQ.isPending) return <Skeleton className="h-48 w-full" />;
  if (epQ.error) {
    return (
      <div className="p-4">
        <ErrorState error={epQ.error} onRetry={retry} context="endpoints" />
      </div>
    );
  }

  const rows = filter.isAll
    ? allRows
    : allRows.filter((e) => filter.isActive((e.health ?? "unknown") as Severity));
  const hidden = allRows.length - rows.length;

  if (allRows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No tracked endpoints"
          description="This is an empty registry state: no public RPC, WSS, SSE, API, or data endpoints are registered for this subnet yet."
          lastChecked={epRes?.meta?.generated_at}
        />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="All endpoints hidden by filter"
          description={`${hidden} endpoint${hidden === 1 ? "" : "s"} match other severities. Adjust the operational filter to see them.`}
          action={{ label: "Clear filter", href: "#health-trends" }}
        />
      </div>
    );
  }

  const groups = new Map<string, Endpoint[]>();
  for (const e of rows) {
    const k = String(e.kind ?? "other").toLowerCase();
    const slot = KIND_ORDER.includes(k as (typeof KIND_ORDER)[number]) ? k : "other";
    const arr = groups.get(slot) ?? [];
    arr.push(e);
    groups.set(slot, arr);
  }
  const ordered = KIND_ORDER.filter((k) => groups.has(k)).map((k) => ({
    kind: k,
    items: groups.get(k)!,
  }));

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2 bg-paper/40 border-b border-border">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {rows.length} endpoint{rows.length === 1 ? "" : "s"} · {ordered.length} kind
          {ordered.length === 1 ? "" : "s"}
          {hidden > 0 ? ` · ${hidden} hidden` : ""}
        </span>
        <Link
          to="/subnets/$netuid"
          params={{ netuid }}
          search={{ tab: "endpoints" }}
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-accent"
        >
          full table <ArrowRight className="size-3" />
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {ordered.map((g) => (
          <li key={g.kind}>
            <div className="flex items-center gap-2 px-4 py-1.5 bg-surface/30">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
                {KIND_LABEL[g.kind] ?? g.kind}
              </span>
              <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                {g.items.length}
              </span>
            </div>
            <ul>
              {g.items.slice(0, 5).map((e) => (
                <EndpointRow key={e.id} e={e} />
              ))}
              {g.items.length > 5 ? (
                <li className="px-4 py-1.5 font-mono text-[10px] text-ink-muted">
                  + {g.items.length - 5} more — open the Endpoints tab
                </li>
              ) : null}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EndpointRow({ e }: { e: Endpoint }) {
  const { copied, copy } = useCopy({ label: "endpoint url" });
  const safeUrl = safeExternalUrl(e.url);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-4 py-2 mg-row-hover">
      <HealthDot state={e.health} />
      <div className="min-w-0">
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <div className="flex items-baseline gap-1 min-w-0 cursor-default">
              <span className="font-mono text-[12px] text-ink-strong truncate">{host(e.url)}</span>
              {pathOf(e.url) ? (
                <span className="font-mono text-[11px] text-ink-muted truncate">
                  {pathOf(e.url)}
                </span>
              ) : null}
            </div>
          </TooltipTrigger>
          {e.url ? (
            <TooltipContent side="top" className="max-w-md break-all font-mono text-[11px]">
              {e.url}
            </TooltipContent>
          ) : null}
        </Tooltip>
        {e.provider || e.region ? (
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-muted">
            {e.provider ? (
              <Link
                to="/providers/$slug"
                params={{ slug: e.provider_slug ?? e.provider }}
                className="hover:text-ink-strong truncate"
              >
                {e.provider}
              </Link>
            ) : null}
            {e.region ? <span>· {e.region}</span> : null}
          </div>
        ) : null}
      </div>
      <span className="font-mono text-[10px] text-ink-muted tabular-nums">
        {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
      </span>
      <span className="hidden sm:inline font-mono text-[10px] text-ink-muted">
        <TimeAgo at={e.last_probed_at} />
      </span>
      <div className="inline-flex items-center gap-0.5">
        {e.url ? (
          <>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => copy(e.url!)}
                  aria-label="Copy endpoint URL"
                  className="rounded p-1 text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {copied ? (
                    <Check className="size-3 text-health-ok" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Copy URL
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                {safeUrl ? (
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open endpoint"
                    className="rounded p-1 text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <span
                    aria-label="Blocked unsafe endpoint URL"
                    className="cursor-not-allowed rounded p-1 text-ink-muted/50"
                  >
                    <ExternalLinkIcon className="size-3" />
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                {safeUrl ? "Open in new tab" : "Blocked unsafe URL"}
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------- Surfaces ------------------------------- */

function SurfacesView({
  netuid,
  filter,
}: {
  netuid: number;
  filter: ReturnType<typeof useSubnetFilter>;
}) {
  const queryClient = useQueryClient();
  const surfaceOpts = subnetSurfacesQuery(netuid);
  const surfaceQ = useQuery(surfaceOpts);
  const data = surfaceQ.data;
  const allRows = (data?.data ?? []) as Surface[];

  const retry = () =>
    queryClient.invalidateQueries({ queryKey: surfaceOpts.queryKey, refetchType: "active" });

  if (surfaceQ.isPending) return <Skeleton className="h-48 w-full" />;
  if (surfaceQ.error) {
    return (
      <div className="p-4">
        <ErrorState error={surfaceQ.error} onRetry={retry} context="verified surfaces" />
      </div>
    );
  }
  const rows = filter.isAll
    ? allRows
    : allRows.filter((s) =>
        filter.isActive(((s as unknown as { health?: string }).health ?? "unknown") as Severity),
      );
  const hidden = allRows.length - rows.length;
  if (allRows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No verified surfaces yet"
          description="This is an empty registry state: verified public interfaces have not been curated for this subnet yet. Candidates may exist in the Candidates tab."
          lastChecked={data?.meta?.generated_at}
        />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="All surfaces hidden by filter"
          description={`${hidden} surface${hidden === 1 ? "" : "s"} match other severities.`}
          action={{ label: "Clear filter", href: "#health-trends" }}
        />
      </div>
    );
  }
  const groups = new Map<string, Surface[]>();
  for (const s of rows) {
    const k = s.kind ?? "other";
    const arr = groups.get(k) ?? [];
    arr.push(s);
    groups.set(k, arr);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2 bg-paper/40 border-b border-border">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {rows.length} surface{rows.length === 1 ? "" : "s"} · {ordered.length} kind
          {ordered.length === 1 ? "" : "s"}
          {hidden > 0 ? ` · ${hidden} hidden` : ""}
        </span>
        <Link
          to="/subnets/$netuid"
          params={{ netuid }}
          search={{ tab: "surfaces" }}
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-accent"
        >
          full list <ArrowRight className="size-3" />
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {ordered.map(([kind, items]) => (
          <li key={kind}>
            <div className="flex items-center gap-2 px-4 py-1.5 bg-surface/30">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
                {kind}
              </span>
              <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                {items.length}
              </span>
            </div>
            <ul>
              {items.slice(0, 4).map((s) => (
                <SurfaceRow key={s.id} s={s} />
              ))}
              {items.length > 4 ? (
                <li className="px-4 py-1.5 font-mono text-[10px] text-ink-muted">
                  + {items.length - 4} more
                </li>
              ) : null}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SurfaceRow({ s }: { s: Surface }) {
  const safeUrl = safeExternalUrl(s.url);

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 mg-row-hover">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[12px] font-medium text-ink-strong">
            {s.name ?? s.url}
          </span>
          <CurationChip level={s.curation_level} />
          <ReviewChip state={s.review?.state} />
        </div>
        {s.url ? (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              {safeUrl ? (
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 block truncate font-mono text-[11px] text-ink-muted hover:text-ink-strong"
                >
                  {host(s.url)}
                  {pathOf(s.url) ? <span className="opacity-70">{pathOf(s.url)}</span> : null}
                </a>
              ) : (
                <span className="mt-0.5 block cursor-not-allowed truncate font-mono text-[11px] text-ink-muted/50">
                  {host(s.url)}
                  {pathOf(s.url) ? <span className="opacity-70">{pathOf(s.url)}</span> : null}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-md break-all font-mono text-[11px]">
              {safeUrl ? s.url : "Blocked unsafe URL"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <span className="font-mono text-[10px] text-ink-muted">
        <TimeAgo at={s.updated_at} />
      </span>
    </li>
  );
}
