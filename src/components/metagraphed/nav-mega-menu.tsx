import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertOctagon,
  ArrowUpRight,
  Boxes,
  FileCode,
  Layers,
  Network,
  RefreshCw,
  Search,
  Server,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { classNames } from "@/lib/metagraphed/format";
import {
  freshnessQuery,
  gapsQuery,
  healthQuery,
  providersQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { CopyButton } from "./copy-button";
import { safeExternalUrl } from "./external-link";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export interface MegaLink {
  to: string;
  search?: Record<string, string>;
  label: string;
  hint?: string;
  external?: string;
}

export interface MegaPanel {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
  apiPath: string;
  browse: MegaLink[];
  filters: MegaLink[];
}

export const MEGA_PANELS: MegaPanel[] = [
  {
    key: "subnets",
    to: "/subnets",
    label: "Subnets",
    icon: Layers,
    blurb: "All active Finney netuids and their curated profiles.",
    apiPath: "/api/v1/subnets",
    browse: [
      { to: "/subnets", label: "All subnets", hint: "Browse every active netuid" },
      {
        to: "/subnets",
        search: { curation: "verified" },
        label: "Curated",
        hint: "Maintainer-reviewed",
      },
      {
        to: "/subnets",
        search: { curation: "machine-verified" },
        label: "Machine-verified",
        hint: "Probed & confirmed",
      },
      { to: "/subnets/0", label: "Root (netuid 0)", hint: "Base-layer Subtensor" },
      { to: "/subnets/7", label: "Allways · SN7", hint: "Adapter-backed pilot" },
      { to: "/subnets/74", label: "Gittensor · SN74", hint: "Adapter-backed pilot" },
    ],
    filters: [
      { to: "/subnets", search: { kind: "api" }, label: "Has APIs" },
      { to: "/subnets", search: { kind: "docs" }, label: "Has docs" },
      { to: "/subnets", search: { kind: "sse" }, label: "Has SSE" },
      { to: "/subnets", search: { stale: "1" }, label: "Stale > 24h" },
    ],
  },
  {
    key: "surfaces",
    to: "/surfaces",
    label: "Surfaces",
    icon: Workflow,
    blurb: "Verified public interfaces across subnets.",
    apiPath: "/api/v1/surfaces",
    browse: [
      { to: "/surfaces", label: "All surfaces" },
      { to: "/surfaces", search: { kind: "openapi" }, label: "OpenAPI" },
      { to: "/surfaces", search: { kind: "docs" }, label: "Docs" },
      { to: "/surfaces", search: { kind: "dashboard" }, label: "Dashboards" },
      { to: "/surfaces", search: { kind: "data" }, label: "Data artifacts" },
      { to: "/surfaces", search: { kind: "sse" }, label: "SSE streams" },
    ],
    filters: [
      { to: "/surfaces", search: { public_safe: "1" }, label: "Public-safe only" },
      { to: "/surfaces", search: { auth: "required" }, label: "Auth required" },
      { to: "/surfaces", search: { rate_limited: "1" }, label: "Rate-limited" },
    ],
  },
  {
    key: "endpoints",
    to: "/endpoints",
    label: "Endpoints",
    icon: Server,
    blurb: "Root RPC/WSS plus generalized endpoint resources.",
    apiPath: "/api/v1/endpoints",
    browse: [
      { to: "/endpoints", label: "All endpoints" },
      { to: "/endpoints", search: { kind: "rpc" }, label: "Root RPC" },
      { to: "/endpoints", search: { kind: "wss" }, label: "WSS" },
      { to: "/endpoints", search: { archive: "1" }, label: "Archive-capable" },
      { to: "/endpoints", search: { pool: "eligible" }, label: "Pool-eligible" },
    ],
    filters: [
      { to: "/endpoints", search: { incidents: "recent" }, label: "Recent incidents" },
      { to: "/endpoints", search: { stale: "1" }, label: "Stale probes" },
    ],
  },
  {
    key: "providers",
    to: "/providers",
    label: "Providers",
    icon: Network,
    blurb: "Subnet teams, infra providers, and docs registries.",
    apiPath: "/api/v1/providers",
    browse: [
      { to: "/providers", label: "All providers" },
      { to: "/providers", search: { kind: "subnet-team" }, label: "Subnet teams" },
      { to: "/providers", search: { kind: "infra" }, label: "Infra providers" },
      { to: "/providers", search: { kind: "docs" }, label: "Docs registries" },
    ],
    filters: [
      { to: "/providers", search: { authority: "high" }, label: "Authority high" },
      { to: "/providers", search: { sort: "updated" }, label: "Recently updated" },
    ],
  },
  {
    key: "health",
    to: "/health",
    label: "Health",
    icon: Activity,
    blurb: "Probe-derived freshness and incident state.",
    apiPath: "/api/v1/health",
    browse: [
      { to: "/health", label: "Overview" },
      { to: "/health", search: { view: "matrix" }, label: "Subnet matrix" },
      { to: "/health", search: { view: "incidents" }, label: "Incidents" },
      { to: "/health", search: { view: "sources" }, label: "Source health" },
      { to: "/health", search: { view: "freshness" }, label: "Freshness" },
    ],
    filters: [
      { to: "/health", search: { status: "warn" }, label: "Degraded" },
      { to: "/health", search: { status: "down" }, label: "Down" },
    ],
  },
  {
    key: "schemas",
    to: "/schemas",
    label: "Schemas",
    icon: FileCode,
    blurb: "OpenAPI, contracts, and schema drift.",
    apiPath: "/api/v1/schemas",
    browse: [
      { to: "/schemas", label: "All schemas" },
      { to: "/schemas", search: { kind: "openapi" }, label: "OpenAPI" },
      { to: "/schemas", search: { kind: "contract" }, label: "Contracts" },
      { to: "/schemas", search: { drifted: "1" }, label: "Drifted" },
      { to: "/schemas", search: { view: "snapshots" }, label: "Snapshots" },
    ],
    filters: [],
  },
  {
    key: "gaps",
    to: "/gaps",
    label: "Gaps",
    icon: AlertOctagon,
    blurb: "Registry gaps, profile completeness, adapter candidates.",
    apiPath: "/api/v1/gaps",
    browse: [
      { to: "/gaps", search: { status: "open" }, label: "Open" },
      { to: "/gaps", search: { status: "in-review" }, label: "In review" },
      { to: "/gaps", search: { status: "resolved" }, label: "Resolved" },
      { to: "/gaps", search: { view: "adapters" }, label: "Adapter candidates" },
      { to: "/gaps", search: { view: "completeness" }, label: "Profile completeness" },
    ],
    filters: [
      { to: "/gaps", search: { priority: "high" }, label: "Priority high" },
      { to: "/gaps", search: { missing: "evidence" }, label: "Missing evidence" },
    ],
  },
];

const RECENT_KEY = "mg.recent-views";
const OPEN_KEY = "mg.mega-open";
const FILTER_KEY = "mg.mega-filter";

type RecentItem = { kind: "subnet" | "provider"; to: string; label: string };

function loadRecent(): RecentItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentItem[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function pushRecentView(item: RecentItem) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadRecent().filter((r) => r.to !== item.to);
    cur.unshift(item);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 5)));
  } catch {
    /* ignore */
  }
}

