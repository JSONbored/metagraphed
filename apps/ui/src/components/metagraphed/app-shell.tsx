import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  Github,
  Menu,
  Rss,
  Search,
  Webhook,
} from "lucide-react";
import {
  API_BASE,
  DEFAULT_DISCORD_URL,
  DEFAULT_GITHUB_REPO,
  DISCORD_URL,
  GITHUB_REPO,
} from "@/lib/metagraphed/config";
import { useApiBase } from "@/hooks/use-api-base";
import { useEndpointHealth, type EndpointHealth } from "@/hooks/use-endpoint-health";
import { NetworkSwitcher } from "./network-switcher";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  CopyableCode,
  safeExternalUrl,
  DiscordIcon,
  TimeAgo,
  Wordmark,
  BackToTop,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@jsonbored/ui-kit";
import { SettingsPopover } from "./settings-popover";
import { WalletConnectButton } from "./wallet-connect";
import { classNames } from "@/lib/metagraphed/format";
import { freshnessQuery, buildQuery } from "@/lib/metagraphed/queries";
import { NavMegaMenu, MobileMegaMenu } from "./nav-mega-menu";
import { RegistryTicker } from "./registry-ticker";
import { ShortcutsPopover } from "./shortcuts-popover";
import { CommandPalette } from "./command-palette";
import { NavOmnibox } from "./nav-omnibox";
import { ApiDrawer, ApiDrawerTrigger } from "./api-drawer";
import { HeaderActionsMenu } from "./header-actions-menu";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import { IncidentStrip } from "./incident-strip";
import { pushRecentVisit, visitFromPath } from "@/lib/metagraphed/recent-visits";
import { buildCrumbs, parentCrumb } from "./breadcrumb-nav";

// Brand links resolve from build-time env constants, but still run them through
// the external-URL guard (with a known-good fallback) so a misconfigured
// override can't inject an unsafe href — the same treatment the API links get.
const GITHUB_HREF = safeExternalUrl(GITHUB_REPO) ?? DEFAULT_GITHUB_REPO;
const DISCORD_HREF = safeExternalUrl(DISCORD_URL) ?? DEFAULT_DISCORD_URL;

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

