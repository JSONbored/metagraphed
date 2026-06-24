import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Compass, Github, Menu, X } from "lucide-react";
import { API_BASE, GITHUB_REPO } from "@/lib/metagraphed/config";
import { useApiBase } from "@/hooks/use-api-base";
import { NetworkSwitcher } from "./network-switcher";
import { CopyableCode } from "./copyable-code";
import { SettingsPopover } from "./settings-popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { classNames } from "@/lib/metagraphed/format";
import { safeExternalUrl } from "./external-link";
import { Wordmark } from "./wordmark";
import { freshnessQuery, buildQuery } from "@/lib/metagraphed/queries";
import { NavMegaMenu, MobileMegaMenu } from "./nav-mega-menu";
import { RegistryTicker } from "./registry-ticker";
import { ShortcutsPopover } from "./shortcuts-popover";
import { CommandPalette } from "./command-palette";
import { NavOmnibox } from "./nav-omnibox";
import { ApiDrawer, ApiDrawerTrigger } from "./api-drawer";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import { IncidentStrip } from "./incident-strip";
import { pushRecentVisit, visitFromPath } from "@/lib/metagraphed/recent-visits";
import { BackToTop } from "./back-to-top";

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

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      to="/"
      onClick={onNavigate}
      aria-label="Metagraphed — home"
      className="flex items-center shrink-0 group text-ink-strong"
    >
      {/* Adaptive wordmark: mint M + currentColor text → follows text-ink-strong
          across light/dark. h-6 ≈ the prior 24px logo footprint. */}
      <Wordmark className="h-6 w-auto" />
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname]);

  // Close mobile sheet on route change
  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
    // Track visit for the "Continue exploring" rail.
    const v = visitFromPath(pathname);
    if (v) pushRecentVisit(v);
  }, [pathname]);

  // Scroll-aware header
  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Global ⌘K / Ctrl+K / `/` opens the palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !inField) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <ApiSourceProvider>
        <div className="min-h-dvh bg-paper text-ink flex flex-col">
          {/* Skip link: first focusable element, visible only on keyboard focus. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:bg-ink-strong focus:px-4 focus:py-2 focus:text-paper"
          >
            Skip to main content
          </a>
          {/* Top bar */}
          <header
            data-scrolled={scrolled ? "true" : "false"}
            className="mg-header sticky top-0 z-30 border-b border-border bg-paper/90 backdrop-blur supports-[backdrop-filter]:bg-paper/75"
          >
            <div className="max-w-[1400px] mx-auto px-4 md:px-8 flex h-nav items-center gap-3">
              <button
                className="lg:hidden rounded-md p-2 text-ink hover:bg-surface min-h-10 min-w-10 inline-flex items-center justify-center"
                onClick={() => setMobileOpen(true)}
                aria-label="Open menu"
              >
                <Menu className="size-4" />
              </button>
              <Brand />
              <span aria-hidden className="hidden lg:inline-block h-5 w-px bg-border mx-1" />
              <NavMegaMenu />
              <div className="flex-1 flex justify-end">
                <NavOmnibox onOpenPalette={() => setPaletteOpen(true)} />
              </div>
              <div className="flex items-center gap-1">
                <ApiDrawerTrigger />

                <NetworkSwitcher />
                <ShortcutsPopover />
                <SettingsPopover />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={GITHUB_REPO}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="GitHub repository"
                      className="hidden md:inline-flex items-center justify-center rounded-md size-9 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
                    >
                      <Github className="size-4" />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-[11px]">
                    Open source on GitHub
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <RegistryTicker />
            {/* Secondary breadcrumb row (desktop only, hidden on home) */}
            {crumbs.length > 1 ? (
              <div className="hidden md:block border-t border-border/70 bg-paper/60">
                <div className="max-w-[1400px] mx-auto px-4 md:px-8 h-9 flex items-center">
                  <nav
                    aria-label="Breadcrumb"
                    className="flex items-center gap-1.5 text-xs text-ink-muted min-w-0"
                  >
                    {crumbs.map((c, i) => (
                      <span key={c.to} className="flex items-center gap-1.5 min-w-0">
                        {i > 0 ? <ChevronRight className="size-3 opacity-50" /> : null}
                        <Link
                          to={c.to}
                          className={classNames(
                            "truncate hover:text-ink-strong transition-colors font-mono uppercase tracking-widest text-[10px]",
                            i === crumbs.length - 1 && "text-ink-strong",
                          )}
                        >
                          {c.label}
                        </Link>
                      </span>
                    ))}
                  </nav>
                </div>
              </div>
            ) : null}
          </header>

          <IncidentStrip />

          {/* Mobile sheet */}
          {mobileOpen ? (
            <div className="fixed inset-0 z-50 lg:hidden">
              <div
                className="absolute inset-0 bg-ink-strong/40 backdrop-blur-sm"
                onClick={() => setMobileOpen(false)}
              />
              <aside className="absolute inset-y-0 left-0 w-72 max-w-[82vw] border-r border-border bg-paper p-4 flex flex-col gap-4 mg-fade-in">
                <div className="flex items-center justify-between">
                  <Brand onNavigate={() => setMobileOpen(false)} />
                  <button
                    onClick={() => setMobileOpen(false)}
                    aria-label="Close menu"
                    className="rounded-md p-2 text-ink-muted hover:bg-surface min-h-10 min-w-10 inline-flex items-center justify-center"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="mg-label inline-flex items-center gap-1">
                  <Compass className="size-3" /> Unofficial registry
                </div>
                <MobileMegaMenu onNavigate={() => setMobileOpen(false)} />
                <div className="mt-auto border-t border-border pt-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted mb-1.5">
                    API base
                  </div>
                  <ApiBaseRow />
                </div>
              </aside>
            </div>
          ) : null}

          <main
            id="main-content"
            key={pathname}
            className="flex-1 px-4 md:px-10 py-10 md:py-14 max-w-[1400px] mx-auto w-full mg-route-enter"
          >
            {children}
          </main>

          <SiteFooter />
          <ApiDrawer />
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
          <BackToTop />
        </div>
      </ApiSourceProvider>
    </TooltipProvider>
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

