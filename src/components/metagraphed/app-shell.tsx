import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertOctagon,
  ChevronRight,
  Compass,
  Database,
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
import { CopyableCode } from "./copyable-code";
import { ThemeToggle } from "./theme-toggle";
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
                pathname === item.to ||
                (item.to !== "/" && pathname.startsWith(item.to + "/"));
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={classNames(
                      "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors min-h-9",
                      active
                        ? "bg-ink-strong text-paper"
                        : "text-ink hover:bg-surface",
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
        <Link
          to="/"
          onClick={onNavigate}
          className="flex items-center gap-2 group"
        >
          <span className="size-5 bg-ink-strong rounded-sm" aria-hidden />
          <span className="font-display text-base font-semibold tracking-tight text-ink-strong">
            Metagraphed
          </span>
        </Link>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted flex items-center gap-1">
          <Compass className="size-3" /> Unofficial registry
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <NavList onNavigate={onNavigate} />
      </div>
      <div className="border-t border-border bg-surface/40 p-3">
        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted mb-1.5">
          API base
        </div>
        <CopyableCode value={`${API_BASE}/api/v1`} truncate={false} className="w-full text-[10px]" />
      </div>
    </div>
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

function resolveHref(hit: SearchHit): { to: string; params?: Record<string, string> } | { external: string } {
  const kind = (hit.kind ?? "").toLowerCase();
  if (kind === "subnet" && hit.netuid != null)
    return { to: "/subnets/$netuid", params: { netuid: String(hit.netuid) } };
  if (kind === "provider" && hit.slug) return { to: "/providers/$slug", params: { slug: hit.slug } };
  if (kind === "surface") return { to: "/surfaces" };
  if (kind === "endpoint") return { to: "/endpoints" };
  if (hit.netuid != null) return { to: "/subnets/$netuid", params: { netuid: String(hit.netuid) } };
  if (hit.url) return { external: hit.url };
  return { to: "/" };
}

function GlobalSearch() {
  const router = useRouter();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery({
    ...searchQuery(debounced, 12),
    retry: 0,
  });
  const hits = (data?.data ?? []) as SearchHit[];

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

  // Close popover on route change.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function go(hit: SearchHit) {
    const r = resolveHref(hit);
    setOpen(false);
    setQ("");
    if ("external" in r) {
      window.open(r.external, "_blank", "noopener,noreferrer");
      return;
    }
    router.navigate({ to: r.to, params: r.params as never });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (hits.length > 0) {
          go(hits[0]);
          return;
        }
        const value = q.trim();
        if (!value) return;
        navigate({ to: "/subnets", search: { q: value } as never });
        setOpen(false);
      }}
      className="relative flex-1 max-w-md"
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
        placeholder="Search subnets, surfaces, providers, URLs…"
        className="w-full rounded border border-border bg-card pl-8 pr-3 py-1.5 text-sm placeholder:text-ink-muted focus:outline-none focus:border-ink/30 transition-colors min-h-9"
      />
      {open && debounced ? (
        <div
          id="mg-search-results"
          ref={popRef}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 max-h-[60vh] overflow-y-auto rounded border border-border bg-paper shadow-lg z-40"
        >
          {isFetching && hits.length === 0 ? (
            <div className="p-3 text-xs text-ink-muted">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="p-3 text-xs text-ink-muted">
              No results. Press enter to filter /subnets by “{debounced}”.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => go(h)}
                    className="w-full text-left px-3 py-2 hover:bg-surface flex items-center gap-2"
                  >
                    <KindBadge kind={h.kind} />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm text-ink-strong">
                        {h.title ?? h.url ?? h.id}
                      </span>
                      {h.url ? (
                        <span className="block truncate font-mono text-[10px] text-ink-muted">{h.url}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </form>
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
        "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest shrink-0",
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
          <div
            className="absolute inset-0 bg-ink-strong/40"
            onClick={() => setMobileOpen(false)}
          />
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
            <nav aria-label="Breadcrumb" className="hidden md:flex items-center gap-1.5 text-xs text-ink-muted min-w-0">
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
            <div className="hidden lg:flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                <Database className="size-3" /> Finney
              </span>
              <span className="inline-flex items-center rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Unofficial
              </span>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="px-4 md:px-8 py-6 md:py-8 max-w-[1400px] mx-auto">{children}</main>

        <footer className="border-t border-border mt-12 px-4 md:px-8 py-6 max-w-[1400px] mx-auto text-[11px] text-ink-muted flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            Metagraphed extends the native Bittensor metagraph with public interface and health
            metadata. Unofficial — not a block explorer.
          </div>
          <div className="font-mono">
            data: <a href={`${API_BASE}/api/v1`} className="underline" target="_blank" rel="noreferrer">{API_BASE}/api/v1</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
