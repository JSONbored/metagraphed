import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Activity,
  ArrowRightLeft,
  Bot,
  Braces,
  BookOpen,
  Code2,
  Compass,
  Copy,
  ExternalLink,
  FileJson,
  Gauge,
  GitBranch,
  Hash,
  History,
  KeyRound,
  Layers,
  Network,
  Rss,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  User,
  Wifi,
  Workflow,
  Zap,
} from "lucide-react";
import { searchQuery, semanticSearchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { shortHash } from "@/lib/metagraphed/blocks";
import { getDocsNav } from "@/lib/docs-nav.functions";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  SCOPES,
  Kbd,
  safeExternalUrl,
  type SearchScope,
} from "@jsonbored/ui-kit";
import {
  loadRecent,
  pushRecent,
  clearRecent,
  loadPaletteState,
  savePaletteState,
  SUGGESTED_QUERIES,
} from "@/lib/metagraphed/search-history";
import {
  trackOpen,
  trackScope,
  trackQuery,
  trackSelection,
  trackAction,
} from "@/lib/metagraphed/palette-analytics";

interface RouteEntry {
  label: string;
  to: string;
  hint?: string;
  icon: typeof Compass;
  scope: "route";
}

// Docs pages that want a bespoke icon instead of the generic BookOpen
// fallback -- cosmetic only. Unlike the old hardcoded ROUTE_INDEX entries,
// leaving a page out of this map never hides it from the palette (see
// docsRoutes below), it just renders with the default icon.
const DOCS_ICON_OVERRIDES: Record<string, typeof Compass> = {
  "/docs/graphql": Braces,
  "/docs/rpc": Zap,
  "/docs/feeds": Rss,
  "/docs/chain-events": History,
  "/docs/api-reference": Code2,
};

// Non-docs routes, in display order. The docs subset used to be hand-listed
// here too, but that's exactly how /docs/chain-events silently went missing
// from the palette for a while -- it's now sourced live via getDocsNav()
// (see docsRoutes in CommandPaletteBody) and spliced in between "Schemas"
// and "Gaps" below.
const STATIC_ROUTES_HEAD: RouteEntry[] = [
  { label: "Home", to: "/", hint: "Registry overview", icon: Compass, scope: "route" },
  {
    label: "Subnets",
    to: "/subnets",
    hint: "All active Finney subnets",
    icon: Layers,
    scope: "route",
  },
  {
    label: "Surfaces",
    to: "/surfaces",
    hint: "Verified public interfaces",
    icon: Workflow,
    scope: "route",
  },
  { label: "Endpoints", to: "/endpoints", hint: "RPC, APIs, streams", icon: Wifi, scope: "route" },
  {
    label: "Providers",
    to: "/providers",
    hint: "Teams & infrastructure",
    icon: Network,
    scope: "route",
  },
  {
    label: "Health",
    to: "/health",
    hint: "Ops matrix, mosaic & freshness",
    icon: Activity,
    scope: "route",
  },
  {
    label: "Status",
    to: "/status",
    hint: "Public uptime & incidents",
    icon: Gauge,
    scope: "route",
  },
  {
    label: "Schemas",
    to: "/schemas",
    hint: "OpenAPI, contracts, drift",
    icon: FileJson,
    scope: "route",
  },
];

const STATIC_ROUTES_TAIL: RouteEntry[] = [
  {
    label: "Gaps",
    to: "/gaps",
    hint: "Coverage & enrichment queue",
    icon: Sparkles,
    scope: "route",
  },
  {
    label: "For agents",
    to: "/agents",
    hint: "Machine-readable surfaces",
    icon: Bot,
    scope: "route",
  },
  { label: "About", to: "/about", hint: "Methodology & scope", icon: Compass, scope: "route" },
  { label: "Blocks", to: "/blocks", hint: "Chain block explorer", icon: Hash, scope: "route" },
  {
    label: "Extrinsics",
    to: "/extrinsics",
    hint: "Transaction explorer",
    icon: ArrowRightLeft,
    scope: "route",
  },
  {
    label: "Accounts",
    to: "/accounts",
    hint: "Hotkey & coldkey activity",
    icon: User,
    scope: "route",
  },
  {
    label: "Sudo",
    to: "/sudo",
    hint: "Root-origin calls + current key",
    icon: KeyRound,
    scope: "route",
  },
  {
    label: "Admin changes",
    to: "/admin-changes",
    hint: "AdminUtils config-change feed",
    icon: SlidersHorizontal,
    scope: "route",
  },
  {
    label: "Runtime",
    to: "/runtime",
    hint: "Spec-version upgrade history",
    icon: GitBranch,
    scope: "route",
  },
];