function loadPersistedOpen(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}
function persistOpen(key: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (key) window.sessionStorage.setItem(OPEN_KEY, key);
    else window.sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* ignore */
  }
}
function loadFilters(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(FILTER_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function persistFilter(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadFilters();
    if (value) cur[key] = value;
    else delete cur[key];
    window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

type SnapshotResult = {
  tiles: { label: string; value: number | string }[];
  isPending: boolean;
  isError: boolean;
};

function useSnapshot(key: string): SnapshotResult {
  const subnets = useQuery({
    ...subnetsQuery(),
    retry: 0,
    enabled: key === "subnets",
    placeholderData: (p) => p,
  });
  const health = useQuery({
    ...healthQuery(),
    retry: 0,
    enabled: key === "health" || key === "endpoints",
    placeholderData: (p) => p,
  });
  const fresh = useQuery({
    ...freshnessQuery(),
    retry: 0,
    enabled: key === "schemas" || key === "surfaces",
    placeholderData: (p) => p,
  });
  const gaps = useQuery({
    ...gapsQuery(),
    retry: 0,
    enabled: key === "gaps",
    placeholderData: (p) => p,
  });

  if (key === "subnets") {
    const all = subnets.data?.data ?? [];
    const total = all.length;
    const curated = all.filter((s) => s.curation_level && s.curation_level !== "native").length;
    return {
      tiles: [
        { label: "Active", value: total || "—" },
        { label: "Curated", value: curated || "—" },
      ],
      isPending: subnets.isPending,
      isError: subnets.isError,
    };
  }
  if (key === "health" || key === "endpoints") {
    const h = health.data?.data;
    return {
      tiles: [
        { label: "OK", value: h?.ok ?? "—" },
        { label: "Down", value: h?.down ?? "—" },
      ],
      isPending: health.isPending,
      isError: health.isError,
    };
  }
  if (key === "schemas" || key === "surfaces") {
    const f = fresh.data?.data;
    return {
      tiles: [
        { label: "Sources", value: f?.sources?.length ?? "—" },
        { label: "Stale", value: f?.stale_count ?? "—" },
      ],
      isPending: fresh.isPending,
      isError: fresh.isError,
    };
  }
  if (key === "gaps") {
    const list = gaps.data?.data ?? [];
    return {
      tiles: [
        { label: "Open", value: list.length || "—" },
        {
          label: "High",
          value: list.filter((g) => (g as { severity?: string }).severity === "high").length || "—",
        },
      ],
      isPending: gaps.isPending,
      isError: gaps.isError,
    };
  }
  return { tiles: [], isPending: false, isError: false };
}

const HEALTH_TONE: Record<string, string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  down: "bg-health-down",
  unknown: "bg-ink-subtle",
};

function PreviewSkeleton() {
  return (
    <div className="w-56 space-y-2 animate-pulse">
      <div className="h-3 w-20 rounded bg-surface" />
      <div className="h-4 w-32 rounded bg-surface" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-8 rounded bg-surface" />
        <div className="h-8 rounded bg-surface" />
      </div>
    </div>
  );
}

function PreviewMissing({ to }: { to: string }) {
  return (
    <div className="w-56 text-[11px] text-ink-muted">
      Details not cached yet. <span className="text-accent">Open page →</span>
      <span className="sr-only">{to}</span>
    </div>
  );
}

function PreviewError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="w-56 flex items-start gap-2">
      <div className="text-[11px] text-health-down flex-1">Preview unavailable.</div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-border bg-card p-1 text-ink-muted hover:text-ink-strong"
        aria-label="Retry preview"
      >
        <RefreshCw className="size-3" />
      </button>
    </div>
  );
}

