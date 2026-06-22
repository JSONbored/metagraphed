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
  Bot,
  Compass,
  Copy,
  ExternalLink,
  FileJson,
  Gauge,
  Layers,
  Network,
  Search,
  Sparkles,
  Star,
  Wifi,
  Workflow,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { searchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { SCOPES, type SearchScope } from "./search-scope";
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
import { Kbd } from "./kbd";
import { safeExternalUrl } from "./external-link";

const ROUTE_INDEX: Array<{
  label: string;
  to: string;
  hint?: string;
  icon: typeof Compass;
  scope: "route";
}> = [
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
  { label: "Health", to: "/health", hint: "Global probe status", icon: Activity, scope: "route" },
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
];

interface SearchHit {
  id: string;
  kind?: string;
  title?: string;
  url?: string;
  netuid?: number;
  slug?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const KIND_META: Record<string, { label: string; icon: typeof Layers; cls: string }> = {
  subnet: { label: "Subnet", icon: Layers, cls: "text-ink-strong" },
  surface: { label: "Surface", icon: Workflow, cls: "text-curation-verified" },
  endpoint: { label: "Endpoint", icon: Wifi, cls: "text-curation-pilot" },
  provider: { label: "Provider", icon: Network, cls: "text-curation-machine" },
};

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

export function CommandPalette({ open, onOpenChange }: Props) {
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

  const filteredRoutes = useMemo(() => {
    if (scope !== "all" && scope !== ("route" as SearchScope)) return [];
    if (!debounced) return ROUTE_INDEX;
    const n = debounced.toLowerCase();
    return ROUTE_INDEX.filter(
      (r) => r.label.toLowerCase().includes(n) || (r.hint ?? "").toLowerCase().includes(n),
    ).sort((a, b) => {
      const an = a.label.toLowerCase();
      const bn = b.label.toLowerCase();
      const ax = an === n ? 3 : an.startsWith(n) ? 2 : 1;
      const bx = bn === n ? 3 : bn.startsWith(n) ? 2 : 1;
      return bx - ax;
    });
  }, [debounced, scope]);

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
        {isFetching && debounced ? (
          <span className="ml-auto font-mono text-[10px] text-ink-muted">searching…</span>
        ) : null}
      </div>

      <CommandList className="max-h-[60vh]">
        <CommandEmpty>
          {isFetching ? "Searching…" : debounced ? "No matches." : "Start typing to search."}
        </CommandEmpty>

        {showSuggestions ? (
          <div className="px-3 py-3 space-y-3 border-b border-border">
            {recent.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    Recent
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      clearRecent();
                      setRecent([]);
                    }}
                    className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong transition-colors"
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
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1.5">
                Try
              </div>
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

        {debounced ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem
                value={`filter subnets ${debounced}`}
                onSelect={() => {
                  pushRecent(debounced);
                  trackAction("filter:subnets");
                  onOpenChange(false);
                  navigate({ to: "/subnets", search: { q: debounced } as never });
                }}
                className="flex items-center gap-3"
              >
                <Search className="size-4 text-ink-muted" />
                <span className="text-sm text-ink-strong">Filter /subnets by "{debounced}"</span>
              </CommandItem>
              <CommandItem
                value={`filter endpoints ${debounced}`}
                onSelect={() => {
                  pushRecent(debounced);
                  trackAction("filter:endpoints");
                  onOpenChange(false);
                  navigate({ to: "/endpoints", search: { q: debounced } as never });
                }}
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