interface SearchHit {
  id: string;
  kind?: string;
  title?: string;
  url?: string;
  netuid?: number;
  slug?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const KIND_META: Record<string, { label: string; icon: typeof Layers; cls: string }> = {
  subnet: { label: "Subnet", icon: Layers, cls: "text-ink-strong" },
  surface: { label: "Surface", icon: Workflow, cls: "text-curation-verified" },
  endpoint: { label: "Endpoint", icon: Wifi, cls: "text-curation-pilot" },
  provider: { label: "Provider", icon: Network, cls: "text-curation-machine" },
};

// Secondary group size — the keyword group already covers 20; semantic is a
// smaller AI-ranked complement, not a replacement.
const SEMANTIC_LIMIT = 8;

type Target = { to: string; params?: Record<string, string> } | { external: string };

function targetToHref(target: Target): string {
  if ("external" in target) return target.external;
  let path = target.to;
  if (target.params) {
    for (const [k, v] of Object.entries(target.params))
      path = path.replace(`$${k}`, encodeURIComponent(v));
  }
  return path;
}

function absoluteUrl(href: string): string {
  if (/^https?:/i.test(href)) return href;
  if (typeof window === "undefined") return href;
  return `${window.location.origin}${href.startsWith("/") ? "" : "/"}${href}`;
}

function scoreHit(hit: SearchHit, q: string, recentSet: Set<string>): number {
  const t = (hit.title ?? hit.url ?? hit.id ?? "").toLowerCase();
  const n = q.toLowerCase();
  let s = 0;
  if (!n) return 0;
  if (t === n) s += 100;
  else if (t.startsWith(n)) s += 60;
  else if (t.includes(` ${n}`)) s += 30;
  else if (t.includes(n)) s += 10;
  if (recentSet.has(n) && t.includes(n)) s += 8;
  // Prefer concrete entities slightly
  if (hit.kind === "subnet" || hit.kind === "provider") s += 2;
  return s;
}

export function CommandPaletteBody({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [recent, setRecent] = useState<string[]>([]);
  const hydrated = useRef(false);

  // Hydrate persisted state once
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const saved = loadPaletteState();
    if (saved) {
      setQ(saved.q ?? "");
      const validScope = SCOPES.find((s) => s.key === saved.scope)?.key ?? "all";
      setScope(validScope as SearchScope);
    }
    setRecent(loadRecent());
  }, []);

  // Persist on change
  useEffect(() => {
    if (!hydrated.current) return;
    savePaletteState({ q, scope });
  }, [q, scope]);

  // Track opens + refresh recent list
  useEffect(() => {
    if (open) {
      trackOpen();
      setRecent(loadRecent());
    }
  }, [open]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 150);
    return () => window.clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery({
    ...searchQuery(debounced, 20),
    retry: 0,
  });
  const allHits = (data?.data ?? []) as SearchHit[];

  // Semantic (vector-similarity) fallback/complement to the keyword hits above.
  // Isolated in its own query so a 503 (AI disabled) or 502 (AI error) just
  // means an empty group here — it never affects the keyword results.
  const {
    data: semanticData,
    isFetching: isSemanticFetching,
    isError: isSemanticError,
  } = useQuery({ ...semanticSearchQuery(debounced, SEMANTIC_LIMIT), retry: 0 });
  const semanticHits = isSemanticError ? [] : (semanticData?.data.results ?? []);

  // Track zero-result + top queries (only once per settled query)
  const lastTracked = useRef<string>("");
  useEffect(() => {
    if (!debounced || isFetching) return;
    if (lastTracked.current === debounced) return;
    lastTracked.current = debounced;
    trackQuery(debounced, allHits.length);
  }, [debounced, isFetching, allHits.length]);

  const recentSet = useMemo(() => new Set(recent.map((r) => r.toLowerCase())), [recent]);