function SubnetPreviewCard({ netuid }: { netuid: number }) {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    ...subnetsQuery(),
    retry: 0,
    placeholderData: (prev) => prev,
  });
  if (isPending) return <PreviewSkeleton />;
  if (isError)
    return (
      <PreviewError onRetry={() => qc.invalidateQueries({ queryKey: subnetsQuery().queryKey })} />
    );
  const sub = data?.data.find((s) => s.netuid === netuid);
  if (!sub) return <PreviewMissing to={`/subnets/${netuid}`} />;
  const health = (sub.health ?? "unknown") as string;
  return (
    <div className="space-y-2 w-56">
      <div className="flex items-center justify-between">
        <div className="mg-label">netuid {sub.netuid}</div>
        <span
          className={classNames(
            "inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest",
          )}
        >
          <span
            className={classNames(
              "size-1.5 rounded-full",
              HEALTH_TONE[health] ?? HEALTH_TONE.unknown,
            )}
          />
          {health}
        </span>
      </div>
      <div className="font-display text-sm font-semibold text-ink-strong truncate">
        {sub.name ?? `Subnet ${sub.netuid}`}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-ink-muted">Surfaces</div>
          <div className="mg-num text-ink-strong">{sub.surfaces_count ?? "—"}</div>
        </div>
        <div>
          <div className="text-ink-muted">Curation</div>
          <div className="text-ink-strong truncate">{sub.curation_level ?? "native"}</div>
        </div>
      </div>
    </div>
  );
}

