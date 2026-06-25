import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Boxes, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import {
  MEGA_PANELS,
  loadFilters,
  loadRecent,
  loadPersistedOpen,
  persistFilter,
  persistOpen,
  type MegaPanel,
} from "./nav-mega-menu-data";

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
      Details not cached yet. <span className="text-accent-text">Open page →</span>
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

export function MegaPanelBody({
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
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline focus:underline underline-offset-4 focus:outline-none"
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

/* ───────────────────────── Mobile mega menu ───────────────────────── */

export function MobileMegaMenuBody({ onNavigate }: { onNavigate?: () => void }) {
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
                    className="inline-flex items-center gap-1 text-sm font-medium text-accent-text"
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
