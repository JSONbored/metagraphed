import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Home,
  RefreshCw,
  Search,
  ServerCrash,
} from "lucide-react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { initAnalytics, capturePageview } from "../lib/analytics";
import { Toaster } from "@jsonbored/ui-kit";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import { DENSITY_BOOTSTRAP_SCRIPT } from "@/lib/density";
import { HEALTH_PALETTE_BOOTSTRAP_SCRIPT } from "@/lib/health-palette";
import { GlobalErrorBoundary } from "@/components/metagraphed/global-error-boundary";
import {
  mountBlankScreenWatchdog,
  PRE_HYDRATION_RECOVERY_SCRIPT,
} from "@/lib/blank-screen-watchdog";

function NotFoundComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const attempted =
    typeof window !== "undefined" ? window.location.href : `https://metagraph.sh${pathname}`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(attempted);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;
    const n = Number(raw.replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n <= 1024) {
      router.navigate({ to: "/subnets/$netuid", params: { netuid: n } });
    } else {
      router.navigate({ to: "/subnets", search: { q: raw } as never });
    }
  };

  const examples: Array<{ href: string; label: string; note: string }> = [
    { href: "/subnets/0", label: "/subnets/0", note: "Root · Subtensor RPC/WSS" },
    { href: "/subnets/7", label: "/subnets/7", note: "Allways · adapter-backed" },
    { href: "/subnets/74", label: "/subnets/74", note: "Gittensor · adapter-backed" },
    { href: "/providers", label: "/providers", note: "Provider directory" },
    { href: "/endpoints", label: "/endpoints", note: "All public endpoints" },
    { href: "/schemas", label: "/schemas", note: "OpenAPI & schema drift" },
  ];

  return (
    <div className="min-h-dvh bg-paper px-4 py-10 text-ink-strong">
      <div className="mx-auto max-w-5xl">
        <main aria-labelledby="nf-title">
          <div className="mg-label">Metagraphed / missing route · 404</div>
          <h1
            id="nf-title"
            className="mt-3 font-display text-4xl font-semibold leading-tight text-ink-strong md:text-5xl"
          >
            No registry resource at this URL.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted md:text-base">
            The path you followed isn&rsquo;t a curated registry view. Search a subnet by netuid,
            copy the attempted URL for a bug report, or jump into one of the primary indexes below.
          </p>

          {/* Attempted URL + copy */}
          <div className="mt-6 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2 mg-label">
              <AlertTriangle className="size-3.5 text-health-warn" /> Attempted URL
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border border-border bg-paper px-2 py-1.5 font-mono text-[12px] text-ink">
                {attempted}
              </code>
              <button
                type="button"
                onClick={onCopy}
                aria-label="Copy attempted URL"
                aria-live="polite"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-paper px-3 text-xs text-ink-muted transition-colors hover:border-accent/60 hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? (
                  <Check className="size-3.5 text-health-ok" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy URL"}
              </button>
            </div>
          </div>

          {/* Search */}
          <form onSubmit={onSubmit} className="mt-4" role="search" aria-label="Find a subnet">
            <label htmlFor="nf-search" className="mg-label">
              Jump to subnet
            </label>
            <div className="mt-1 flex flex-wrap items-stretch gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
                />
                <input
                  id="nf-search"
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 7, 74, or a keyword"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-h-10 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm text-ink-strong placeholder:text-ink-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="submit"
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-accent/60 bg-primary-soft px-4 text-sm font-medium text-ink-strong hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Go <ArrowRight className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              Enter a netuid (0–1024) to deep-link to its profile, or any keyword to search the
              registry.
            </p>
          </form>

          {/* Example deep links */}
          <section aria-labelledby="nf-examples" className="mt-6">
            <h2 id="nf-examples" className="mg-label">
              Example deep links
            </h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {examples.map((ex) => (
                <li key={ex.href}>
                  <Link
                    to={ex.href}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[12px] text-ink-strong">
                        {ex.label}
                      </span>
                      <span className="block truncate text-[11px] text-ink-muted">{ex.note}</span>
                    </span>
                    <ArrowRight aria-hidden className="size-3.5 text-ink-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <nav aria-label="Primary registry indexes" className="mt-6 flex flex-wrap gap-2">
            <Link
              to="/"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-ink-strong hover:border-accent/60"
            >
              <Home className="size-4" /> Overview
            </Link>
            <Link
              to="/subnets"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-ink-muted hover:border-accent/60 hover:text-ink-strong"
            >
              Subnets
            </Link>
            <Link
              to="/providers"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-ink-muted hover:border-accent/60 hover:text-ink-strong"
            >
              Providers
            </Link>
            <Link
              to="/health"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-ink-muted hover:border-accent/60 hover:text-ink-strong"
            >
              Health
            </Link>
          </nav>
        </main>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="min-h-screen bg-paper px-4 py-8 text-ink-strong">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center">
        <main className="w-full rounded-xl border border-health-down/30 bg-card p-5 md:p-8">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-health-down">
            <ServerCrash className="size-4" /> Route error
            <span className="rounded border border-border bg-paper px-1.5 py-0.5 text-ink-muted">
              {pathname}
            </span>
          </div>
          <h1 className="mt-4 font-display text-3xl font-semibold leading-tight text-ink-strong md:text-5xl">
            This page hit a registry UI error.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted md:text-base">
            Retry reloads only the current route data. If it keeps failing, the links below let you
            continue browsing the public registry while the error report is captured.
          </p>
          <div className="mt-4 rounded-md border border-border bg-paper p-3 text-xs text-ink-muted">
            <div className="flex items-center gap-2 mg-label">
              <AlertTriangle className="size-3.5 text-health-warn" /> Diagnostic
            </div>
            <code className="mt-2 block break-words font-mono text-[11px]">{error.message}</code>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              onClick={() => {
                router.invalidate();
                reset();
              }}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-accent/60 bg-primary-soft px-4 text-sm font-medium text-ink-strong transition-colors hover:border-accent"
            >
              <RefreshCw className="size-4" /> Retry route
            </button>
            <Link
              to="/subnets"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-ink-muted hover:border-accent/60 hover:text-ink-strong"
            >
              Browse subnets
            </Link>
            <Link
              to="/"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-ink-muted hover:border-accent/60 hover:text-ink-strong"
            >
              <Home className="size-4" /> Overview
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => {
    const title = "Metagraphed — the Bittensor subnet integration registry";
    const description =
      "What every Bittensor subnet exposes (APIs, docs, schemas), whether it's healthy, and how to call it — machine-readable for AI agents and developers.";
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title },
        { name: "description", content: description },
        { name: "author", content: "metagraphed" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Metagraphed" },
        // og:url is injected per-route (canonical URL) in src/server.ts so deep
        // pages unfurl to themselves, not the homepage.
        { name: "twitter:card", content: "summary_large_image" },
        // Brand ink (mint-M favicon set). og:image stays the per-route /og card
        // injected in src/server.ts. theme-color is read directly by browser
        // chrome outside the CSS cascade, so it can't reference a custom
        // property -- a literal hex is unavoidable here, same as
        // health-tokens.ts/og-image.ts.
        // eslint-disable-next-line no-restricted-syntax -- see comment above
        { name: "theme-color", content: "#0B1F1A" },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        // Mint-M brand favicons (assets in public/, from the brand kit).
        { rel: "icon", href: "/favicon.ico", sizes: "any" },
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon-180x180.png" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Pre-hydration: theme, density, and health palette set before
            first paint to avoid flash / layout shift. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: DENSITY_BOOTSTRAP_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: HEALTH_PALETTE_BOOTSTRAP_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_RECOVERY_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // metagraphed#7760: PostHog web analytics. Separate effect from the
  // hydration-watchdog one below -- unrelated concerns, and this one only
  // needs `router` (stable for the app's lifetime), not `queryClient`.
  // capture_pageview is disabled in analytics.ts's own posthog.init() call
  // (an SPA's `defaults` auto-pageview only covers the very first load), so
  // every pageview -- including this initial one -- is captured explicitly
  // here: once on mount, then once per navigation whose URL actually changed
  // (onResolved also fires for e.g. a route re-resolving after
  // `router.invalidate()`, which isn't a real new pageview).
  useEffect(() => {
    initAnalytics();
    capturePageview(window.location.href);
    return router.subscribe("onResolved", (event) => {
      if (event.hrefChanged) capturePageview(window.location.href);
    });
  }, [router]);

  useEffect(() => {
    // Handshake with the dependency-free <head> recovery script. This must be
    // the first effect work so a successful mount cancels its startup timeout.
    window.__MG_HYDRATED__ = true;
    const onError = (e: ErrorEvent) => {
      const err = e.error instanceof Error ? e.error : new Error(String(e.message ?? e));
      console.error("[hydration-capture] window error:", err, err.stack);
      reportLovableError(err, { boundary: "hydration_window_error" });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      console.error("[hydration-capture] unhandled rejection:", err, err.stack);
      reportLovableError(err, { boundary: "hydration_unhandled_rejection" });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    const cleanupWatchdog = mountBlankScreenWatchdog({
      onReport: (m) => reportLovableError(new Error("blank_screen_detected"), { metrics: m }),
    });
    return () => {
      window.__MG_HYDRATED__ = false;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      cleanupWatchdog();
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <GlobalErrorBoundary>
        <RouteTransitionBar />
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
        <Toaster />
      </GlobalErrorBoundary>
    </QueryClientProvider>
  );
}

/**
 * Thin top-edge progress strip that animates while the router is loading the
 * next route (data fetches, async components). Auto-hides between transitions.
 * Pure CSS animation — does not re-render the rest of the tree.
 */
function RouteTransitionBar() {
  const isLoading = useRouterState({ select: (s) => s.isLoading || s.isTransitioning });
  return (
    <div
      aria-hidden
      className="fixed inset-x-0 top-0 z-[60] h-0.5 pointer-events-none overflow-hidden"
      style={{ opacity: isLoading ? 1 : 0, transition: "opacity 200ms ease-out" }}
    >
      {isLoading ? (
        <div className="h-full w-1/3 bg-accent animate-[mg-loader_1.1s_ease-in-out_infinite]" />
      ) : null}
    </div>
  );
}
