/**
 * Centralized PostHog web-analytics + error-tracking + session-replay +
 * feature-flags seam (metagraphed#7760, #7759, #7761, #7762).
 *
 * Single chokepoint for client-side product analytics, exception reporting,
 * session replay, AND feature flags: the app calls `initAnalytics()`/
 * `capturePageview()`/`captureEvent()`/`captureException()`/
 * `isFeatureEnabled()` and never touches `posthog-js` directly elsewhere.
 * Session replay has no separate exported function --
 * it's configured once in `loadPostHog`'s `session_recording` block below
 * and otherwise runs itself (posthog-js's own recorder), except for the
 * exception-linked force-record call inside `captureException`.
 * `captureException` is called from error-reporting.ts's `reportError` -- a
 * second, parallel sink alongside the existing Sentry one there, sharing
 * THIS module's one `posthog-js` instance rather than each maintaining its
 * own. Additive alongside the existing self-hosted Umami tracker
 * (src/server.ts) and Sentry while parity is proven -- see the
 * consolidation epic (metagraphed#7757) for the decommission plan.
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
        // posthog-js's own default for capture_pageleave is
        // 'if_capture_pageview' -- i.e. it piggybacks on capture_pageview's
        // value and is OFF whenever that's `false` (see @posthog/types' own
        // doc comment on the option). This app disables capture_pageview
        // deliberately (manual SPA-aware pageviews below), which would
        // silently take pageleave down with it unless overridden here --
        // pageleave has no such caveat itself (driven by the page-unload
        // event, which fires correctly regardless of client-side routing),
        // so there's no reason to lose it. PostHog's own Installation
        // Health check flagged this gap directly ("Without $pageleave
        // events, bounce rate and session duration might be inaccurate").
        capture_pageleave: true,
        // Native Core Web Vitals capture (LCP/INP/CLS/FCP as posthog-js's
        // own $web_vitals events), independent of and in addition to this
        // app's existing custom 'web_vitals' event (src/server.ts's
        // WEB_VITALS_SNIPPET, which also feeds Umami -- kept as-is, this
        // doesn't replace it). Explicit here rather than relying solely on
        // the dashboard's own "Web vitals autocapture" project setting: that
        // setting only reaches the client via the /array/*/config remote-
        // config fetch, so a client-side default keeps this working even if
        // that fetch is ever degraded, matching this module's established
        // "don't depend on state this code can't guarantee" posture (see
        // the persistence choice below).
        capture_performance: { web_vitals: true },
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
        // profiles for pageview-level web analytics. Session replay
        // (below) inherits the same reset-per-reload behavior, since
        // posthog-js's own session ID also lives in this persistence store.
        persistence: "memory",
        // Session replay (metagraphed#7761). Privacy is the point here, not
        // an afterthought -- see this module's own privacy review in the PR
        // that added this block for the full surface audit (search inputs,
        // wallet/auth flows, one-time-secret reveals).
        session_recording: {
          // All three explicit even though they match posthog-js's own
          // defaults (node_modules/@posthog/types' own @default tags) --
          // documented intent, not an accidental default.
          maskAllInputs: true,
          // rrweb's built-in element markers, not custom selectors: any
          // element with class="ph-mask" gets its TEXT content masked;
          // class="ph-no-capture" is excluded from the DOM recording
          // entirely. The three one-time secret-reveal panels (minted API
          // key, webhook signing secret, watch-alert owner token) use
          // ph-no-capture at their call sites -- see api-keys-manager.tsx,
          // webhook-subscription-manager.tsx, watch-alert-form.tsx.
          maskTextClass: "ph-mask",
          blockClass: "ph-no-capture",
          // 15%, the midpoint of the issue's own suggested 10-20% starting
          // range. Hardcoded rather than left to PostHog's remote/dashboard
          // sampling config (which this value overrides when set, per
          // node_modules/@posthog/types' own doc comment) -- same
          // reasoning as this module's `persistence: "memory"` choice
          // above: a safe default that doesn't depend on separately
          // getting a dashboard setting right before this ships. Tune via
          // a follow-up code change once real volume against the 5k/mo
          // free-tier recording cap is known.
          sampleRate: 0.15,
        },
        // Explicitly off, not left `undefined` (posthog-js's own default,
        // which falls back to remote/dashboard config -- see
        // node_modules/@posthog/types' own doc comment). This app has
        // dev-only `console.error` calls sprinkled through it (see
        // error-reporting.ts, analytics.ts's own load-failure handlers)
        // gated on `import.meta.env?.DEV`, so nothing reaches the console
        // in production today -- but a dashboard setting shouldn't be the
        // only thing standing between that and a future console.log this
        // module's author didn't audit. Console capture is out of scope
        // for what this replay rollout reviewed.
        enable_recording_console_log: false,
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

