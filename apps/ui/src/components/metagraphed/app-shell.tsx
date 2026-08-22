import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { captureEvent } from "@/lib/analytics";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Compass, Github, Menu, Rss, Search, Webhook } from "lucide-react";
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
  ExternalLink,
  safeExternalUrl,
  DiscordIcon,
  TimeAgo,
  Wordmark,
  BackToTop,
  Sheet,
  SheetContent,
  SheetTitle,
  SHARE_COPIED_EVENT,
} from "@jsonbored/ui-kit";
import { SettingsPopover } from "./settings-popover";
import { WalletConnectButton } from "./wallet-connect";
import { classNames } from "@/lib/metagraphed/format";
import { freshnessQuery, buildQuery } from "@/lib/metagraphed/queries";
import { NavMegaMenu, MobileMegaMenu } from "./nav-mega-menu";
import { ShortcutsPopover } from "./shortcuts-popover";
import { CommandPalette } from "./command-palette";
import { NavOmnibox } from "./nav-omnibox";
import { ApiDrawer, ApiDrawerTrigger } from "./api-drawer";
import { HeaderActionsMenu } from "./header-actions-menu";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import { IncidentStrip } from "./incident-strip";
import { pushRecentVisit, visitFromPath } from "@/lib/metagraphed/recent-visits";
import { useHydrated } from "@/hooks/use-hydrated";

// Brand links resolve from build-time env constants, but still run them through
// the external-URL guard (with a known-good fallback) so a misconfigured
// override can't inject an unsafe href — the same treatment the API links get.
const GITHUB_HREF = safeExternalUrl(GITHUB_REPO) ?? DEFAULT_GITHUB_REPO;
const DISCORD_HREF = safeExternalUrl(DISCORD_URL) ?? DEFAULT_DISCORD_URL;

type CommandPaletteTrigger = (trigger: HTMLElement | null) => void;

const CommandPaletteTriggerContext = createContext<CommandPaletteTrigger | null>(null);

/**
 * Opens the shell-owned command palette from page content while retaining the
 * actual invoking control. Unlike a synthetic keyboard event, this lets the
 * dialog restore focus correctly when a keyboard or screen-reader user closes it.
 */
export function useCommandPaletteTrigger(): CommandPaletteTrigger {
  const openPaletteFrom = useContext(CommandPaletteTriggerContext);
  if (!openPaletteFrom) {
    throw new Error("useCommandPaletteTrigger must be used within AppShell.");
  }
  return openPaletteFrom;
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      to="/"
      onClick={onNavigate}
      aria-label="Metagraphed — home"
      className="flex items-center shrink-0 group text-ink-strong"
    >
      {/* Adaptive wordmark: the existing mark remains Metagraphed's own while
          the surrounding terminal system follows the active theme. */}
      <Wordmark className="h-6 w-auto" />
    </Link>
  );
}

