import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Github, Menu, Rss, Search } from "lucide-react";
import {
  API_BASE,
  DEFAULT_DISCORD_URL,
  DEFAULT_GITHUB_REPO,
  DISCORD_URL,
  GITHUB_REPO,
} from "@/lib/metagraphed/config";
import {
  DefinitionsProvider,
  ActiveEntityProvider,
  ExternalLink,
  safeExternalUrl,
  DiscordIcon,
  Wordmark,
  BackToTop,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@jsonbored/ui-kit";
import { SettingsPopover, SettingsPanel } from "./settings-popover";
import { classNames } from "@/lib/metagraphed/format";
import { freshnessQuery } from "@/lib/metagraphed/queries";
import { CommandPalette } from "./command-palette";
import { NavOmnibox } from "./nav-omnibox";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import { DEFINITIONS } from "@/lib/metagraphed/definitions";
import { pushRecentVisit, visitFromPath } from "@/lib/metagraphed/recent-visits";
import { useHydrated } from "@/hooks/use-hydrated";

// Brand links resolve from build-time env constants, but still run them through
// the external-URL guard (with a known-good fallback) so a misconfigured
// override can't inject an unsafe href.
const GITHUB_HREF = safeExternalUrl(GITHUB_REPO) ?? DEFAULT_GITHUB_REPO;
const DISCORD_HREF = safeExternalUrl(DISCORD_URL) ?? DEFAULT_DISCORD_URL;

/**
 * The five primary destinations. The header is a thin strip -- wordmark, these
 * five, search, settings -- and nothing else (#11605): no mega-menu, no ticker,
 * no breadcrumb strip, no incident banner. A route's own sections are
 * navigated on the page, not from the chrome.
 */
const PRIMARY_NAV: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/subnets", label: "Subnets" },
  { to: "/validators", label: "Validators" },
  { to: "/chain", label: "Chain" },
  { to: "/accounts", label: "Accounts" },
  { to: "/apis", label: "APIs" },
];

function isActive(pathname: string, to: string): boolean {
  if (to === "/chain") return pathname === "/chain" || pathname.startsWith("/chain/");
  if (to === "/apis")
    return (
      pathname === "/apis" || pathname.startsWith("/apis/") || pathname.startsWith("/providers")
    );
  return pathname === to || pathname.startsWith(`${to}/`);
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      to="/"
      onClick={onNavigate}
      aria-label="Metagraphed — home"
      className="flex items-center shrink-0 text-ink-strong"
    >
      <Wordmark className="h-6 w-auto" />
    </Link>
  );
}