/** Captures a caught exception via posthog-js's dedicated `captureException`
 * (never the generic `.capture("$exception", ...)`, which PostHog's own docs
 * warn is "unreliable because it does not attach required metadata" --
 * `captureException` builds the stack trace / mechanism / fingerprint
 * PostHog's error tracking needs automatically). `properties` is merged
 * flat into the event (PostHog's own signature), not nested the way
 * Sentry's `{ extra: context }` shape is -- see error-reporting.ts's own
 * call site. Same best-effort, no-op-when-unconfigured contract as every
 * other export here. */
export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  if (!POSTHOG_TOKEN) return;
  void loadPostHog().then((posthog) => {
    // metagraphed#7761's own explicit requirement: "always-on [replay] for
    // sessions with an exception". `startSessionRecording(true)` is
    // posthog-js's documented override to force this session's recording
    // past its sample-rate dice roll (`{ sampling: true, linked_flag: true }`
    // shorthand) -- it does not retroactively invent pre-exception frames,
    // but posthog-js's recorder already buffers a rolling pre-trigger
    // window internally (see `trigger_pending_buffer_interval_millis` in
    // node_modules/@posthog/types), so calling this the moment an exception
    // is captured keeps that lead-up context rather than starting a bare
    // recording from this instant. A no-op if replay is already recording.
    posthog?.startSessionRecording(true);
    posthog?.captureException(error, properties);
  });
}

/** Resolves whether a feature flag is on for the current visitor
 * (metagraphed#7762). Always `false` when unconfigured.
 *
 * A Promise, not a synchronous read: posthog-js resolves flags
 * asynchronously after init (a network round-trip against the /ingest
 * proxy), so a naive synchronous `posthog.isFeatureEnabled()` call made
 * before that finishes returns `undefined` -- a caller checking it
 * immediately on mount would render the OFF state first and only correct
 * itself once flags arrive, a visible flash of the wrong UI. Waiting on
 * `onFeatureFlags` (fires once flags are loaded, and immediately if
 * they're already loaded by the time this is called) means callers only
 * ever see the real, settled value. */
export function isFeatureEnabled(key: string): Promise<boolean> {
  if (!POSTHOG_TOKEN) return Promise.resolve(false);
  return loadPostHog().then((posthog) => {
    if (!posthog) return false;
    return new Promise<boolean>((resolve) => {
      // onFeatureFlags calls back SYNCHRONOUSLY when flags are already
      // loaded (the common case for a second call in the same page life,
      // and possibly even the first if init() itself resolved flags before
      // this runs) -- so `unsubscribe` can still be mid-assignment (not yet
      // in scope) the first time this fires. `resolved`/the post-call check
      // below cover that: an early synchronous fire is caught right after
      // onFeatureFlags() returns, a later async one calls the by-then-
      // assigned `unsubscribe` directly. Either way this settles exactly
      // once and never leaks a live subscription past that.
      let resolved = false;
      // handleFlagsReady's closure must see this binding change from
      // `undefined` to the real unsubscribe function once it's assigned a
      // few lines down (after the closure is defined but before it can
      // possibly run) -- that requires `let`, a `const` would only be
      // legal if the callback never referenced this variable at all.
      // eslint-disable-next-line prefer-const -- false positive, see above.
      let unsubscribe: (() => void) | undefined;
      const handleFlagsReady = () => {
        if (resolved) return;
        resolved = true;
        unsubscribe?.();
        resolve(posthog.isFeatureEnabled(key) === true);
      };
      unsubscribe = posthog.onFeatureFlags(handleFlagsReady);
      if (resolved) unsubscribe();
    });
  });
}
