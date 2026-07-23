/**
 * Centralized PostHog web-analytics seam (metagraphed#7760).
 *
 * Single chokepoint for client-side product analytics: the app calls
 * `initAnalytics()`/`capturePageview()`/`captureEvent()` and never touches
 * `posthog-js` directly elsewhere. Additive alongside the existing
 * self-hosted Umami tracker (src/server.ts) while parity is proven -- see
 * the consolidation epic (metagraphed#7757) for the decommission plan.
 *
 * `posthog-js` is loaded via a DYNAMIC import, mirroring error-reporting.ts's
 * exact Sentry-loading pattern: this keeps it out of the initial client
 * bundle the CI bundle-size-budget gate measures (that check only counts the
 * entry's STATIC-import closure -- dynamic `import()` chunks are explicitly
 * excluded, confirmed against .github/workflows/validate.yml's own "Bundle
 * size budget" step), and -- just as importantly -- means self-hosters /
 * local dev / PR CI with no token configured pay zero bytes for a library
 * they never use, the same "zero cost when unconfigured" guarantee every
 * other telemetry integration in this codebase already provides.
 *
 * Proxied first-party through this origin (POSTHOG_API_HOST below, served by
 * src/server.ts's handleAnalyticsProxy) -- the same ad-blocker-resilience +
 * no-extra-DNS-handshake rationale the existing Umami proxy already
 * documents, and PostHog's own Cloudflare-proxy guide's stated purpose
 * ("hides PostHog's domains from ad blockers").
 *
 * Autocapture/pageview capture via the `defaults` option is intentionally
 * NOT relied on for pageviews (`capture_pageview: false`): this is a
 * client-side-routed SPA, so the one pageview `defaults` would auto-fire on
 * init only covers the very first load. Every navigation (including the
 * first) is captured explicitly instead, via TanStack Router's `onResolved`
 * event (wired in routes/__root.tsx) -- one predictable code path rather
 * than mixing automatic-for-the-first-load with manual-for-the-rest.
 * Autocapture of clicks/inputs is left to `defaults`' own recommended
 * behavior.
 */

import type { PostHog } from "posthog-js";

// Same VITE_*-prefixed / build-time-injected convention error-reporting.ts's
// VITE_SENTRY_DSN already uses. Unlike the Sentry DSN, there's no code-level
// fallback here: a PostHog project token IS safe to embed client-side (same
// "write-only ingest token" reasoning as the Sentry DSN -- see
// src/usage-telemetry.ts's own header comment on the backend's project
// token), but this module doesn't have the real value to hardcode. Set
// VITE_POSTHOG_PROJECT_TOKEN as a Cloudflare Workers Builds dashboard build
// variable to enable capture -- the same opt-in mechanism SENTRY_AUTH_TOKEN
// already uses for source-map upload. Absent everywhere until then, which is
// a safe no-op (see every exported function below).
const POSTHOG_TOKEN =
  (import.meta.env?.VITE_POSTHOG_PROJECT_TOKEN as string | undefined) || undefined;

// First-party proxy path (src/server.ts), never PostHog's own domain
// directly -- see this module's own header comment. Overridable for local
// testing against a real PostHog host directly.
const POSTHOG_API_HOST = (import.meta.env?.VITE_POSTHOG_HOST as string | undefined) || "/ingest";

// Only used for the in-app toolbar's deep-link (an optional, admin-only
// feature) -- never a tracking endpoint, so pointing this at PostHog's real
// domain (not the proxy) is correct and matches PostHog's own proxy guide.
// US cloud, matching src/usage-telemetry.ts's own DEFAULT_POSTHOG_HOST.
const POSTHOG_UI_HOST =
  (import.meta.env?.VITE_POSTHOG_UI_HOST as string | undefined) || "https://us.posthog.com";

// Tracks PostHog's own "SDK defaults" versioning (posthog.com/docs/libraries/js#sdk-defaults) --
// bump deliberately when adopting a newer default set, not on every release.
// A typo here can't silently fall back to posthog-js's own default handling:
// posthog-js's `defaults` option is typed as a closed string-literal union
// (`ConfigDefaults` in @posthog/types, not a bare `string`), and this `const`
// (no explicit type annotation) infers that literal type -- an invalid date
// fails `npm run typecheck` outright rather than degrading quietly at runtime.
const SDK_DEFAULTS_DATE = "2026-05-30";

let posthogInit: Promise<PostHog | null> | null = null;

function loadPostHog(): Promise<PostHog | null> {
  if (posthogInit) return posthogInit;
  posthogInit = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(POSTHOG_TOKEN as string, {
        api_host: POSTHOG_API_HOST,
        ui_host: POSTHOG_UI_HOST,
        defaults: SDK_DEFAULTS_DATE,
        capture_pageview: false,
        // metagraphed#7760's own explicit requirement: "respect DNT, no
        // cookies beyond what's justified" -- parity with the self-hosted
        // Umami tracker this sits alongside, which never sets cookies either.
        respect_dnt: true,
        // "memory", not posthog-js's own 'localStorage+cookie' default: no
        // cookie or localStorage write at all, matching Umami's cookieless
        // posture directly. Deliberately NOT `cookieless_mode` (posthog-js's
        // other no-cookie option) -- that one requires ALSO flipping a
        // matching toggle in this project's PostHog dashboard settings or
        // every event is silently dropped server-side (confirmed via
        // node_modules/@posthog/types' own doc comment on the option); a
        // config value here can't guarantee that dashboard-side state, so it
        // would be a silent-data-loss trap the day someone forgets. The
        // tradeoff: identity resets every reload/tab close (each is a new
        // anonymous visitor) rather than persisting client-side -- accepted
        // for a public dashboard that doesn't need cross-session user
        // profiles for pageview-level web analytics.
        persistence: "memory",
      });
      return posthog;
    })
    .catch((err) => {
      // Never let telemetry wiring crash the host app.
      if (import.meta.env?.DEV) console.error("[analytics] posthog load failed", err);
      return null;
    });
  return posthogInit;
}

/** Starts loading PostHog. Safe to call multiple times (idempotent); a no-op
 * when unconfigured. Call once, early (routes/__root.tsx's mount effect). */
export function initAnalytics(): void {
  if (!POSTHOG_TOKEN) return;
  void loadPostHog();
}

/** Captures one `$pageview`. `url` defaults to posthog-js's own current-URL
 * read when omitted -- pass it explicitly on an SPA route change so the
 * event reflects the route just navigated to, not a stale closure value. */
export function capturePageview(url?: string): void {
  if (!POSTHOG_TOKEN) return;
  void loadPostHog().then((posthog) => {
    posthog?.capture("$pageview", url ? { $current_url: url } : undefined);
  });
}

/** Captures a custom event. Best-effort, no-op when unconfigured or before
 * PostHog has finished loading (the call is dropped, never queued/retried --
 * matching this module's overall "telemetry must never affect the app"
 * posture). */
export function captureEvent(name: string, properties?: Record<string, unknown>): void {
  if (!POSTHOG_TOKEN) return;
  void loadPostHog().then((posthog) => posthog?.capture(name, properties));
}
