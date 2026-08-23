import {
  Outlet,
  Link,
  useRouter,
  useRouterState,
  useRouteContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FilterField,
  FilterInput,
  Raw,
  Toaster,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { initAnalytics, capturePageview, syncReplayPolicy } from "../lib/analytics";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import { HEALTH_PALETTE_BOOTSTRAP_SCRIPT } from "@/lib/health-palette";
import { GlobalErrorBoundary } from "@/components/metagraphed/global-error-boundary";
import { OfflineBanner } from "@/components/metagraphed/offline-banner";
import { useServiceWorker } from "@/hooks/use-service-worker";
import {
  mountBlankScreenWatchdog,
  PRE_HYDRATION_RECOVERY_SCRIPT,
} from "@/lib/blank-screen-watchdog";

/**
 * The five destinations a reader who missed is most likely to have wanted.
 * Paths, not prose: the URL is the thing they typed wrong.
 */
const NOT_FOUND_DESTINATIONS: readonly { path: string; holds: string }[] = [
  { path: "/subnets", holds: "Every subnet, ranked by emission." },
  { path: "/validators", holds: "Every validator, ranked by stake." },
  { path: "/chain", holds: "Blocks, extrinsics and events as they land." },
  { path: "/apis/providers", holds: "Who operates the endpoints." },
  { path: "/apis/schemas", holds: "OpenAPI coverage and schema drift." },
  { path: "/health", holds: "What is up, and what is not." },
];

const NOT_FOUND_COLUMNS: DataTableColumn<(typeof NOT_FOUND_DESTINATIONS)[number]>[] = [
  { key: "path", label: "Path", value: (d) => d.path },
  { key: "holds", label: "What is there", value: (d) => d.holds },
];

/**
 * 404 (#11627) — the site's shell, an EntityHero, one table.
 *
 * It used to be a standalone page with its own 40px display heading, a
 * bordered "Attempted URL" panel, a search field with an absolutely-positioned
 * icon, a six-card grid of example links, and a fourth row of four pill
 * buttons — five separate visual vocabularies for "you are lost". It renders
 * inside `AppShell` now, so the header the reader needs is simply there, and
 * everything below it is the hero, the jump box, and a table of where to go.
 */
export function NotFoundComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const [query, setQuery] = useState("");
  const attempted =
    typeof window !== "undefined" ? window.location.href : `https://metagraph.sh${pathname}`;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;
    const n = Number(raw.replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n <= 1024) {
      router.navigate({ to: "/subnets/$netuid", params: { netuid: n } });
    } else {
      router.navigate({ to: "/subnets", search: { q: raw } });
    }
  };

  return (
    <AppShell>
      <EntityHero
        name="Nothing at this URL"
        sentence={
          <FactSentence>
            The path you followed is not a registry view. <Fact>404</Fact>
            <Fact>{pathname}</Fact>
          </FactSentence>
        }
      />

      <AnalyticsSection
        id="jump"
        name="Jump to a subnet"
        question="A netuid deep-links to its profile; anything else searches the registry."
        visual={
          <form onSubmit={onSubmit} role="search" aria-label="Find a subnet">
            <FilterField label="Subnet" htmlFor="nf-search">
              <FilterInput
                id="nf-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. 7, 74, or a keyword"
              />
            </FilterField>
          </form>
        }
        footnote="netuid 0–1024, or any keyword"
      />

      <AnalyticsSection
        id="destinations"
        name="Where to go instead"
        question="The six indexes the rest of the site hangs off."
        visual={
          <DataTable
            caption="Registry indexes"
            captionHidden
            rows={NOT_FOUND_DESTINATIONS}
            columns={NOT_FOUND_COLUMNS}
            rowKey={(d) => d.path}
            source="not-found"
            paginate={false}
            rowHref={(d) => d.path}
            link={RouterLink}
          />
        }
      />

      {/* The attempted URL, copyable, for a bug report -- the one thing the
          reader might need to send someone else. */}
      <Raw rows={[{ label: "attempted", value: attempted }]} />
    </AppShell>
  );
}

/**
 * The route error boundary (#11627).
 *
 * Deliberately NOT inside `AppShell`: an error thrown by the shell itself
 * would make that a loop. It carries its own minimal frame, but the type,
 * the rule and the diagnostic all come from the same tokens and the same
 * `Raw` block every other page uses, so it reads as this site rather than as
 * a browser error page.
 */
export function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="min-h-dvh bg-canvas px-4 py-10 text-ink">
      <main className="mx-auto flex max-w-5xl flex-col gap-4">
        <EntityHero
          name="This route hit an error"
          sentence={
            <FactSentence>
              Retry reloads only the current route&rsquo;s data; the report has already been
              captured. <Fact>{pathname}</Fact>
            </FactSentence>
          }
          action={
            <button
              type="button"
              onClick={() => {
                router.invalidate();
                reset();
              }}
              className="rounded border border-border bg-card px-3 py-1.5 text-13 text-ink-strong hover:border-ink/30"
            >
              Retry route
            </button>
          }
        />
        <Raw
          rows={[
            { label: "path", value: pathname },
            { label: "error", value: error.message },
          ]}
        />
        <nav aria-label="Elsewhere" className="flex flex-wrap gap-3">
          <Link to="/" className="text-13 text-ink-muted hover:text-ink-strong">
            Overview
          </Link>
          <Link to="/subnets" className="text-13 text-ink-muted hover:text-ink-strong">
            Subnets
          </Link>
          <Link to="/health" className="text-13 text-ink-muted hover:text-ink-strong">
            Health
          </Link>
        </nav>
      </main>
    </div>
  );
}

export function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Pre-hydration: theme, density, and health palette set before
            first paint to avoid flash / layout shift. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
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

export function RootComponent() {
  const { queryClient } = useRouteContext({ from: "__root__" });
  const router = useRouter();

  // #8384: registers public/sw.js and drives the consent-based update toast.
  // A no-op (and safe to call) in any environment without service-worker
  // support -- see the hook's own early return.
  useServiceWorker();

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
    // Session replay must follow the route, not just the initial load
    // (#8270) -- a client-side navigation into /settings would otherwise keep
    // recording a page that renders API keys and signing secrets.
    syncReplayPolicy(window.location.pathname);
    return router.subscribe("onResolved", (event) => {
      if (!event.hrefChanged) return;
      capturePageview(window.location.href);
      syncReplayPolicy(window.location.pathname);
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
        <OfflineBanner />
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
  // RouterState carried `isTransitioning` in router-core 1.171.15 and no longer
  // does in 1.171.21: the router-level transition store is gone (what survives
  // is Link's own local one), and `isLoading` is now derived as
  // `status === "pending"` -- the whole router-busy signal the two flags
  // together used to approximate.
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  return (
    <div
      aria-hidden
      className="mg-progress-bar fixed inset-x-0 top-0 z-[var(--mg-z-progress)] h-0.5 pointer-events-none overflow-hidden"
      // A CSS custom property carrying data, not a style: the bar's opacity
      // is state, and `--mg-motion` owns the duration.
      style={{ "--mg-progress-opacity": isLoading ? 1 : 0 } as CSSProperties}
    >
      {isLoading ? <div className="mg-progress-track" /> : null}
    </div>
  );
}