export function AppShell({
  children,
  fullBleedMain = false,
  flushTop = false,
  afterHeader,
  // Still accepted, and still passed by every detail route — it named the
  // last breadcrumb, and the breadcrumb row is gone. The prop stays because
  // the server-rendered BreadcrumbList JSON-LD is the thing that actually
  // consumed the label's intent, and removing it from 20+ call sites would
  // be churn for no behavioural change.
  crumbLabel: _crumbLabel,
  chrome = "default",
}: {
  children: ReactNode;
  // Fumadocs' DocsLayout manages its own full-height sidebar/content grid
  // and expects to control its own padding -- the standard max-w-shell-max
  // + px/py wrapper below would squeeze its sidebar into the content column
  // instead of letting it span the full width under the header.
  fullBleedMain?: boolean;
  // Drop <main>'s top padding so the first child sits flush against whatever
  // renders in `afterHeader` (used by the home route to eliminate the gap
  // between the alpha-price ticker and the hero).
  flushTop?: boolean;
  // Slot rendered flush beneath the header chrome, before <main>'s padded
  // column. Used by the home route to seat the alpha-price ticker in what
  // would otherwise be dead space between the ecosystem strip and the hero.
  afterHeader?: ReactNode;
  // Overrides the trailing (leaf) breadcrumb's label. `buildCrumbs` only ever
  // sees the raw URL segment (e.g. "1", "0x4f2a…"), so detail routes that want
  // to show something a user actually recognizes -- a zero-padded netuid, a
  // comma-grouped block number, an entity's display name -- pass it here
  // instead of standing up a second, redundant breadcrumb trail of their own
  // (#7853). Only ever the last crumb; every ancestor segment stays generic.
  crumbLabel?: string;
  // Landing pages retain the complete navigational header but suppress the
  // dense live ticker, giving a primary visual story room to establish itself
  // before someone opts into network telemetry.
  chrome?: "default" | "landing";
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

  // Close mobile sheet on route change
  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
    // Track visit for the "Continue exploring" rail.
    const v = visitFromPath(pathname);
    if (v) pushRecentVisit(v);
  }, [pathname]);

  // #8256: one global listener for ui-kit's share-copied announcement, so the
  // event is instrumented once rather than threaded through ~20 call sites.
  useEffect(() => {
    const onShareCopied = () => captureEvent("share_copied");
    window.addEventListener(SHARE_COPIED_EVENT, onShareCopied);
    return () => window.removeEventListener(SHARE_COPIED_EVENT, onShareCopied);
  }, []);

  // Publish the live header height as --mg-sticky-offset so downstream sticky
  // sub-nav / toolbars can pin flush against the chrome instead of hardcoding
  // top-14 (which is wrong once the ticker + breadcrumb strips render).
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
    <CommandPaletteTriggerContext.Provider value={openPaletteFrom}>
      <TooltipProvider delayDuration={150}>
        <ApiSourceProvider>
          {/* Deliberately no background here. The page plane is intentionally
            quiet; routes add the one structural cue they need instead of a
            decorative texture being forced behind every explorer table. */}
          <div
            className={classNames(
              "min-h-dvh text-ink flex flex-col",
              chrome === "landing" && "mg-shell--landing",
            )}
          >
            {/* Skip link: first focusable element, visible only on keyboard focus. */}
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--mg-z-skip-link)] focus:rounded focus:bg-ink-strong focus:px-4 focus:py-2 focus:text-paper"
            >
              Skip to main content
            </a>
            {/* Top bar */}
            <header
              data-scrolled={scrolled ? "true" : "false"}
              className={classNames(
                "mg-header sticky top-0 z-[var(--mg-z-nav)] border-b border-border bg-paper",
                chrome === "landing" && "mg-header--landing",
              )}
            >
              <div className="max-w-shell-max mx-auto px-4 md:px-8 flex h-nav items-center gap-3">
                <button
                  ref={hamburgerRef}
                  className="lg:hidden p-2 text-ink hover:bg-surface-2 min-h-11 min-w-11 inline-flex items-center justify-center transition-colors"
                  onClick={() => setMobileOpen(true)}
                  aria-label="Open menu"
                >
                  <Menu className="size-4" />
                </button>
                <Brand />
                <span aria-hidden className="hidden lg:inline-block h-5 w-px bg-border mx-1" />
                <NavMegaMenu />
                <div className="flex-1 min-w-0 flex justify-end items-center gap-1">
                  <NavOmnibox
                    onOpenPalette={() =>
                      openPaletteFrom(
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null,
                      )
                    }
                  />
                  {/* The compact shell runs through tablet width. Keeping the full
                    omnibox alongside a menu, network switcher, and utility actions
                    made the 768px header a clipped desktop row rather than an
                    intentional touch-first control strip. The search trigger opens
                    the same palette without sacrificing that breathing room. */}
                  <button
                    type="button"
                    onClick={(e) => openPaletteFrom(e.currentTarget)}
                    aria-label="Open search"
                    title="Search"
                    className="lg:hidden inline-flex items-center justify-center p-1.5 min-h-11 min-w-11 text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors"
                  >
                    <Search className="size-4" aria-hidden="true" />
                  </button>
                </div>
                {/* min-w-0 matches the omnibox wrapper above (#8531): without
                  it this cluster's min-width is its content width, so any
                  future growth in the trailing actions would push it past
                  the right viewport edge instead of letting flex shrink it. */}
                <div className="flex items-center gap-1 min-w-0">
                  <ApiDrawerTrigger />

                  <NetworkSwitcher />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        to="/settings"
                        aria-label="Developer settings"
                        className="hidden xl:inline-flex items-center justify-center p-1.5 min-h-11 min-w-11 text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors"
                      >
                        <Webhook className="size-3.5" aria-hidden="true" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="mg-type-caption">
                      Developer settings — webhook subscriptions
                    </TooltipContent>
                  </Tooltip>
                  <div className="hidden xl:inline-flex">
                    <SettingsPopover />
                  </div>
                  {/* Wallet-connect (#5236) is a secondary action for now (read-only,
                    no signing yet) — same responsive treatment as the developer-
                    settings link/SettingsPopover above, not a fourth unconditional
                    icon alongside ApiDrawerTrigger/NetworkSwitcher. */}
                  <div className="hidden xl:inline-flex">
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
              {/* ONE strip.
                  This header carried three stacked rows: the identity/nav row,
                  a live registry ticker, and a breadcrumb row — 3 layers of
                  chrome above every page on the site, ~110px of it, none of
                  which answered the question the page was opened to answer.

                  The ticker's figures are page content, not chrome: a network
                  block height and market cap belong on a page about the
                  network, where they can be read against something. The
                  breadcrumb row went with it — its BreadcrumbList JSON-LD is
                  emitted server-side in `server.ts` and is untouched, so the
                  structured-data claim Google reads is unchanged; what is gone
                  is a second navigation affordance duplicating the one in the
                  strip above it.

                  The reference does exactly this: identity at one edge, a small
                  navigation group, utility at the other, 72px, and nothing
                  else. */}
              {afterHeader}
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
                    className="inline-flex flex-1 items-center gap-2 rounded border border-border bg-card px-3 py-2 mg-type-caption-lg text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
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
                  <div className="mg-type-caption text-ink-muted mb-1.5">API base</div>
                  <ApiBaseRow />
                </div>
              </SheetContent>
            </Sheet>

            <main
              id="main-content"
              key={pathname}
              className={classNames(
                // Keep route content visible by default. The previous
                // `mg-route-enter` animation started at opacity: 0; when the
                // embedded preview paused CSS animations, the entire route
                // remained permanently transparent even though it had rendered.
                "flex-1 w-full",
                fullBleedMain
                  ? ""
                  : classNames(
                      "px-4 md:px-10 max-w-shell-max mx-auto pb-10 md:pb-12",
                      flushTop ? "pt-0" : "pt-10 md:pt-12",
                    ),
              )}
            >
              {fullBleedMain ? children : <div className="mg-route-frame">{children}</div>}
            </main>

            <SiteFooter compact={chrome === "landing"} />
            <ApiDrawer />
            <CommandPalette open={paletteOpen} onOpenChange={handlePaletteOpenChange} />
            <ShortcutsPopover showLauncher={chrome === "default"} />
            {chrome === "default" ? <BackToTop /> : null}
          </div>
        </ApiSourceProvider>
      </TooltipProvider>
    </CommandPaletteTriggerContext.Provider>
  );
}