function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border bg-surface/30 relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent"
      />
      <div className="max-w-[1400px] mx-auto px-4 md:px-10 py-14 grid gap-10 md:grid-cols-4 text-[12px] text-ink-muted">
        <div className="md:col-span-1">
          <div className="font-display text-base font-semibold text-ink-strong inline-flex items-baseline gap-1">
            Metagraphed
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full bg-accent translate-y-[-0.15em]"
            />
          </div>
          <p className="mt-2 leading-relaxed max-w-xs">
            Unofficial public-interface registry and developer block explorer for Bittensor. All
            data is public, chain-direct, and verifiable.
          </p>
        </div>
        <FooterCol title="Registry">
          <FooterLink to="/subnets">Subnets</FooterLink>
          <FooterLink to="/blocks">Blocks</FooterLink>
          <FooterLink to="/surfaces">Surfaces</FooterLink>
          <FooterLink to="/endpoints">Endpoints</FooterLink>
          <FooterLink to="/providers">Providers</FooterLink>
        </FooterCol>
        <FooterCol title="Operations">
          <FooterLink to="/health">Health</FooterLink>
          <FooterLink to="/status">Status</FooterLink>
          <FooterLink to="/schemas">Schemas</FooterLink>
          <FooterLink to="/gaps">Gaps</FooterLink>
          <FooterLink to="/agents">For agents</FooterLink>
          <FooterLink to="/about">About</FooterLink>
        </FooterCol>
        <FooterCol title="Data">
          <a
            href={safeExternalUrl(`${API_BASE}/api/v1`)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink-strong transition-colors font-mono break-all"
          >
            {API_BASE.replace(/^https?:\/\//, "")}/api/v1
          </a>
          <a
            href={safeExternalUrl(`${API_BASE}/api/v1/openapi.json`)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink-strong transition-colors"
          >
            OpenAPI spec
          </a>
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink-strong transition-colors inline-flex items-center gap-1"
          >
            <Github className="size-3" /> GitHub
          </a>
        </FooterCol>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-[1400px] mx-auto px-4 md:px-10 py-3">
          <RegistryPulseStrip />
        </div>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-[1400px] mx-auto px-4 md:px-10 py-4 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-ink-muted">
          <span>© {new Date().getFullYear()} Metagraphed — unofficial</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-health-ok mg-pulse" aria-hidden />
            live registry
          </span>
        </div>
      </div>
    </footer>
  );
}

function RegistryPulseStrip() {
  const freshness = useQuery({ ...freshnessQuery(), retry: 0 });
  const build = useQuery({ ...buildQuery(), retry: 0 });
  const f = freshness.data?.data;
  const b = build.data?.data as { version?: string; built_at?: string } | undefined;
  const stale = f?.stale_count ?? 0;
  const sources = f?.sources?.length ?? 0;
  return (
    <div className="mg-ticker">
      <span className="inline-flex items-center gap-1.5">
        <span className="mg-live-dot" aria-hidden />
        <span className="uppercase tracking-[0.22em] text-[10px]">registry pulse</span>
      </span>
      <span>·</span>
      <span>
        <span className="text-ink-muted">sources</span>{" "}
        <span className="text-ink-strong">{sources}</span>
      </span>
      <span>·</span>
      <span>
        <span className="text-ink-muted">stale</span>{" "}
        <span
          className={classNames("tabular-nums", stale ? "text-health-warn" : "text-ink-strong")}
        >
          {stale}
        </span>
      </span>
      {b?.version ? (
        <>
          <span>·</span>
          <span>
            <span className="text-ink-muted">build</span>{" "}
            <span className="text-ink-strong">{b.version}</span>
          </span>
        </>
      ) : null}
      <span>·</span>
      <a
        href={safeExternalUrl(`${API_BASE}/api/v1/openapi.json`)}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-ink-strong transition-colors"
      >
        openapi
      </a>
    </div>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong mb-3">
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function FooterLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="hover:text-ink-strong transition-colors w-fit">
      {children}
    </Link>
  );
}