export function AppShell({
  children,
  fullBleedMain = false,
}: {
  children: ReactNode;
  // Fumadocs' DocsLayout manages its own full-height sidebar/content grid
  // and expects to control its own padding -- the standard max-w-shell-max
  // + px/py wrapper below would squeeze its sidebar into the content column
  // instead of letting it span the full width under the header.
  fullBleedMain?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  // #6416: the hamburger sits in the header, not inside the mobile-nav <Sheet>,
  // so it can't be a <SheetTrigger> and Radix has no trigger node to return focus
  // to on close -- it drops to <body>. Keep a ref to the hamburger and restore
  // it in the Sheet's onCloseAutoFocus. (Same shape as ApiDrawer's #6418 fix; the
  // hamburger is this Sheet's only opener, so a direct ref is enough.)
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // #6417: the palette opens both from a global keydown (⌘K / Ctrl+K / "/", no
  // DOM trigger) and from discrete buttons (the omnibox "Full search" + the
  // mobile search icon). Radix Dialog only auto-returns focus to a composed
  // <Dialog.Trigger>, which none of these are, so closing drops focus to
  // <body>. Capture the invoking element for the discrete triggers and restore
  // focus to it on close; keydown-opened stays null (no trigger, so leaving
  // focus where it was is the correct fallback).
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
      // Defer past Radix's own close-focus handling so ours wins.
      if (trigger) requestAnimationFrame(() => trigger.focus());
    }
  }, []);
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname]);
  const parent = useMemo(() => parentCrumb(crumbs), [crumbs]);

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
            <div className="max-w-shell-max mx-auto px-4 md:px-8 flex h-nav items-center gap-3">
              <button
                ref={hamburgerRef}
                className="lg:hidden rounded-md p-2 text-ink hover:bg-surface min-h-11 min-w-11 inline-flex items-center justify-center"
                onClick={() => setMobileOpen(true)}
                aria-label="Open menu"
              >
                <Menu className="size-4" />
              </button>
              <Brand />
              <span aria-hidden className="hidden lg:inline-block h-5 w-px bg-border mx-1" />
              <NavMegaMenu />
              <div className="flex-1 min-w-0 flex justify-end">
                <NavOmnibox
                  onOpenPalette={() =>
                    openPaletteFrom(
                      document.activeElement instanceof HTMLElement ? document.activeElement : null,
                    )
                  }
                />
                {/* Below md the omnibox is hidden (#5034), which left the palette
                    reachable only via ⌘K / Ctrl+K / "/" — none of which exist on a
                    touch device, so mobile had no way into global search at all.
                    This is that missing entry point: same setPaletteOpen the
                    keyboard shortcuts use, shown exactly where the omnibox isn't
                    (#5319). */}
                <button
                  type="button"
                  onClick={(e) => openPaletteFrom(e.currentTarget)}
                  aria-label="Open search"
                  title="Search"
                  className="md:hidden inline-flex items-center justify-center rounded border border-border bg-card p-1.5 min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
                >
                  <Search className="size-4" aria-hidden="true" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                <ApiDrawerTrigger />

                <NetworkSwitcher />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to="/settings"
                      aria-label="Developer settings"
                      className="hidden md:inline-flex lg:hidden xl:inline-flex items-center justify-center rounded border border-border bg-card p-1.5 min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
                    >
                      <Webhook className="size-3.5" aria-hidden="true" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-[11px]">
                    Developer settings — webhook subscriptions
                  </TooltipContent>
                </Tooltip>
                <div className="hidden md:inline-flex lg:hidden xl:inline-flex">
                  <SettingsPopover />
                </div>
                {/* Wallet-connect (#5236) is a secondary action for now (read-only,
                    no signing yet) — same responsive treatment as the developer-
                    settings link/SettingsPopover above, not a fourth unconditional
                    icon alongside ApiDrawerTrigger/NetworkSwitcher. */}
                <div className="hidden md:inline-flex lg:hidden xl:inline-flex">
                  <WalletConnectButton />
                </div>
                {/* At lg the mega-menu appears and the trailing icons no longer
                    fit; fold the secondary actions into one popover until xl
                    restores the room (#3985). */}
                <div className="hidden lg:inline-flex xl:hidden">
                  <HeaderActionsMenu />
                </div>
              </div>
            </div>
            <RegistryTicker />
            {/* Secondary breadcrumb row (desktop) / compact back affordance (mobile), hidden on home */}
            {crumbs.length > 1 ? (
              <>
                {parent ? (
                  <div className="md:hidden border-t border-border/70 bg-paper/60">
                    <div className="max-w-shell-max mx-auto px-4 h-9 flex items-center">
                      <Link
                        to={parent.to}
                        className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink-strong transition-colors font-mono uppercase tracking-widest text-[10px]"
                      >
                        <ChevronLeft className="size-3" />
                        {parent.label}
                      </Link>
                    </div>
                  </div>
                ) : null}
                <div className="hidden md:block border-t border-border/70 bg-paper/60">
                  <div className="max-w-shell-max mx-auto px-4 md:px-8 h-9 flex items-center">
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
              </>
            ) : null}
          </header>

          <IncidentStrip />

          {/* Mobile navigation sheet. Using the shared Sheet (Radix Dialog)
              primitive — the one ApiDrawer already uses — gives it a focus
              trap, Escape-to-close, and role="dialog" for free, instead of the
              previous hand-rolled <aside> a keyboard user could Tab out of (#5336). */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent
              side="left"
              className="flex w-72 max-w-[82vw] flex-col gap-4 border-r border-border bg-paper p-4"
              onCloseAutoFocus={(event) => {
                // #6416: restore focus to the hamburger, which Radix can't do on
                // its own here (no in-tree SheetTrigger).
                const el = hamburgerRef.current;
                if (el && el.isConnected) {
                  event.preventDefault();
                  el.focus();
                }
              }}
            >
              <SheetTitle className="sr-only">Site navigation</SheetTitle>
              <Brand onNavigate={() => setMobileOpen(false)} />
              <div className="mg-label inline-flex items-center gap-1">
                <Compass className="size-3" /> Unofficial registry
              </div>
              <MobileMegaMenu onNavigate={() => setMobileOpen(false)} />
              <div className="flex items-center gap-2">
                <Link
                  to="/settings"
                  onClick={() => setMobileOpen(false)}
                  className="inline-flex flex-1 items-center gap-2 rounded border border-border bg-card px-3 py-2 text-[13px] text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
                >
                  <Webhook className="size-3.5" aria-hidden="true" /> Developer settings
                </Link>
                <SettingsPopover />
                {/* #5236: mobile has no other wallet-connect entry point (the
                    header trigger is `hidden` below `md`, and folding it into
                    HeaderActionsMenu doesn't help either -- that's ALSO
                    `hidden` below `lg`) -- without this it would be
                    unreachable below `md` entirely. */}
                <WalletConnectButton />
              </div>
              <div className="mt-auto border-t border-border pt-3">
                <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted mb-1.5">
                  API base
                </div>
                <ApiBaseRow />
              </div>
            </SheetContent>
          </Sheet>

          <main
            id="main-content"
            key={pathname}
            className={classNames(
              "flex-1 w-full mg-route-enter",
              fullBleedMain ? "" : "px-4 md:px-10 py-10 md:py-14 max-w-shell-max mx-auto",
            )}
          >
            {children}
          </main>

          <SiteFooter />
          <ApiDrawer />
          <CommandPalette open={paletteOpen} onOpenChange={handlePaletteOpenChange} />
          <ShortcutsPopover />
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
      <div className="max-w-shell-max mx-auto px-4 md:px-10 py-14 grid gap-10 md:grid-cols-5 text-[12px] text-ink-muted">
        <div className="md:col-span-2">
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
          <div className="mt-4 flex items-center gap-1">
            <a
              href={GITHUB_HREF}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub repository"
              title="Open source on GitHub"
              className="inline-flex items-center justify-center rounded-md size-8 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
            >
              <Github className="size-4" />
            </a>
            <a
              href={DISCORD_HREF}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Discord community"
              title="Join us on Discord"
              className="inline-flex items-center justify-center rounded-md size-8 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
            >
              <DiscordIcon className="size-4" />
            </a>
            {/* #3351: discoverable RSS/Atom feed for the registry-changes feed
                (/api/v1/feeds/registry, content-negotiated; .rss for a predictable
                browser click). Same guarded external-link pattern as the openapi
                link and the GitHub/Discord icons above. */}
            <a
              href={safeExternalUrl(`${API_BASE}/api/v1/feeds/registry.rss`)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Registry changes RSS feed"
              title="Subscribe to the registry-changes feed (RSS)"
              className="inline-flex items-center justify-center rounded-md size-8 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
            >
              <Rss className="size-4" />
            </a>
          </div>
        </div>
        <FooterCol title="Registry">
          <FooterLink to="/subnets">Subnets</FooterLink>
          <FooterLink to="/blocks">Blocks</FooterLink>
          <FooterLink to="/surfaces">Surfaces</FooterLink>
          <FooterLink to="/endpoints">Endpoints</FooterLink>
          <FooterLink to="/providers">Providers</FooterLink>
          <FooterLink to="/validators">Validators</FooterLink>
        </FooterCol>
        <FooterCol title="Operations">
          <FooterLink to="/health">Health</FooterLink>
          <FooterLink to="/status">Status</FooterLink>
          <FooterLink to="/schemas">Schemas</FooterLink>
          <FooterLink to="/gaps">Gaps</FooterLink>
          <FooterLink to="/agents">For agents</FooterLink>
          <FooterLink to="/about">About</FooterLink>
        </FooterCol>
        <FooterCol title="Guides">
          <FooterLink to="/docs/blocks">Blocks</FooterLink>
          <FooterLink to="/docs/extrinsics">Extrinsics</FooterLink>
          <FooterLink to="/docs/accounts">Accounts</FooterLink>
          <FooterLink to="/docs/subnets">Subnets</FooterLink>
          <FooterLink to="/docs/metagraph">Metagraph & validators</FooterLink>
          <FooterLink to="/docs/economics">Economics</FooterLink>
          <FooterLink to="/docs/health">Health & readiness</FooterLink>
          <FooterLink to="/docs/chain-analytics">Chain analytics</FooterLink>
          <FooterLink to="/docs/chain-events">Chain events</FooterLink>
          <FooterLink to="/docs/webhooks">Webhooks</FooterLink>
          <FooterLink to="/docs/search-ai">Search & AI</FooterLink>
          <FooterLink to="/docs/feeds">Feeds</FooterLink>
          <FooterLink to="/docs/graphql">GraphQL</FooterLink>
          <FooterLink to="/docs/rpc">RPC</FooterLink>
        </FooterCol>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-shell-max mx-auto px-4 md:px-10 py-3">
          <RegistryPulseStrip />
        </div>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-shell-max mx-auto px-4 md:px-10 py-4 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-ink-muted">
          <span>
            © {new Date().getFullYear()} Metagraphed · Not an OpenTensor/Bittensor product
          </span>
          <EndpointHealthPill />
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
  // Freshness carries an `[key: string]: unknown` index signature, so guard the
  // timestamp to a real string before handing it to TimeAgo.
  const updatedAt = typeof f?.generated_at === "string" ? f.generated_at : null;
  return (
    <div className="mg-ticker">
      {updatedAt ? (
        <>
          <span>
            <span className="text-ink-muted">updated</span>{" "}
            <span className="text-ink-strong">
              <TimeAgo at={updatedAt} />
            </span>
          </span>
          <span>·</span>
        </>
      ) : null}
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

// Map the live endpoint-health tier to a design-system health token. Only the
// dot is coloured (via currentColor); the text stays neutral for AA contrast.
const ENDPOINT_TONE: Record<EndpointHealth, string> = {
  checking: "text-ink-muted",
  ok: "text-health-ok",
  slow: "text-health-warn",
  bad: "text-health-bad",
  down: "text-health-down",
};

const ENDPOINT_LABEL: Record<EndpointHealth, string> = {
  checking: "checking…",
  ok: "healthy",
  slow: "slow",
  bad: "degraded",
  down: "down",
};

// The live API endpoint with a glowing dot that reflects round-trip health
// (green ok · yellow slow · orange bad · red down). The dot carries the status,
// so the visible text is just the latency; the word form lives in the tooltip
// (and aria) for colour-blind / screen-reader users.
function EndpointHealthPill() {
  const { base } = useApiBase();
  const { status, ms } = useEndpointHealth();
  const tone = ENDPOINT_TONE[status];
  const endpoint = `${base.replace(/^https?:\/\//, "")}/api/v1`;
  const detail =
    status === "down" ? "unreachable" : status === "checking" ? "checking…" : `${ms} ms`;
  const title = `API endpoint · ${ENDPOINT_LABEL[status]}${ms != null ? ` · ${ms} ms` : ""}`;
  return (
    <a
      href={safeExternalUrl(`${base}/api/v1`)}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="shrink-0 inline-flex items-center gap-2 text-ink-muted hover:text-ink-strong transition-colors"
    >
      <span className={classNames("mg-health-dot", tone)} aria-hidden />
      <span className="hidden sm:inline">{endpoint}</span>
      <span className="text-ink-subtle" aria-hidden>
        ·
      </span>
      <span>{detail}</span>
    </a>
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