  const hits = useMemo(() => {
    const filtered =
      scope === "all" || scope === ("route" as SearchScope)
        ? allHits
        : allHits.filter((h) => (h.kind ?? "").toLowerCase() === scope);
    if (!debounced) return filtered;
    return [...filtered].sort(
      (a, b) => scoreHit(b, debounced, recentSet) - scoreHit(a, debounced, recentSet),
    );
  }, [allHits, scope, debounced, recentSet]);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const k = (h.kind ?? "other").toLowerCase();
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(h);
    }
    return map;
  }, [hits]);

  // Docs pages -- fetched once per palette session (they're static content
  // baked in at build time, so an Infinity staleTime is correct here, unlike
  // the API-freshness-driven STALE_* constants used by the search queries
  // above).
  const { data: docsNav } = useQuery({
    queryKey: ["docs-nav"],
    queryFn: () => getDocsNav(),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const docsRoutes = useMemo<RouteEntry[]>(
    () =>
      (docsNav ?? []).map((page) => ({
        label: page.title,
        to: page.url,
        hint: page.description || undefined,
        icon: DOCS_ICON_OVERRIDES[page.url] ?? BookOpen,
        scope: "route",
      })),
    [docsNav],
  );

  const allRoutes = useMemo<RouteEntry[]>(
    () => [...STATIC_ROUTES_HEAD, ...docsRoutes, ...STATIC_ROUTES_TAIL],
    [docsRoutes],
  );

  const filteredRoutes = useMemo(() => {
    if (scope !== "all" && scope !== ("route" as SearchScope)) return [];
    if (!debounced) return allRoutes;
    const n = debounced.toLowerCase();
    return allRoutes
      .filter((r) => r.label.toLowerCase().includes(n) || (r.hint ?? "").toLowerCase().includes(n))
      .sort((a, b) => {
        const an = a.label.toLowerCase();
        const bn = b.label.toLowerCase();
        const ax = an === n ? 3 : an.startsWith(n) ? 2 : 1;
        const bx = bn === n ? 3 : bn.startsWith(n) ? 2 : 1;
        return bx - ax;
      });
  }, [debounced, scope, allRoutes]);

  const navigateTargets = useMemo(() => {
    if (!debounced) return [];
    const q = debounced.trim();
    const targets: Array<{
      label: string;
      hint: string;
      target: Target;
      kind: string;
      icon: typeof User;
      searchValue?: string;
    }> = [];
    if (isValidSs58(q)) {
      targets.push({
        label: `Account ${shortHash(q, 8) ?? q}`,
        hint: q,
        target: { to: "/accounts/$ss58", params: { ss58: q } },
        searchValue: q,
        kind: "account",
        icon: User,
      });
    }
    if (/^(?:0|[1-9][0-9]{0,9})$/.test(q)) {
      targets.push({
        label: `Block #${q}`,
        hint: "jump to block by number",
        target: { to: "/blocks/$ref", params: { ref: q } },
        kind: "block",
        icon: Hash,
      });
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      targets.push(
        {
          label: `Block ${shortHash(q, 8) ?? q}`,
          hint: "by block hash",
          target: { to: "/blocks/$ref", params: { ref: q } },
          searchValue: q,
          kind: "block",
          icon: Hash,
        },
        {
          label: `Extrinsic ${shortHash(q, 8) ?? q}`,
          hint: "by extrinsic hash",
          target: { to: "/extrinsics/$hash", params: { hash: q } },
          searchValue: q,
          kind: "extrinsic",
          icon: ArrowRightLeft,
        },
      );
    } else if (/^0x[0-9a-fA-F]{1,63}$/.test(q)) {
      targets.push({
        label: `Block ${shortHash(q, 8) ?? q}`,
        hint: "by block hash (partial)",
        target: { to: "/blocks/$ref", params: { ref: q } },
        kind: "block",
        icon: Hash,
      });
    }
    const netuidMatch = /^(?:sn\s*(\d+)|netuid\s*(\d+))$/i.exec(q);
    if (netuidMatch) {
      const n = Number(netuidMatch[1] ?? netuidMatch[2]);
      if (Number.isFinite(n) && n >= 0 && n <= 1024) {
        targets.push({
          label: `Subnet ${n}`,
          hint: "go to subnet by netuid",
          target: { to: "/subnets/$netuid", params: { netuid: String(n) } },
          kind: "subnet",
          icon: Layers,
        });
      }
    }
    return targets;
  }, [debounced]);

  const resolveHref = useCallback((hit: SearchHit): Target => {
    const kind = (hit.kind ?? "").toLowerCase();
    if (kind === "subnet" && hit.netuid != null)
      return { to: "/subnets/$netuid", params: { netuid: String(hit.netuid) } };
    if (kind === "provider" && hit.slug)
      return { to: "/providers/$slug", params: { slug: hit.slug } };
    if (kind === "surface") return { to: "/surfaces" };
    if (kind === "endpoint") return { to: "/endpoints" };
    if (hit.netuid != null)
      return { to: "/subnets/$netuid", params: { netuid: String(hit.netuid) } };
    const safeUrl = safeExternalUrl(hit.url);
    if (safeUrl) return { external: safeUrl };
    return { to: "/" };
  }, []);

  const openTarget = useCallback(
    (target: Target, kind: string, openNew = false) => {
      if (debounced) pushRecent(debounced);
      trackSelection(kind);
      if ("external" in target) {
        window.open(target.external, "_blank", "noopener,noreferrer");
        onOpenChange(false);
        return;
      }
      if (openNew) {
        trackAction("open:new-tab");
        window.open(targetToHref(target), "_blank", "noopener,noreferrer");
        onOpenChange(false);
        return;
      }
      trackAction("open:same-tab");
      onOpenChange(false);
      router.navigate({ to: target.to, params: target.params as never });
    },
    [router, onOpenChange, debounced],
  );

  const copyLink = useCallback(async (target: Target, label: string) => {
    try {
      const url = absoluteUrl(targetToHref(target));
      await navigator.clipboard.writeText(url);
      trackAction("copy:link");
      toast.success("Link copied", { description: label });
    } catch {
      toast.error("Failed to copy link");
    }
  }, []);

  const openInNewTab = useCallback(
    (target: Target, kind: string) => {
      openTarget(target, kind, true);
    },
    [openTarget],
  );

  // Detect ⌘/Ctrl for "open in new tab" hint + ⌘C copy
  const [modifier, setModifier] = useState(false);
  useEffect(() => {
    if (!open) return;
    function down(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey) setModifier(true);
    }
    function up(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) setModifier(false);
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [open]);

  const onScopeChange = (next: SearchScope) => {
    setScope(next);
    trackScope(next);
  };

  const showSuggestions = !debounced;

  const showNoMatches =
    debounced &&
    !isFetching &&
    hits.length === 0 &&
    filteredRoutes.length === 0 &&
    navigateTargets.length === 0;

  const filterSubnetsByQuery = useCallback(() => {
    pushRecent(debounced);
    trackAction("filter:subnets");
    onOpenChange(false);
    navigate({ to: "/subnets", search: { q: debounced } as never });
  }, [debounced, navigate, onOpenChange]);

  const filterEndpointsByQuery = useCallback(() => {
    pushRecent(debounced);
    trackAction("filter:endpoints");
    onOpenChange(false);
    navigate({ to: "/endpoints", search: { q: debounced } as never });
  }, [debounced, navigate, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        value={q}
        onValueChange={setQ}
        placeholder="Search subnets, surfaces, endpoints, providers, docs…"
      />

      {/* Scope filter row */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto">
        {SCOPES.map((s) => {
          const active = scope === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onScopeChange(s.key)}
              className={classNames(
                "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                active
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border bg-paper text-ink-muted hover:text-ink-strong hover:border-ink/30",
              )}
            >
              {s.label}
            </button>
          );
        })}
        {(isFetching || isSemanticFetching) && debounced ? (
          <span className="ml-auto font-mono text-[10px] text-ink-muted">searching…</span>
        ) : null}
      </div>

      <CommandList className="max-h-[60vh]">
        <CommandEmpty>
          {isFetching
            ? "Searching…"
            : showNoMatches
              ? `No matches for "${debounced}"`
              : debounced
                ? "No matches."
                : "Start typing to search."}
        </CommandEmpty>

        {showNoMatches ? (
          <div className="px-3 py-3 space-y-3 border-b border-border">
            <p className="font-mono text-[11px] text-ink-muted">
              Try a suggested query or filter a list by your search.
            </p>
            <div>
              <div className="mg-label mb-1.5">Try</div>
              <ul className="flex flex-wrap gap-1">
                {SUGGESTED_QUERIES.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => setQ(s)}
                      className="rounded-full border border-dashed border-ink-subtle bg-paper px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mg-label mb-1.5">Filter</div>
              <ul className="flex flex-col gap-1.5">
                <li>
                  <button
                    type="button"
                    onClick={filterSubnetsByQuery}
                    className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-ink-strong hover:border-accent/40 hover:bg-surface transition-colors"
                  >
                    <Search className="size-4 shrink-0 text-ink-muted" />
                    <span>Filter /subnets by "{debounced}"</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={filterEndpointsByQuery}
                    className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-ink-strong hover:border-accent/40 hover:bg-surface transition-colors"
                  >
                    <Wifi className="size-4 shrink-0 text-ink-muted" />
                    <span>Filter /endpoints by "{debounced}"</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        ) : null}

        {showSuggestions ? (
          <div className="px-3 py-3 space-y-3 border-b border-border">
            {recent.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="mg-label">Recent</div>
                  <button
                    type="button"
                    onClick={() => {
                      clearRecent();
                      setRecent([]);
                    }}
                    className="mg-label hover:text-ink-strong transition-colors"
                  >
                    Clear
                  </button>
                </div>
                <ul className="flex flex-wrap gap-1">
                  {recent.map((r) => (
                    <li key={r}>
                      <button
                        type="button"
                        onClick={() => setQ(r)}
                        className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-ink hover:border-accent/40 hover:text-accent transition-colors"
                      >
                        {r}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <div className="mg-label mb-1.5">Try</div>
              <ul className="flex flex-wrap gap-1">
                {SUGGESTED_QUERIES.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => setQ(s)}
                      className="rounded-full border border-dashed border-ink-subtle bg-paper px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {navigateTargets.length > 0 ? (
          <CommandGroup heading="Go to">
            {navigateTargets.map((n) => {
              const Icon = n.icon;
              return (
                <CommandItem
                  key={`nav-${n.kind}-${n.label}`}
                  value={`nav ${n.kind} ${n.label} ${n.hint} ${n.searchValue ?? ""}`}
                  onSelect={() => openTarget(n.target, n.kind, modifier)}
                  className="group/item flex items-center gap-3"
                >
                  <Icon className="size-4 text-ink-muted shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink-strong truncate">{n.label}</div>
                    <div className="font-mono text-[10px] text-ink-muted truncate">{n.hint}</div>
                  </div>
                  <ItemActions
                    onCopy={() => copyLink(n.target, n.label)}
                    onNewTab={() => openInNewTab(n.target, n.kind)}
                  />
                  <CommandShortcut className="font-mono text-[10px] uppercase tracking-widest">
                    {n.kind}
                  </CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {filteredRoutes.length > 0 ? (
          <CommandGroup heading="Jump to">
            {filteredRoutes.map((r) => {
              const Icon = r.icon;
              const target: Target = { to: r.to };
              return (
                <CommandItem
                  key={r.to}
                  value={`route ${r.label} ${r.hint ?? ""}`}
                  onSelect={() => openTarget(target, "route", modifier)}
                  className="group/item flex items-center gap-3"
                >
                  <Icon className="size-4 text-ink-muted shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink-strong truncate">{r.label}</div>
                    {r.hint ? (
                      <div className="font-mono text-[10px] text-ink-muted truncate">{r.hint}</div>
                    ) : null}
                  </div>
                  <ItemActions
                    onCopy={() => copyLink(target, r.label)}
                    onNewTab={() => openInNewTab(target, "route")}
                  />
                  <CommandShortcut className="font-mono text-[10px]">page</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {[...grouped.entries()].map(([kind, items]) => {
          const meta = KIND_META[kind] ?? {
            label: kind,
            icon: Search,
            cls: "text-ink-muted",
          };
          const Icon = meta.icon;
          return (
            <CommandGroup key={kind} heading={meta.label + "s"}>
              {items.map((h) => {
                const target = resolveHref(h);
                const title = h.title ?? h.url ?? h.id;
                const subtitle =
                  h.netuid != null ? `netuid ${h.netuid}` : h.url ? h.url : h.slug ? h.slug : "";
                return (
                  <CommandItem
                    key={h.id}
                    value={`${kind} ${title} ${subtitle}`}
                    onSelect={() => openTarget(target, kind, modifier)}
                    className="group/item flex items-center gap-3"
                  >
                    <Icon className={classNames("size-4 shrink-0", meta.cls)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-ink-strong truncate">{title}</div>
                      {subtitle ? (
                        <div className="font-mono text-[10px] text-ink-muted truncate">
                          {subtitle}
                        </div>
                      ) : null}
                    </div>
                    <ItemActions
                      onCopy={() => copyLink(target, String(title))}
                      onNewTab={() => openInNewTab(target, kind)}
                    />
                    <CommandShortcut className="font-mono text-[10px] uppercase tracking-widest">
                      {meta.label}
                    </CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}

        {/* #3994: the "Semantic matches" group was verified to render cleanly —
            no clipping, overlap, or contrast issues — at all six viewport/theme
            combinations (mobile/tablet/desktop × light/dark), closing the
            evidence gap left by #3847's misleading before/after captures. */}
        {semanticHits.length > 0 ? (
          <CommandGroup heading="Semantic matches">
            {semanticHits.map((r, i) => {
              const kind = (r.type ?? "").toLowerCase();
              const meta = KIND_META[kind] ?? {
                label: kind || "Match",
                icon: Sparkles,
                cls: "text-ink-muted",
              };
              const Icon = meta.icon;
              const target = resolveHref({
                id: `semantic-${i}`,
                kind: r.type ?? undefined,
                netuid: r.netuid ?? undefined,
                slug: r.slug ?? undefined,
                url: r.url ?? undefined,
              });
              const title = r.title ?? r.url ?? r.slug ?? "Untitled";
              const subtitle =
                r.subtitle ?? (r.netuid != null ? `netuid ${r.netuid}` : (r.slug ?? r.url ?? ""));
              return (
                <CommandItem
                  key={`semantic-${i}-${r.url ?? r.title ?? i}`}
                  value={`semantic ${kind} ${title} ${subtitle}`}
                  onSelect={() => openTarget(target, kind || "semantic", modifier)}
                  className="group/item flex items-center gap-3"
                >
                  <Icon className={classNames("size-4 shrink-0", meta.cls)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink-strong truncate">{title}</div>
                    {subtitle ? (
                      <div className="font-mono text-[10px] text-ink-muted truncate">
                        {subtitle}
                      </div>
                    ) : null}
                  </div>
                  <ItemActions
                    onCopy={() => copyLink(target, String(title))}
                    onNewTab={() => openInNewTab(target, kind || "semantic")}
                  />
                  <CommandShortcut className="font-mono text-[10px] uppercase tracking-widest text-accent">
                    AI {Math.round(r.score * 100)}%
                  </CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {debounced && !showNoMatches ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem
                value={`filter subnets ${debounced}`}
                onSelect={filterSubnetsByQuery}
                className="flex items-center gap-3"
              >
                <Search className="size-4 text-ink-muted" />
                <span className="text-sm text-ink-strong">Filter /subnets by "{debounced}"</span>
              </CommandItem>
              <CommandItem
                value={`filter endpoints ${debounced}`}
                onSelect={filterEndpointsByQuery}
                className="flex items-center gap-3"
              >
                <Wifi className="size-4 text-ink-muted" />
                <span className="text-sm text-ink-strong">Filter /endpoints by "{debounced}"</span>
              </CommandItem>
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
      <div className="border-t border-border px-3 py-2 flex items-center justify-between text-[10px] font-mono text-ink-muted">
        <span className="inline-flex items-center gap-2 flex-wrap">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move <Kbd>⏎</Kbd> open <Kbd>⌘</Kbd>
          <Kbd>⏎</Kbd> new tab <Kbd>Esc</Kbd> close
        </span>
        <span className="inline-flex items-center gap-1">
          <Star className="size-2.5" />
          {modifier ? "new tab" : "navigate"}
        </span>
      </div>
    </CommandDialog>
  );
}

function ItemActions({ onCopy, onNewTab }: { onCopy: () => void; onNewTab: () => void }) {
  const stop = (e: MouseEvent | PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <span
      className="hidden group-hover/item:inline-flex group-data-[selected=true]/item:inline-flex items-center gap-1 mr-1"
      onPointerDown={stop}
      onMouseDown={stop}
    >
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          onCopy();
        }}
        title="Copy link"
        aria-label="Copy link"
        className="inline-flex items-center justify-center size-6 rounded border border-border bg-paper text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors"
      >
        <Copy className="size-3" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          onNewTab();
        }}
        title="Open in new tab"
        aria-label="Open in new tab"
        className="inline-flex items-center justify-center size-6 rounded border border-border bg-paper text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors"
      >
        <ExternalLink className="size-3" />
      </button>
    </span>
  );
}