function ApiBaseRow() {
  const { base } = useApiBase();
  return (
    <CopyableCode
      value={`${base}/api/v1`}
      truncate={true}
      className="w-full max-w-full mg-type-caption"
    />
  );
}

function SiteFooter({ compact = false }: { compact?: boolean }) {
  if (compact) return <LandingSiteFooter />;

  return (
    <footer
      className={classNames(
        "mt-20",
        "border-t border-border bg-surface/30 relative overflow-hidden",
      )}
    >
      <div className="max-w-shell-max mx-auto px-4 md:px-10 py-12 grid gap-10 md:grid-cols-5 mg-type-caption text-ink-muted">
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
            <ExternalLink
              bare
              href={GITHUB_HREF}
              ariaLabel="GitHub repository"
              title="Open source on GitHub"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-surface-2 transition-colors"
            >
              <Github className="size-4" />
            </ExternalLink>
            <ExternalLink
              bare
              href={DISCORD_HREF}
              ariaLabel="Discord community"
              title="Join us on Discord"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-surface-2 transition-colors"
            >
              <DiscordIcon className="size-4" />
            </ExternalLink>
            {/* #3351: discoverable RSS/Atom feed for the registry-changes feed
                (/api/v1/feeds/registry, content-negotiated; .rss for a predictable
                browser click). Same guarded external-link pattern as the openapi
                link and the GitHub/Discord icons above. */}
            <ExternalLink
              bare
              href={`${API_BASE}/api/v1/feeds/registry.rss`}
              ariaLabel="Registry changes RSS feed"
              title="Subscribe to the registry-changes feed (RSS)"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-surface-2 transition-colors"
            >
              <Rss className="size-4" />
            </ExternalLink>
          </div>
        </div>
        <FooterCol title="Registry">
          <FooterLink to="/subnets">Subnets</FooterLink>
          <FooterLink to="/chain">Chain</FooterLink>
          <FooterLink to="/apis">APIs</FooterLink>
          <FooterLink to="/validators">Validators</FooterLink>
          <FooterLink to="/accounts">Accounts</FooterLink>
        </FooterCol>
        <FooterCol title="Operations">
          <FooterLink to="/health">Health</FooterLink>
          <FooterLink to="/status">Status</FooterLink>
          <FooterLink to="/contribute">Contribute</FooterLink>
          <FooterLink to="/agents">For agents</FooterLink>
          {/* #11266: the ONLY link to /news anywhere on the site. Its 161
              weekly digests were reachable from /news and from nowhere else,
              and /news itself from nothing at all -- so the whole subtree was
              unreachable by a crawler, sitemap included. */}
          <FooterLink to="/news">Weekly digests</FooterLink>
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
          <FooterLink to="/docs/mcp">MCP</FooterLink>
          <FooterLink to="/docs/rpc">RPC</FooterLink>
        </FooterCol>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-shell-max mx-auto px-4 md:px-10 py-3">
          <RegistryPulseStrip />
        </div>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-shell-max mx-auto px-4 md:px-10 py-4 flex flex-wrap items-center justify-between gap-2 mg-type-data text-ink-muted">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              © {new Date().getFullYear()} Metagraphed · Not an OpenTensor/Bittensor product
            </span>
            {/* #11567: the only link to these anywhere on the site. A privacy
                policy nothing links to is one a reader cannot find and a
                directory reviewer cannot verify. */}
            <span aria-hidden="true">·</span>
            <FooterLink to="/privacy">Privacy</FooterLink>
            <FooterLink to="/terms">Terms</FooterLink>
          </span>
          <EndpointHealthPill />
        </div>
      </div>
    </footer>
  );
}

