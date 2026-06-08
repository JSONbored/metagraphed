import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  Activity,
  AlertOctagon,
  ChevronRight,
  Database,
  FileCode,
  Info,
  Layers,
  Menu,
  Network,
  Search,
  Server,
  Workflow,
  X,
} from "lucide-react";
import { API_BASE } from "@/lib/metagraphed/config";
import { CopyableCode } from "./copyable-code";
import { classNames } from "@/lib/metagraphed/format";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Activity;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: "Registry",
    items: [
      { to: "/subnets", label: "Subnets", icon: Layers },
      { to: "/surfaces", label: "Surfaces", icon: Workflow },
      { to: "/endpoints", label: "Endpoints", icon: Server },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/providers", label: "Providers", icon: Network },
      { to: "/health", label: "Health", icon: Activity },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/schemas", label: "Schemas", icon: FileCode },
      { to: "/gaps", label: "Gaps", icon: AlertOctagon },
    ],
  },
  {
    label: "About",
    items: [{ to: "/about", label: "Methodology", icon: Info }],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="space-y-6">
      {SECTIONS.map((section) => (
        <div key={section.label}>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-2 px-2">
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
                    className={classNames(
                      "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors",
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
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Unofficial registry
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

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = q.trim();
        if (!value) return;
        navigate({ to: "/subnets", search: { q: value } as never });
      }}
      className="relative flex-1 max-w-md"
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search netuids, symbols, providers, URLs…"
        className="w-full rounded border border-border bg-card pl-8 pr-3 py-1.5 text-sm placeholder:text-ink-muted focus:outline-none focus:border-ink/30 transition-colors"
      />
    </form>
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
  const crumbs = buildCrumbs(pathname);

  return (
    <div className="min-h-screen bg-paper text-ink">
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
                className="rounded p-1 text-ink-muted hover:bg-surface"
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
              className="md:hidden rounded p-1.5 text-ink hover:bg-surface"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="size-4" />
            </button>
            <nav className="hidden md:flex items-center gap-1.5 text-xs text-ink-muted min-w-0">
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
