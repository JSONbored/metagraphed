import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertOctagon,
  ChevronRight,
  Compass,
  FileCode,
  Home,
  Info,
  Layers,
  Menu,
  Network,
  Search,
  Server,
  Wifi,
  Workflow,
  X,
} from "lucide-react";
import { API_BASE } from "@/lib/metagraphed/config";
import { useApiBase, useNetwork } from "@/hooks/use-api-base";
import { NetworkSwitcher } from "./network-switcher";
import { CopyableCode } from "./copyable-code";
import { SettingsPopover } from "./settings-popover";
import { Kbd } from "./kbd";
import { classNames } from "@/lib/metagraphed/format";
import { searchQuery } from "@/lib/metagraphed/queries";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Activity;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * Sidebar grouped by user intent — what a builder is trying to *do*.
 *
 * Discover        Browse and find resources.
 * Infrastructure  Public endpoints and the orgs running them.
 * Operations      Live health and the API contract itself.
 * Registry        Curation gaps and methodology.
 */
const SECTIONS: NavSection[] = [
  {
    label: "Discover",
    items: [
      { to: "/", label: "Home", icon: Home },
      { to: "/subnets", label: "Subnets", icon: Layers },
      { to: "/surfaces", label: "Surfaces", icon: Workflow },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/endpoints", label: "Endpoints", icon: Server },
      { to: "/providers", label: "Providers", icon: Network },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/health", label: "Health", icon: Activity },
      { to: "/schemas", label: "Schemas", icon: FileCode },
    ],
  },
  {
    label: "Registry",
    items: [
      { to: "/gaps", label: "Gaps", icon: AlertOctagon },
      { to: "/about", label: "About", icon: Info },
    ],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="space-y-5" aria-label="Primary">
      {SECTIONS.map((section) => (
        <div key={section.label}>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1.5 px-2">
            {section.label}
          </div>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active =
                pathname === item.to || (item.to !== "/" && pathname.startsWith(item.to + "/"));
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={classNames(
                      "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors min-h-9",
                      active ? "bg-ink-strong text-paper" : "text-ink hover:bg-surface",
                    )}
                  >
                    <Icon className="size-3.5 opacity-70" />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="p-5">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2 group">
          <span className="size-5 bg-ink-strong rounded-sm" aria-hidden />
          <span className="font-display text-base font-semibold tracking-tight text-ink-strong inline-flex items-baseline gap-0.5">
            Metagraphed
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full bg-accent translate-y-[-0.15em]"
            />
          </span>
        </Link>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted flex items-center gap-1">
          <Compass className="size-3" /> Unofficial registry
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <NavList onNavigate={onNavigate} />
      </div>
      <div className="border-t border-border bg-surface/40 p-3 min-w-0">
        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted mb-1.5">
          API base
        </div>
        <ApiBaseRow />
      </div>
    </div>
  );
}

function ApiBaseRow() {
  const { base } = useApiBase();
  return (
    <CopyableCode
      value={`${base}/api/v1`}
      truncate={true}
      className="w-full max-w-full text-[10px]"
    />
  );
}

interface SearchHit {
  id: string;
  kind?: string;
  title?: string;
  url?: string;
  netuid?: number;
  slug?: string;
}

function isLocalOrPrivateHost(hostname: string) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [, aRaw, bRaw] = ipv4;
    const a = Number(aRaw);
    const b = Number(bRaw);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (!host.includes(":")) return false;

  return (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("::ffff:")
  );
}

function safeExternalUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isLocalOrPrivateHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function resolveHref(
  hit: SearchHit,
): { to: string; params?: Record<string, string> } | { external: string } {
  const kind = (hit.kind ?? "").toLowerCase();
  if (kind === "subnet" && hit.netuid != null)
    return { to: "/subnets/$netuid", params: { netuid: String(hit.netuid) } };
  if (kind === "provider" && hit.slug)
    return { to: "/providers/$slug", params: { slug: hit.slug } };
  if (kind === "surface") return { to: "/surfaces" };
  if (kind === "endpoint") return { to: "/endpoints" };
  if (hit.netuid != null) return { to: "/subnets/$netuid", params: { netuid: String(hit.netuid) } };

  const external = hit.url ? safeExternalUrl(hit.url) : null;
  if (external) return { external };

  return { to: "/" };
}

function GlobalSearch() {
  const router = useRouter();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Lazy-load recents on mount only.
    import("@/lib/metagraphed/search-history").then((m) => setRecent(m.loadRecent()));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery({ ...searchQuery(debounced, 16), retry: 0 });
  const hits = (data?.data ?? []) as SearchHit[];

  // Group hits by kind. Order = Subnets, Surfaces, Endpoints, Providers, Other.
  const groups = useMemo(() => {
    const order = ["subnet", "surface", "endpoint", "provider"];
    const buckets = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const k = (h.kind ?? "other").toLowerCase();
      const list = buckets.get(k) ?? [];
      list.push(h);
      buckets.set(k, list);
    }
    const ordered: Array<{ kind: string; items: SearchHit[] }> = [];
    for (const k of order) {
      const items = buckets.get(k);
      if (items && items.length) ordered.push({ kind: k, items });
    }
    for (const [k, items] of buckets) {
      if (!order.includes(k)) ordered.push({ kind: k, items });
    }
    return ordered;
  }, [hits]);

  const flatHits = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Reset active highlight when result set changes.
  useEffect(() => setActive(0), [debounced, flatHits.length]);

  // Global ⌘K / Ctrl+K / "/" focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        return;
      }
      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close on outside click and on Esc.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || inputRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [pathname]);

  function persistRecent(value: string) {
    import("@/lib/metagraphed/search-history").then((m) => {
      m.pushRecent(value);
      setRecent(m.loadRecent());
    });
  }

  function go(hit: SearchHit) {
    const r = resolveHref(hit);
    setOpen(false);
    if (debounced) persistRecent(debounced);
    setQ("");
    if ("external" in r) {
      window.open(r.external, "_blank", "noopener,noreferrer");
      return;
    }
    router.navigate({ to: r.to, params: r.params as never });
  }

  function pickRecent(value: string) {
    setQ(value);
    inputRef.current?.focus();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (flatHits.length > 0) {
          go(flatHits[Math.min(active, flatHits.length - 1)]!);
          return;
        }
        const value = q.trim();
        if (!value) return;
        persistRecent(value);
        navigate({ to: "/subnets", search: { q: value } as never });
        setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((i) => Math.min(flatHits.length - 1, i + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((i) => Math.max(0, i - 1));
        }
      }}
      className="relative flex-1 max-w-xl"
      role="search"
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        aria-label="Search registry"
        aria-expanded={open}
        aria-controls="mg-search-results"
        aria-autocomplete="list"
        role="combobox"
        placeholder="Search subnets, surfaces, providers, URLs…"
        className="w-full rounded border border-border bg-card pl-8 pr-14 py-1.5 text-sm placeholder:text-ink-muted focus:outline-none focus:border-ink/30 transition-colors min-h-9"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-0.5">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </span>

      {open ? (
        <div
          id="mg-search-results"
          ref={popRef}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 max-h-[70vh] overflow-y-auto rounded border border-border bg-paper shadow-lg z-40"
        >
          {isFetching ? (
            <div className="h-0.5 w-full overflow-hidden bg-surface" aria-hidden>
              <div className="h-full w-1/3 bg-accent animate-[mg-loader_1.1s_ease-in-out_infinite]" />
            </div>
          ) : null}

          {!debounced ? (
            <div className="p-3 space-y-3">
              {recent.length > 0 ? (
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1.5">
                    Recent
                  </div>
                  <ul className="flex flex-wrap gap-1">
                    {recent.map((r) => (
                      <li key={r}>
                        <button
                          type="button"
                          onClick={() => pickRecent(r)}
                          className="rounded border border-border bg-card px-2 py-1 text-[11px] text-ink hover:border-ink/30"
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
                  {["bittensor", "taostats", "rpc", "openapi", "sn7"].map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => pickRecent(s)}
                        className="rounded border border-dashed border-ink-subtle bg-paper px-2 py-1 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="border-t border-border pt-2 text-[10px] font-mono text-ink-muted flex items-center gap-2">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate <Kbd>⏎</Kbd> open <Kbd>Esc</Kbd> close
              </div>
            </div>
          ) : isFetching && flatHits.length === 0 ? (
            <div className="p-3 text-xs text-ink-muted">Searching…</div>
          ) : flatHits.length === 0 ? (
            <div className="p-3 text-xs text-ink-muted space-y-2">
              <div>
                No matches. Press <Kbd>⏎</Kbd> to filter /subnets by "{debounced}".
              </div>
              <div className="flex flex-wrap gap-1">
                <Link
                  to="/providers"
                  className="rounded border border-border bg-card px-2 py-1 text-[11px] hover:border-ink/30"
                >
                  Search providers
                </Link>
                <Link
                  to="/endpoints"
                  className="rounded border border-border bg-card px-2 py-1 text-[11px] hover:border-ink/30"
                >
                  Search endpoints
                </Link>
              </div>
            </div>
          ) : (
            <div>
              {groups.map((g) => {
                const baseIndex = flatHits.indexOf(g.items[0]!);
                return (
                  <div key={g.kind} className="border-b border-border last:border-b-0">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-surface/30">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                        {g.kind === "subnet"
                          ? "Subnets"
                          : g.kind === "surface"
                            ? "Surfaces"
                            : g.kind === "endpoint"
                              ? "Endpoints"
                              : g.kind === "provider"
                                ? "Providers"
                                : g.kind}
                      </span>
                      <SeeAllLink kind={g.kind} q={debounced} />
                    </div>
                    <ul>
                      {g.items.map((h, i) => {
                        const idx = baseIndex + i;
                        const isActive = idx === active;
                        return (
                          <li key={h.id}>
                            <button
                              type="button"
                              onMouseEnter={() => setActive(idx)}
                              onClick={() => go(h)}
                              className={classNames(
                                "w-full text-left px-3 py-2 flex items-center gap-2 transition-colors",
                                isActive ? "bg-surface" : "hover:bg-surface/60",
                              )}
                              role="option"
                              aria-selected={isActive}
                            >
                              <KindBadge kind={h.kind} />
                              <span className="flex-1 min-w-0">
                                <span className="block truncate text-sm text-ink-strong">
                                  {h.title ?? h.url ?? h.id}
                                </span>
                                {h.url ? (
                                  <span className="block truncate font-mono text-[10px] text-ink-muted">
                                    {h.url}
                                  </span>
                                ) : h.netuid != null ? (
                                  <span className="block font-mono text-[10px] text-ink-muted">
                                    netuid {h.netuid}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </form>
  );
}

function SeeAllLink({ kind, q }: { kind: string; q: string }) {
  const map: Record<string, string> = {
    subnet: "/subnets",
    surface: "/surfaces",
    endpoint: "/endpoints",
    provider: "/providers",
  };
  const to = map[kind];
  if (!to) return null;
  return (
    <Link
      to={to}
      search={{ q } as never}
      className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
    >
      see all →
    </Link>
  );
}

function KindBadge({ kind }: { kind?: string }) {
  const k = (kind ?? "result").toLowerCase();
  const map: Record<string, { icon: typeof Activity; cls: string }> = {
    subnet: { icon: Layers, cls: "text-ink" },
    surface: { icon: Workflow, cls: "text-curation-verified" },
    endpoint: { icon: Wifi, cls: "text-curation-pilot" },
    provider: { icon: Network, cls: "text-curation-machine" },
  };
  const entry = map[k] ?? { icon: Search, cls: "text-ink-muted" };
  const Icon = entry.icon;
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest shrink-0 w-[5.5rem]",
        entry.cls,
      )}
    >
      <Icon className="size-3" />
      {k}
    </span>
  );
}

function buildCrumbs(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; to: string }> = [{ label: "Registry", to: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    crumbs.push({ label: decodeURIComponent(p), to: acc });
  }
  return crumbs;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const { network } = useNetwork();
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname]);

  return (
    <div className="min-h-dvh bg-paper text-ink">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-paper md:block">
        <SidebarBody />
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-ink-strong/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[80vw] border-r border-border bg-paper">
            <div className="flex justify-end p-2">
              <button
                onClick={() => setMobileOpen(false)}
                className="rounded p-2 text-ink-muted hover:bg-surface min-h-11 min-w-11 inline-flex items-center justify-center"
                aria-label="Close menu"
              >
                <X className="size-4" />
              </button>
            </div>
            <SidebarBody onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="md:pl-60">
        <header className="sticky top-0 z-20 border-b border-border bg-paper/85 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 md:px-8">
            <button
              className="md:hidden rounded p-2 text-ink hover:bg-surface min-h-11 min-w-11 inline-flex items-center justify-center"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="size-4" />
            </button>
            <nav
              aria-label="Breadcrumb"
              className="hidden md:flex items-center gap-1.5 text-xs text-ink-muted min-w-0"
            >
              {crumbs.map((c, i) => (
                <span key={c.to} className="flex items-center gap-1.5 min-w-0">
                  {i > 0 ? <ChevronRight className="size-3 opacity-50" /> : null}
                  <Link
                    to={c.to}
                    className={classNames(
                      "truncate hover:text-ink-strong transition-colors",
                      i === crumbs.length - 1 && "text-ink-strong font-medium",
                    )}
                  >
                    {c.label}
                  </Link>
                </span>
              ))}
            </nav>
            <div className="flex-1 flex justify-end md:justify-center">
              <GlobalSearch />
            </div>
            <div className="flex items-center gap-2">
              <NetworkSwitcher />
              <SettingsPopover />
            </div>
          </div>
        </header>

        <main key={network.id} className="px-4 md:px-8 py-6 md:py-8 max-w-[1400px] mx-auto">
          {children}
        </main>

        <footer className="border-t border-border mt-12 px-4 md:px-8 py-6 max-w-[1400px] mx-auto text-[11px] text-ink-muted flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            Metagraphed extends the native Bittensor metagraph with public interface and health
            metadata. Unofficial — not a block explorer.
          </div>
          <div className="font-mono">
            data:{" "}
            <a href={`${API_BASE}/api/v1`} className="underline" target="_blank" rel="noreferrer">
              {API_BASE}/api/v1
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