/**
 * The landing is a concise entry point, not a sitemap. Its route rail already
 * carries the primary exploration decision, so repeating the entire guide tree
 * in the footer made the last third of the page feel like a wall of text—most
 * noticeably on a phone. Keep the complete operational footer on explorer
 * routes, and give the landing a small, deliberate departure point instead.
 */
function LandingSiteFooter() {
  return (
    <footer className="mt-10 border-t border-border bg-surface/30 relative overflow-hidden">
      <div className="max-w-shell-max mx-auto px-4 md:px-10 py-10 md:py-12 grid grid-cols-2 gap-x-8 gap-y-8 md:grid-cols-[minmax(0,1.45fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] mg-type-caption text-ink-muted">
        <div className="col-span-2 md:col-span-1">
          <div className="font-display text-base font-semibold text-ink-strong inline-flex items-baseline gap-1">
            Metagraphed
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full bg-accent translate-y-[-0.15em]"
            />
          </div>
          <p className="mt-2 leading-relaxed max-w-sm">
            A public, verifiable window into Bittensor.
          </p>
          <div className="mt-4 flex items-center gap-1">
            <ExternalLink
              bare
              href={GITHUB_HREF}
              ariaLabel="GitHub repository"
              title="Open source on GitHub"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-surface-2 transition-colors"
            >
              <Github className="size-4" />
            </ExternalLink>
            <ExternalLink
              bare
              href={DISCORD_HREF}
              ariaLabel="Discord community"
              title="Join us on Discord"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-surface-2 transition-colors"
            >
              <DiscordIcon className="size-4" />
            </ExternalLink>
            <ExternalLink
              bare
              href={`${API_BASE}/api/v1/feeds/registry.rss`}
              ariaLabel="Registry changes RSS feed"
              title="Subscribe to the registry-changes feed (RSS)"
              className="inline-flex items-center justify-center rounded size-8 text-ink-muted hover:text-ink-strong hover:bg-surface-2 transition-colors"
            >
              <Rss className="size-4" />
            </ExternalLink>
          </div>
        </div>
        <div className="col-span-2 grid gap-0 md:hidden">
          <LandingFooterDisclosure title="Explore">
            <FooterLink className="inline-flex min-h-11 items-center" to="/subnets">
              Subnets
            </FooterLink>
            <FooterLink className="inline-flex min-h-11 items-center" to="/validators">
              Validators
            </FooterLink>
            <FooterLink className="inline-flex min-h-11 items-center" to="/blocks">
              Blocks
            </FooterLink>
            <FooterLink className="inline-flex min-h-11 items-center" to="/accounts">
              Accounts
            </FooterLink>
          </LandingFooterDisclosure>
          <LandingFooterDisclosure title="Build">
            <FooterLink className="inline-flex min-h-11 items-center" to="/apis">
              Public APIs
            </FooterLink>
            <FooterLink className="inline-flex min-h-11 items-center" to="/docs/mcp">
              MCP
            </FooterLink>
            <FooterLink className="inline-flex min-h-11 items-center" to="/docs">
              Documentation
            </FooterLink>
            <FooterLink className="inline-flex min-h-11 items-center" to="/contribute">
              Contribute
            </FooterLink>
          </LandingFooterDisclosure>
        </div>
        <div className="hidden md:block">
          <FooterCol title="Explore">
            <FooterLink to="/subnets">Subnets</FooterLink>
            <FooterLink to="/validators">Validators</FooterLink>
            <FooterLink to="/blocks">Blocks</FooterLink>
            <FooterLink to="/accounts">Accounts</FooterLink>
          </FooterCol>
        </div>
        <div className="hidden md:block">
          <FooterCol title="Build">
            <FooterLink to="/apis">Public APIs</FooterLink>
            <FooterLink to="/docs/mcp">MCP</FooterLink>
            <FooterLink to="/docs">Documentation</FooterLink>
            <FooterLink to="/contribute">Contribute</FooterLink>
          </FooterCol>
        </div>
      </div>
      <div className="border-t border-border/70">
        <div className="max-w-shell-max mx-auto px-4 md:px-10 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mg-type-data text-ink-muted">
          <span>
            © {new Date().getFullYear()} Metagraphed · Not an OpenTensor/Bittensor product
          </span>
          <RegistryPulseStrip />
        </div>
      </div>
    </footer>
  );
}