function ProviderPreviewCard({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    ...providersQuery(),
    retry: 0,
    placeholderData: (prev) => prev,
  });
  if (isPending) return <PreviewSkeleton />;
  if (isError)
    return (
      <PreviewError onRetry={() => qc.invalidateQueries({ queryKey: providersQuery().queryKey })} />
    );
  const p = data?.data.find((x) => x.slug === slug);
  if (!p) return <PreviewMissing to={`/providers/${slug}`} />;
  return (
    <div className="space-y-2 w-56">
      <div className="mg-label">{p.kind ?? "provider"}</div>
      <div className="font-display text-sm font-semibold text-ink-strong truncate">
        {p.name ?? p.slug}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-ink-muted">Endpoints</div>
          <div className="mg-num text-ink-strong">{p.endpoints_count ?? "—"}</div>
        </div>
        <div>
          <div className="text-ink-muted">Surfaces</div>
          <div className="mg-num text-ink-strong">{p.surfaces_count ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

type LiveItem = {
  kind: "subnet" | "provider";
  to: string;
  params: Record<string, string>;
  label: string;
  sub: string;
  previewId: number | string;
};

// Module-level cache: (panelKey|filter) -> filtered slice. Stabilises object
// identity across re-renders and avoids redoing filter work for repeat queries
// during fast keyboard browsing.
const liveCache = new Map<string, LiveItem[]>();

function useLiveItems(
  panelKey: string,
  q: string,
): { items: LiveItem[]; isPending: boolean; isError: boolean; retry: () => void } {
  const qc = useQueryClient();
  const enabledSubnets = panelKey === "subnets";
  const enabledProviders = panelKey === "providers";
  const subnets = useQuery({
    ...subnetsQuery(),
    retry: 0,
    enabled: enabledSubnets,
    placeholderData: (prev) => prev,
  });
  const providers = useQuery({
    ...providersQuery(),
    retry: 0,
    enabled: enabledProviders,
    placeholderData: (prev) => prev,
  });
  const active = enabledSubnets ? subnets : enabledProviders ? providers : null;
  const ql = q.trim().toLowerCase();

  const items = useMemo<LiveItem[]>(() => {
    if (!ql) return [];
    const cacheKey = `${panelKey}|${ql}`;
    const cached = liveCache.get(cacheKey);
    if (cached) return cached;
    let out: LiveItem[] = [];
    if (enabledSubnets) {
      out = (subnets.data?.data ?? [])
        .filter(
          (s) =>
            String(s.netuid).includes(ql) ||
            (s.name ?? "").toLowerCase().includes(ql) ||
            (s.symbol ?? "").toLowerCase().includes(ql),
        )
        .slice(0, 6)
        .map((s) => ({
          kind: "subnet" as const,
          to: "/subnets/$netuid",
          params: { netuid: String(s.netuid) },
          label: s.name ?? `Subnet ${s.netuid}`,
          sub: `netuid ${s.netuid}${s.symbol ? ` · ${s.symbol}` : ""}`,
          previewId: s.netuid,
        }));
    } else if (enabledProviders) {
      out = (providers.data?.data ?? [])
        .filter(
          (p) => (p.name ?? "").toLowerCase().includes(ql) || p.slug.toLowerCase().includes(ql),
        )
        .slice(0, 6)
        .map((p) => ({
          kind: "provider" as const,
          to: "/providers/$slug",
          params: { slug: p.slug },
          label: p.name ?? p.slug,
          sub: p.kind ?? "provider",
          previewId: p.slug,
        }));
    }
    if (out.length > 0 || active?.data) liveCache.set(cacheKey, out);
    return out;
  }, [panelKey, ql, enabledSubnets, enabledProviders, subnets.data, providers.data, active?.data]);

  const isPending = (enabledSubnets || enabledProviders) && !!ql && !!active && active.isPending;
  const isError = !!active?.isError;
  const retry = () => {
    if (enabledSubnets) qc.invalidateQueries({ queryKey: subnetsQuery().queryKey });
    if (enabledProviders) qc.invalidateQueries({ queryKey: providersQuery().queryKey });
  };
  return { items, isPending, isError, retry };
}

function MegaPanelBody({
  panel,
  onNavigate,
  filterValue,
  onFilterChange,
  filterInputRef,
  registerItem,
}: {
  panel: MegaPanel;
  onNavigate: () => void;
  filterValue: string;
  onFilterChange: (v: string) => void;
  filterInputRef: React.RefObject<HTMLInputElement | null>;
  registerItem: (el: HTMLAnchorElement | null, idx: number) => void;
}) {
  const snapshot = useSnapshot(panel.key);
  const recents =
    panel.key === "subnets" || panel.key === "providers"
      ? loadRecent().filter((r) => r.kind === (panel.key === "subnets" ? "subnet" : "provider"))
      : [];

  const ql = filterValue.trim().toLowerCase();
  const browseFiltered = ql
    ? panel.browse.filter(
        (l) => l.label.toLowerCase().includes(ql) || (l.hint ?? "").toLowerCase().includes(ql),
      )
    : panel.browse;
  const filtersFiltered = ql
    ? panel.filters.filter((l) => l.label.toLowerCase().includes(ql))
    : panel.filters;
  const {
    items: live,
    isPending: liveLoading,
    isError: liveError,
    retry: liveRetry,
  } = useLiveItems(panel.key, filterValue);
  const supportsLive = panel.key === "subnets" || panel.key === "providers";
  const browseEmpty = browseFiltered.length === 0;
  const liveEmpty = live.length === 0;
  const showOverallEmpty =
    ql.length > 0 &&
    browseEmpty &&
    filtersFiltered.length === 0 &&
    liveEmpty &&
    !liveLoading &&
    !liveError;

  let idx = 0;
  const nextIdx = () => idx++;

  return (
    <div className="grid grid-cols-12 gap-6 p-6">
      {/* Inline filter */}
      <div className="col-span-12">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
            <input
              ref={filterInputRef}
              value={filterValue}
              onChange={(e) => onFilterChange(e.target.value)}
              placeholder={`Filter ${panel.label.toLowerCase()}…`}
              aria-label={`Filter ${panel.label}`}
              className="w-full rounded-md border border-border bg-card pl-8 pr-3 py-1.5 text-sm placeholder:text-ink-muted focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div className="hidden md:flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <span>type to jump</span>
            <span aria-hidden>·</span>
            <span>↑↓ move</span>
            <span aria-hidden>·</span>
            <span>⏎ open</span>
          </div>
        </div>
        {showOverallEmpty ? (
          <div className="mt-3 rounded-md border border-dashed border-ink-subtle bg-surface/40 px-3 py-2 text-[11px] text-ink-muted flex items-center justify-between">
            <span>
              No results for <span className="text-ink-strong">"{filterValue}"</span>.
            </span>
            <Link
              to={panel.to}
              onClick={onNavigate}
              className="text-accent hover:underline"
              preload="intent"
            >
              Open {panel.label} →
            </Link>
          </div>
        ) : null}
      </div>

      {/* Browse */}
      <div className="col-span-5">
        <div className="mg-label mb-3">Browse</div>
        {browseEmpty && !supportsLive ? (
          <div className="text-[11px] text-ink-muted">No matches in this section.</div>
        ) : browseEmpty ? null : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {browseFiltered.map((l) => {
              const i = nextIdx();
              return (
                <li key={`${l.to}-${l.label}`}>
                  <Link
                    to={l.to}
                    search={(l.search ?? undefined) as never}
                    onClick={onNavigate}
                    ref={(el) => registerItem(el, i)}
                    className="group/link block rounded-md px-2 py-1.5 -mx-2 hover:bg-surface/70 focus:bg-surface/70 focus:outline-none transition-colors"
                    preload="intent"
                  >
                    <div className="text-sm text-ink-strong group-hover/link:text-accent transition-colors">
                      {l.label}
                    </div>
                    {l.hint ? (
                      <div className="text-[11px] text-ink-muted truncate">{l.hint}</div>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {/* Live matches (subnets/providers) */}
        {supportsLive && ql ? (
          <div className="mt-4">
            <div className="mg-label mb-2">Matches</div>
            {liveLoading ? (
              <ul className="space-y-1.5" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="h-9 w-full rounded-md bg-surface animate-pulse" />
                ))}
              </ul>
            ) : liveError ? (
              <div className="flex items-center justify-between rounded-md border border-health-down/30 bg-health-down/5 px-2.5 py-1.5">
                <span className="text-[11px] text-health-down">
                  Couldn't load live {panel.label.toLowerCase()}.
                </span>
                <button
                  type="button"
                  onClick={liveRetry}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-strong hover:text-accent"
                >
                  <RefreshCw className="size-3" /> Retry
                </button>
              </div>
            ) : liveEmpty ? (
              <div className="text-[11px] text-ink-muted px-2 py-1.5">
                No live matches for "{filterValue}".
              </div>
            ) : (
              <ul className="space-y-0.5">
                {live.map((item) => {
                  const i = nextIdx();
                  return (
                    <li key={`${item.kind}-${String(item.previewId)}`}>
                      <HoverCard openDelay={150} closeDelay={80}>
                        <HoverCardTrigger asChild>
                          <Link
                            to={item.to}
                            params={item.params as never}
                            onClick={onNavigate}
                            ref={(el) => registerItem(el, i)}
                            className="flex items-center justify-between rounded-md px-2 py-1.5 -mx-2 hover:bg-surface/70 focus:bg-surface/70 focus:outline-none transition-colors"
                            preload="intent"
                          >
                            <span className="min-w-0">
                              <span className="block text-sm text-ink-strong truncate">
                                {item.label}
                              </span>
                              <span className="block text-[11px] text-ink-muted truncate">
                                {item.sub}
                              </span>
                            </span>
                            <ArrowUpRight className="size-3 text-ink-muted shrink-0" />
                          </Link>
                        </HoverCardTrigger>
                        <HoverCardContent side="right" align="start" className="w-auto p-3">
                          {item.kind === "subnet" ? (
                            <SubnetPreviewCard netuid={item.previewId as number} />
                          ) : (
                            <ProviderPreviewCard slug={item.previewId as string} />
                          )}
                        </HoverCardContent>
                      </HoverCard>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {recents.length > 0 && !ql ? (
          <div className="mt-5">
            <div className="mg-label mb-2">Recent</div>
            <ul className="flex flex-wrap gap-1">
              {recents.map((r) => {
                const i = nextIdx();
                return (
                  <li key={r.to}>
                    <Link
                      to={r.to}
                      onClick={onNavigate}
                      ref={(el) => registerItem(el, i)}
                      className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-ink hover:border-accent/40 hover:text-accent focus:border-accent/60 focus:outline-none transition-colors"
                      preload="intent"
                    >
                      {r.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>

      {/* Filters */}
      <div className="col-span-4">
        <div className="mg-label mb-3">Quick filters</div>
        {filtersFiltered.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {filtersFiltered.map((l) => {
              const i = nextIdx();
              return (
                <li key={l.label}>
                  <Link
                    to={l.to}
                    search={(l.search ?? undefined) as never}
                    onClick={onNavigate}
                    ref={(el) => registerItem(el, i)}
                    className="inline-flex items-center rounded-full border border-border bg-paper px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink-strong hover:border-accent/50 focus:border-accent/60 focus:outline-none transition-colors"
                    preload="intent"
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="text-[11px] text-ink-muted">No quick filters.</div>
        )}
      </div>

      {/* Snapshot */}
      <div className="col-span-3">
        <div className="mg-label mb-3">Live snapshot</div>
        {snapshot.isPending ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 rounded-md bg-surface animate-pulse" />
            ))}
          </div>
        ) : snapshot.isError ? (
          <div className="rounded-md border border-health-down/30 bg-health-down/5 px-2.5 py-2 text-[11px] text-health-down">
            Snapshot unavailable.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.tiles.map((s) => (
              <div key={s.label} className="rounded-md border border-border bg-paper p-2.5">
                <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">
                  {s.label}
                </div>
                <div className="mt-0.5 mg-num text-lg font-semibold text-ink-strong">{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="col-span-12 border-t border-border pt-4 flex items-center justify-between">
        <Link
          to={panel.to}
          onClick={onNavigate}
          ref={(el) => registerItem(el, nextIdx())}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline focus:underline underline-offset-4 focus:outline-none"
          preload="intent"
        >
          Open {panel.label}
          <ArrowUpRight className="size-3.5" />
        </Link>
        <div className="flex items-center gap-2 text-[11px] font-mono text-ink-muted">
          <span>{panel.apiPath}</span>
          <CopyButton value={`${API_BASE}${panel.apiPath}`} label={`${panel.apiPath} URL`} />
          <a
            href={safeExternalUrl(`${API_BASE}${panel.apiPath}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-ink-strong"
          >
            <Boxes className="size-3" /> JSON
          </a>
        </div>
      </div>
    </div>
  );
}

interface NavMegaMenuProps {
  onNavigate?: () => void;
}

export function NavMegaMenu({ onNavigate }: NavMegaMenuProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const qc = useQueryClient();
  const [openKey, setOpenKeyState] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const triggerRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const filterInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<Array<HTMLAnchorElement | null>>([]);
  const typeBufRef = useRef<string>("");
  const typeBufTimer = useRef<number | null>(null);

  // Prefetch the per-panel datasets on hover-intent so the panel never
  // appears with a blank snapshot / live area.
  const prefetchPanel = useCallback(
    (key: string) => {
      const opts =
        key === "subnets"
          ? subnetsQuery()
          : key === "providers"
            ? providersQuery()
            : key === "health" || key === "endpoints"
              ? healthQuery()
              : key === "schemas" || key === "surfaces"
                ? freshnessQuery()
                : key === "gaps"
                  ? gapsQuery()
                  : null;
      if (opts) void qc.prefetchQuery(opts as Parameters<typeof qc.prefetchQuery>[0]);
    },
    [qc],
  );

  // Restore persisted state once.
  useEffect(() => {
    setFilters(loadFilters());
    const k = loadPersistedOpen();
    if (k && MEGA_PANELS.some((p) => p.key === k)) setOpenKeyState(k);
  }, []);

  const setOpenKey = useCallback((k: string | null) => {
    setOpenKeyState(k);
    persistOpen(k);
  }, []);

  function scheduleOpen(key: string) {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    prefetchPanel(key);
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setOpenKey(key), 100);
  }
  function scheduleClose() {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpenKey(null), 160);
  }

  // Esc + outside click
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenKey(null);
        // return focus to trigger
        const k = openKey;
        if (k) triggerRefs.current[k]?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openKey, setOpenKey]);

  // Reset item count when panel changes
  useEffect(() => {
    itemsRef.current = [];
  }, [openKey, filters]);

  const activePanel = MEGA_PANELS.find((p) => p.key === openKey) ?? null;

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLAnchorElement>, key: string) {
    const idx = MEGA_PANELS.findIndex((p) => p.key === key);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = MEGA_PANELS[(idx + 1) % MEGA_PANELS.length];
      triggerRefs.current[next.key]?.focus();
      if (openKey) setOpenKey(next.key);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = MEGA_PANELS[(idx - 1 + MEGA_PANELS.length) % MEGA_PANELS.length];
      triggerRefs.current[prev.key]?.focus();
      if (openKey) setOpenKey(prev.key);
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      setOpenKey(key);
      // focus search box after open
      window.setTimeout(() => filterInputRef.current?.focus(), 30);
    } else if (e.key === "Escape") {
      setOpenKey(null);
    }
  }

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = itemsRef.current.filter(Boolean) as HTMLAnchorElement[];
    if (items.length === 0) return;
    const currentIdx = items.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = currentIdx < 0 ? 0 : Math.min(items.length - 1, currentIdx + 1);
      items[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentIdx <= 0) {
        filterInputRef.current?.focus();
      } else {
        items[currentIdx - 1]?.focus();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      document.activeElement !== filterInputRef.current
    ) {
      // Typeahead: append letter; jump to first item whose label starts
      // with the accumulated buffer. Buffer resets after 600 ms idle.
      typeBufRef.current += e.key.toLowerCase();
      if (typeBufTimer.current) window.clearTimeout(typeBufTimer.current);
      typeBufTimer.current = window.setTimeout(() => {
        typeBufRef.current = "";
      }, 600);
      const buf = typeBufRef.current;
      const start = Math.max(0, currentIdx);
      const ordered = [...items.slice(start + 1), ...items.slice(0, start + 1)];
      const match = ordered.find((el) =>
        (el.textContent ?? "").trim().toLowerCase().startsWith(buf),
      );
      if (match) {
        e.preventDefault();
        match.focus();
      }
    }
  }

  const registerItem = useCallback((el: HTMLAnchorElement | null, idx: number) => {
    itemsRef.current[idx] = el;
  }, []);

  return (
    <nav
      aria-label="Primary"
      className="hidden lg:flex items-center gap-0.5 relative"
      onMouseLeave={scheduleClose}
    >
      {MEGA_PANELS.map((p) => {
        const active = pathname === p.to || pathname.startsWith(p.to + "/");
        const isOpen = openKey === p.key;
        const Icon = p.icon;
        return (
          <div
            key={p.key}
            onMouseEnter={() => scheduleOpen(p.key)}
            onFocus={() => scheduleOpen(p.key)}
          >
            <Link
              to={p.to}
              ref={(el) => {
                triggerRefs.current[p.key] = el;
              }}
              aria-current={active ? "page" : undefined}
              aria-expanded={isOpen}
              aria-haspopup="true"
              onKeyDown={(e) => onTriggerKeyDown(e, p.key)}
              className={classNames(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 h-9 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                active || isOpen
                  ? "text-ink-strong font-medium"
                  : "text-ink-muted hover:text-ink-strong",
              )}
              onClick={() => {
                setOpenKey(null);
                onNavigate?.();
              }}
              preload="intent"
            >
              <Icon className={classNames("size-3.5", active ? "text-accent" : "opacity-70")} />
              <span>{p.label}</span>
              {active ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 right-2.5 -bottom-[13px] h-px bg-accent"
                />
              ) : null}
            </Link>
          </div>
        );
      })}
      <Link
        to="/about"
        className={classNames(
          "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 h-9 text-sm transition-colors",
          pathname === "/about"
            ? "text-ink-strong font-medium"
            : "text-ink-muted hover:text-ink-strong",
        )}
        preload="intent"
      >
        About
      </Link>

      {activePanel ? (
        <>
          <div aria-hidden className="mg-mega-scrim" onClick={() => setOpenKey(null)} />
          <div
            className="absolute left-1/2 -translate-x-1/2 top-full mt-3 z-40"
            role="dialog"
            aria-label={`${activePanel.label} menu`}
            onKeyDown={onPanelKeyDown}
            onMouseEnter={() => {
              if (closeTimer.current) {
                window.clearTimeout(closeTimer.current);
                closeTimer.current = null;
              }
            }}
            onMouseLeave={scheduleClose}
          >
            <div className="w-[min(960px,calc(100vw-3rem))] rounded-xl mg-mega-surface mg-fade-in overflow-hidden">
              <div className="px-6 pt-5 pb-2 flex items-center gap-2 border-b border-border/70">
                <activePanel.icon className="size-3.5 text-accent" />
                <span className="font-display text-sm font-semibold text-ink-strong">
                  {activePanel.label}
                </span>
                <span className="text-[12px] text-ink-muted">— {activePanel.blurb}</span>
              </div>
              <MegaPanelBody
                panel={activePanel}
                filterValue={filters[activePanel.key] ?? ""}
                onFilterChange={(v) => {
                  setFilters((prev) => ({ ...prev, [activePanel.key]: v }));
                  persistFilter(activePanel.key, v);
                }}
                filterInputRef={filterInputRef}
                registerItem={registerItem}
                onNavigate={() => {
                  setOpenKey(null);
                  onNavigate?.();
                }}
              />
            </div>
          </div>
        </>
      ) : null}
    </nav>
  );
}

/* ───────────────────────── Mobile mega menu ───────────────────────── */

export function MobileMegaMenu({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState<string | undefined>(() => {
    const k = loadPersistedOpen();
    return k ?? undefined;
  });
  const [filters, setFilters] = useState<Record<string, string>>(() => loadFilters());

  useEffect(() => {
    persistOpen(open ?? null);
  }, [open]);

  return (
    <div className="flex flex-col gap-1">
      <Accordion
        type="single"
        collapsible
        value={open}
        onValueChange={(v) => setOpen(v || undefined)}
      >
        {MEGA_PANELS.map((p) => {
          const Icon = p.icon;
          const active = pathname === p.to || pathname.startsWith(p.to + "/");
          const f = filters[p.key] ?? "";
          const ql = f.trim().toLowerCase();
          const browse = ql
            ? p.browse.filter(
                (l) =>
                  l.label.toLowerCase().includes(ql) || (l.hint ?? "").toLowerCase().includes(ql),
              )
            : p.browse;
          const quick = ql
            ? p.filters.filter((l) => l.label.toLowerCase().includes(ql))
            : p.filters;
          return (
            <AccordionItem key={p.key} value={p.key} className="border-border">
              <AccordionTrigger className="px-2 py-2.5 hover:no-underline">
                <span className="flex items-center gap-2 text-sm">
                  <Icon
                    className={classNames("size-3.5", active ? "text-accent" : "text-ink-muted")}
                  />
                  <span className={active ? "text-ink-strong font-medium" : "text-ink"}>
                    {p.label}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="pb-3">
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
                    <input
                      value={f}
                      onChange={(e) => {
                        const v = e.target.value;
                        setFilters((prev) => ({ ...prev, [p.key]: v }));
                        persistFilter(p.key, v);
                      }}
                      placeholder={`Filter ${p.label.toLowerCase()}…`}
                      aria-label={`Filter ${p.label}`}
                      className="w-full rounded-md border border-border bg-card pl-8 pr-3 py-1.5 text-sm placeholder:text-ink-muted focus:outline-none focus:border-accent/60"
                    />
                  </div>
                  {browse.length > 0 ? (
                    <ul className="grid grid-cols-1 gap-0.5">
                      {browse.map((l) => (
                        <li key={`${l.to}-${l.label}`}>
                          <Link
                            to={l.to}
                            search={(l.search ?? undefined) as never}
                            onClick={onNavigate}
                            className="block rounded-md px-2 py-2 text-sm text-ink-strong hover:bg-surface/70"
                            preload="intent"
                          >
                            {l.label}
                            {l.hint ? (
                              <span className="block text-[11px] text-ink-muted">{l.hint}</span>
                            ) : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {quick.length > 0 ? (
                    <div>
                      <div className="mg-label mb-1.5">Quick filters</div>
                      <ul className="flex flex-wrap gap-1.5">
                        {quick.map((l) => (
                          <li key={l.label}>
                            <Link
                              to={l.to}
                              search={(l.search ?? undefined) as never}
                              onClick={onNavigate}
                              className="inline-flex items-center rounded-full border border-border bg-paper px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink-strong"
                              preload="intent"
                            >
                              {l.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <Link
                    to={p.to}
                    onClick={onNavigate}
                    className="inline-flex items-center gap-1 text-sm font-medium text-accent"
                    preload="intent"
                  >
                    Open {p.label} <ArrowUpRight className="size-3" />
                  </Link>
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
      <Link
        to="/about"
        onClick={onNavigate}
        className={classNames(
          "rounded-md px-3 py-2.5 text-sm",
          pathname === "/about" ? "text-ink-strong font-medium" : "text-ink-muted",
        )}
        preload="intent"
      >
        About
      </Link>
    </div>
  );
}