export function AppShell({
  children,
  fullBleedMain = false,
}: {
  children: ReactNode;
  // Fumadocs' DocsLayout manages its own full-height sidebar/content grid
  // and expects to control its own padding -- the standard max-w-shell-max
  // + px/py wrapper below would squeeze its sidebar into the content column.
  fullBleedMain?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  // The hamburger sits in the header, not inside the mobile-nav <Sheet>, so it
  // can't be a <SheetTrigger> and Radix has no trigger node to return focus to
  // on close. Keep a ref and restore it in onCloseAutoFocus.
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette opens from a global keydown (⌘K / Ctrl+K / "/") and from
  // discrete buttons. Radix Dialog only auto-returns focus to a composed
  // trigger, so capture the invoking element and restore focus on close.
  const paletteTriggerRef = useRef<HTMLElement | null>(null);
  const openPaletteFrom = useCallback((trigger: HTMLElement | null) => {
    paletteTriggerRef.current = trigger;
    setPaletteOpen(true);
  }, []);
  const handlePaletteOpenChange = useCallback((open: boolean) => {
    setPaletteOpen(open);
    if (!open) {
      const trigger = paletteTriggerRef.current;
      paletteTriggerRef.current = null;
      if (trigger) requestAnimationFrame(() => trigger.focus());
    }
  }, []);

  // Close the mobile sheet and palette on route change; track the visit.
  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
    const v = visitFromPath(pathname);
    if (v) pushRecentVisit(v);
  }, [pathname]);

  // Publish the live header height as --mg-sticky-offset so sticky sub-nav /
  // toolbars pin flush against the chrome.
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("header.mg-header");
    if (!header) return;
    const publish = () => {
      const h = header.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--mg-sticky-offset", `${Math.round(h)}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(header);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, [pathname]);

  // Global ⌘K / Ctrl+K / `/` opens the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        paletteTriggerRef.current = null;
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !inField) {
        e.preventDefault();
        paletteTriggerRef.current = null;
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <DefinitionsProvider definitions={DEFINITIONS}>
      <ActiveEntityProvider>
        <ApiSourceProvider>
          <div className="min-h-dvh text-ink flex flex-col">
            {/* Skip link: first focusable element, visible only on keyboard focus. */}
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--mg-z-skip-link)] focus:rounded focus:bg-ink-strong focus:px-4 focus:py-2 focus:text-paper"
            >
              Skip to main content
            </a>

            <header className="mg-header sticky top-0 z-[var(--mg-z-nav)]">
              <div className="max-w-shell-max mx-auto px-4 md:px-8 flex h-nav items-center gap-4">
                <button
                  ref={hamburgerRef}
                  type="button"
                  className="lg:hidden rounded text-ink hover:bg-layer min-h-11 min-w-11 inline-flex items-center justify-center"
                  onClick={() => setMobileOpen(true)}
                  aria-label="Open menu"
                >
                  <Menu className="size-4" aria-hidden="true" />
                </button>
                <Brand />
                <nav aria-label="Primary" className="hidden lg:flex items-center gap-1">
                  {PRIMARY_NAV.map((item) => {
                    const active = isActive(pathname, item.to);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        aria-current={active ? "page" : undefined}
                        className={classNames(
                          "inline-flex items-center rounded px-3 h-8 text-13 transition-colors",
                          active
                            ? "text-ink-strong bg-layer"
                            : "text-ink-muted hover:text-ink-strong hover:bg-layer",
                        )}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </nav>
                <div className="flex-1 min-w-0 flex justify-end items-center gap-2">
                  <NavOmnibox
                    onOpenPalette={() =>
                      openPaletteFrom(
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null,
                      )
                    }
                  />
                  {/* Below md the omnibox is hidden, which would leave the palette
                    reachable only via keyboard shortcuts -- none of which exist
                    on a touch device. */}
                  <button
                    type="button"
                    onClick={(e) => openPaletteFrom(e.currentTarget)}
                    aria-label="Open search"
                    title="Search"
                    className="md:hidden inline-flex items-center justify-center rounded border border-border min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-rule-strong transition-colors"
                  >
                    <Search className="size-4" aria-hidden="true" />
                  </button>
                  <div className="hidden md:inline-flex">
                    <SettingsPopover />
                  </div>
                </div>
              </div>
            </header>

            {/* Mobile navigation sheet: the shared Sheet (Radix Dialog) primitive
              gives it a focus trap, Escape-to-close and role="dialog". */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetContent
                side="left"
                className="flex w-72 max-w-[82vw] flex-col gap-6 border-r border-border bg-canvas p-4"
                onCloseAutoFocus={(event) => {
                  const el = hamburgerRef.current;
                  if (el && el.isConnected) {
                    event.preventDefault();
                    el.focus();
                  }
                }}
              >
                <SheetTitle className="sr-only">Site navigation</SheetTitle>
                <Brand onNavigate={() => setMobileOpen(false)} />
                <nav aria-label="Primary" className="flex flex-col">
                  {PRIMARY_NAV.map((item) => {
                    const active = isActive(pathname, item.to);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={() => setMobileOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={classNames(
                          "flex items-center min-h-11 px-2 rounded text-16 transition-colors",
                          active ? "text-ink-strong bg-layer" : "text-ink hover:bg-layer",
                        )}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                  <Link
                    to="/settings"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center min-h-11 px-2 rounded text-16 text-ink hover:bg-layer transition-colors"
                  >
                    Settings
                  </Link>
                </nav>
                <div className="mt-auto border-t border-border pt-4">
                  <SettingsPanel />
                </div>
              </SheetContent>
            </Sheet>

            <main
              id="main-content"
              key={pathname}
              className={classNames(
                "flex-1 w-full",
                fullBleedMain ? "" : "px-4 md:px-10 max-w-shell-max mx-auto pb-12 pt-10 md:pt-12",
              )}
            >
              {children}
            </main>

            <SiteFooter />
            <CommandPalette open={paletteOpen} onOpenChange={handlePaletteOpenChange} />
            <BackToTop />
          </div>
        </ApiSourceProvider>
      </ActiveEntityProvider>
    </DefinitionsProvider>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border">
      <div className="max-w-shell-max mx-auto px-4 md:px-10 py-12 grid gap-10 md:grid-cols-5 text-13 text-ink-muted">
        <div className="md:col-span-1">
          <div className="inline-flex items-baseline gap-1 text-13 font-medium text-ink-strong">
            Metagraphed
            <span aria-hidden className="mg-live-dot translate-y-[-0.15em]" />
          </div>
          <p className="mt-2 max-w-xs">
            Unofficial public-interface registry and developer block explorer for Bittensor. All
            data is public, chain-direct, and verifiable.
          </p>
          <div className="mt-4 flex items-center gap-1">
            <ExternalLink
              bare
              href={GITHUB_HREF}
              ariaLabel="GitHub repository"
              title="Open source on GitHub"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-layer transition-colors"
            >
              <Github className="size-4" aria-hidden="true" />
            </ExternalLink>
            <ExternalLink
              bare
              href={DISCORD_HREF}
              ariaLabel="Discord community"
              title="Join us on Discord"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-layer transition-colors"
            >
              <DiscordIcon className="size-4" />
            </ExternalLink>
            <ExternalLink
              bare
              href={`${API_BASE}/api/v1/feeds/registry.rss`}
              ariaLabel="Registry changes RSS feed"
              title="Subscribe to the registry-changes feed (RSS)"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-layer transition-colors"
            >
              <Rss className="size-4" aria-hidden="true" />
            </ExternalLink>
          </div>
        </div>
        <FooterCol title="Registry">
          <FooterLink to="/subnets">Subnets</FooterLink>
          <FooterLink to="/validators">Validators</FooterLink>
          <FooterLink to="/accounts">Accounts</FooterLink>
          <FooterLink to="/health">Health</FooterLink>
          <FooterLink to="/contribute">Contribute</FooterLink>
        </FooterCol>
        {/* Governance and Runtime were links here until #11619 retired those
            routes into sections of /chain. The four that remain are the three
            record lists plus the page that now holds the rest — a footer link
            to a 301 would have sent the reader (and a crawler) through a hop to
            reach a heading on a page this column already links. */}
        <FooterCol title="Chain">
          <FooterLink to="/chain">Overview</FooterLink>
          <FooterLink to="/chain/blocks">Blocks</FooterLink>
          <FooterLink to="/chain/extrinsics">Extrinsics</FooterLink>
          <FooterLink to="/chain/events">Events</FooterLink>
        </FooterCol>
        <FooterCol title="APIs">
          <FooterLink to="/apis">Catalog</FooterLink>
          <FooterLink to="/apis/endpoints">Endpoints</FooterLink>
          <FooterLink to="/apis/schemas">Schemas</FooterLink>
          <FooterLink to="/apis/providers">Providers</FooterLink>
          <FooterLink to="/agents">For agents</FooterLink>
          <FooterLink to="/docs">Docs</FooterLink>
        </FooterCol>
        <FooterCol title="About">
          <FooterLink to="/about">About</FooterLink>
          {/* The only link to /news anywhere on the site (#11266). */}
          <FooterLink to="/news">Weekly digests</FooterLink>
          <FooterLink to="/settings">Settings</FooterLink>
          {/* The only link to these anywhere on the site (#11567). */}
          <FooterLink to="/privacy">Privacy</FooterLink>
          <FooterLink to="/terms">Terms</FooterLink>
        </FooterCol>
      </div>
      <div className="border-t border-border">
        <div className="max-w-shell-max mx-auto px-4 md:px-10 py-4 flex flex-wrap items-center justify-between gap-2 text-11 text-ink-muted">
          <span>
            © {new Date().getFullYear()} Metagraphed · Not an OpenTensor/Bittensor product
          </span>
          <SourcesLine />
        </div>
      </div>
    </footer>
  );
}

/** `sources N · stale N · openapi` -- the one liveness line in the chrome. */
function SourcesLine() {
  const hydrated = useHydrated();
  const freshness = useQuery({ ...freshnessQuery(), retry: 0, enabled: hydrated });
  const f = hydrated ? freshness.data?.data : undefined;
  const stale = f?.stale_count ?? 0;
  const sources = f?.sources?.length ?? 0;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
      <span>
        sources <span className="text-ink-strong">{sources}</span>
      </span>
      <span aria-hidden="true">·</span>
      <span>
        stale{" "}
        <span className={classNames(stale ? "text-health-warn" : "text-ink-strong")}>{stale}</span>
      </span>
      <span aria-hidden="true">·</span>
      <ExternalLink
        bare
        href={`${API_BASE}/api/v1/openapi.json`}
        className="hover:text-ink-strong transition-colors"
      >
        openapi
      </ExternalLink>
    </span>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-13 text-ink-strong mb-3">{title}</div>
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