function RegistryPulseStrip() {
  const hydrated = useHydrated();
  const freshness = useQuery({ ...freshnessQuery(), retry: 0, enabled: hydrated });
  const build = useQuery({ ...buildQuery(), retry: 0, enabled: hydrated });
  const f = hydrated ? freshness.data?.data : undefined;
  const b = hydrated
    ? (build.data?.data as { version?: string; built_at?: string } | undefined)
    : undefined;
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
      <ExternalLink
        bare
        href={`${API_BASE}/api/v1/openapi.json`}
        className="hover:text-ink-strong transition-colors"
      >
        openapi
      </ExternalLink>
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
    <ExternalLink
      bare
      href={`${base}/api/v1`}
      title={title}
      className="shrink-0 inline-flex items-center gap-2 text-ink-muted hover:text-ink-strong transition-colors"
    >
      <span className={classNames("mg-health-dot", tone)} aria-hidden />
      <span className="hidden sm:inline">{endpoint}</span>
      <span className="text-ink-subtle" aria-hidden>
        ·
      </span>
      <span>{detail}</span>
    </ExternalLink>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mg-type-caption text-ink-strong mb-3">{title}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function LandingFooterDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group border-t border-border last:border-b">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between text-ink-strong [&::-webkit-details-marker]:hidden">
        <span className="mg-type-caption">{title}</span>
        <ChevronRight
          aria-hidden
          className="size-3.5 text-ink-muted transition-transform duration-150 motion-reduce:transition-none group-open:rotate-90"
        />
      </summary>
      <div className="flex flex-col pb-2">{children}</div>
    </details>
  );
}

function FooterLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={classNames("hover:text-ink-strong transition-colors w-fit", className)}
    >
      {children}
    </Link>
  );
}
