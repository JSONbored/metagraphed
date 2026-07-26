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
 * `captureException` is called from error-reporting.ts's `reportError` --
 * metagraphed#7766: Sentry (formerly a parallel sink there) is fully removed
 * now that parity was proven; this module's `posthog-js` instance is the
 * only exception-capture sink left. The self-hosted Umami tracker that used
 * to live alongside this in src/server.ts is now fully decommissioned
 * (#7767) -- see the consolidation epic (metagraphed#7757) for the full
 * history.
 *
 * `posthog-js` is loaded via a DYNAMIC import: this keeps it out of the initial client
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
 *
 * Umami-parity audit (#7767's decommission gate -- "capture the same types of
 * data Umami did"), checked against Umami's actual schema/behavior (its
 * `website_event`/`session` tables, `src/app/api/send/route.ts`), not
 * assumed:
 *   - URL, referrer, UTM params (all 5), browser, OS, device type, screen
 *     size, language: posthog-js attaches these automatically on every event
 *     (confirmed against PostHog's own UTM-segmentation and event docs) --
 *     nothing to configure.
 *   - Page title: NOT a posthog-js default (confirmed no `$title`-equivalent
 *     property in its source) -- added explicitly in `capturePageview` below.
 *   - Geo (country/region/city): populated server-side from the real client
 *     IP, which `src/lib/analytics-proxy.ts`'s `forwardToAnalyticsHost`
 *     already forwards via `x-forwarded-for` -- unaffected by any setting in
 *     this file. This is the one property Umami's OWN cookieless design and
 *     PostHog's `cookieless_mode` both still provide -- but only PostHog's
 *     `cookieless_mode` specifically strips it; ordinary (non-cookieless)
 *     capture, which this file uses, keeps it.
 *   - Web vitals: covered independently (capture_performance below); see its
 *     own comment.
 */

import type { PostHog } from "posthog-js";

// Same VITE_*-prefixed / build-time-injected convention as every other
// client-exposed env var this app reads. A PostHog project token IS safe to
// embed client-side ("write-only ingest token" -- see
// src/usage-telemetry.ts's own header comment on the backend's project
// token), but this module doesn't have the real value to hardcode. Set
// VITE_POSTHOG_PROJECT_TOKEN as a Cloudflare Workers Builds dashboard build
// variable to enable capture. Absent everywhere until then, which is a safe
// no-op (see every exported function below).
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

/**
 * Routes session replay must never record (#8270).
 *
 * The PostHog project also carries a dashboard-side URL blocklist, but every
 * rule in it was authored as a glob while declared `matching: "regex"`. Two
 * of them start with a caret immediately followed by a star, which is not a
 * valid regex at all ("Nothing to repeat") and throws a SyntaxError inside
 * the recorder; the other two rely on a trailing slash-star, which in regex
 * means "zero or more slashes" and is matched against a full https:// URL,
 * so it can never fire. All four rules were inert, and `/settings` -- which
 * renders minted API keys and webhook signing secrets -- was being recorded.
 *
 * Element-level protection (`ph-no-capture` on the secret-reveal panels,
 * `maskAllInputs`) always held, so this is defense-in-depth restored rather
 * than a leak closed. Owning the list here follows the same posture as the
 * hardcoded `sampleRate` / `enable_recording_console_log` / `persistence`
 * choices below: don't depend on dashboard state this code can't guarantee.
 *
 * Matched as a path prefix on a segment boundary, deliberately NOT a
 * substring: `/admin-changes` is a PUBLIC route (the AdminUtils config-change
 * feed) that a loose `/admin` substring rule would wrongly suppress.
 */
// #8252: /portfolio was retired into /accounts' "Your wallet" panel. It stays
// listed (the route still exists as a redirect, and a direct nav there should
// not be recorded even for the instant before it fires), but /accounts is
// deliberately NOT added: it's a public lookup page for ANY address, and
// route-level blocking would kill replay across the whole accounts explorer
// to protect one panel. The connected-wallet panel carries element-level
// `ph-no-capture` instead -- the same scoping the secret-reveal panels use.
const REPLAY_BLOCKED_ROUTES = ["/settings", "/portfolio"] as const;

export function isReplayBlockedRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // Normalize a trailing slash so "/settings/" matches "/settings".
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return REPLAY_BLOCKED_ROUTES.some((base) => path === base || path.startsWith(`${base}/`));
}

function currentPathname(): string | null {
  return typeof window === "undefined" ? null : window.location.pathname;
}

// True only while replay is stopped *by this policy*, so resuming can never
// hand a recording to a visitor whose sample-rate dice roll said no -- we only
// restart what we ourselves stopped, and never with the `true` force-override
// captureException uses.
let replayStoppedByPolicy = false;

let posthogInit: Promise<PostHog | null> | null = null;

function loadPostHog(): Promise<PostHog | null> {
  if (posthogInit) return posthogInit;
  posthogInit = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(POSTHOG_TOKEN as string, {
        api_host: POSTHOG_API_HOST,
        ui_host: POSTHOG_UI_HOST,
        defaults: SDK_DEFAULTS_DATE,
        // Landing directly on a blocked route must never start a recording
        // in the first place -- stopping one after init would already have
        // captured the first frames. SPA navigations are handled by
        // syncReplayPolicy() below.
        disable_session_recording: isReplayBlockedRoute(currentPathname()),
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
        // WEB_VITALS_SNIPPET -- kept as-is, this doesn't replace it).
        // Explicit here rather than relying solely on
        // the dashboard's own "Web vitals autocapture" project setting: that
        // setting only reaches the client via the /array/*/config remote-
        // config fetch, so a client-side default keeps this working even if
        // that fetch is ever degraded, matching this module's established
        // "don't depend on state this code can't guarantee" posture (see
        // the persistence choice below).
        capture_performance: { web_vitals: true },
        // metagraphed#7760's own explicit requirement: "respect DNT, no
        // cookies beyond what's justified" -- parity with the self-hosted
        // Umami tracker this originally sat alongside (now decommissioned,
        // #7767), which never set cookies either.
        respect_dnt: true,
        // "localStorage", not posthog-js's own 'localStorage+cookie' default
        // and not "memory" (this module's original choice, changed
        // 2026-07-26): "memory" persists nothing at all, so every reload/new
        // tab/return visit reset identity -- each was counted as a brand-new
        // visitor, which is what actually surfaced as PostHog's unique-visitor
        // count running far hotter than Umami's for the same real traffic.
        // "localStorage" persists a random anonymous ID with NO cookie set --
        // still satisfies metagraphed#7760's "no cookies beyond what's
        // justified" requirement (that requirement was about cookies
        // specifically, not zero client storage of any kind) -- while giving
        // a returning visitor in the same browser actual continuity, matching
        // (and outlasting -- localStorage persists until the visitor clears
        // site data, vs. Umami's own forced monthly salt rotation) what Umami
        // provided.
        //
        // Deliberately NOT `cookieless_mode` (PostHog's own dedicated
        // cookieless-tracking feature, posthog.com/docs/tutorials/
        // cookieless-tracking): considered and rejected on its actual documented
        // behavior, not a guess -- it strips the request IP server-side before
        // any GeoIP enrichment runs, UNCONDITIONALLY, so country/city/region
        // data (a #7767 Umami-parity requirement) would never populate again;
        // it also disables session replay (#7761) entirely, for every visitor,
        // with no override; and its server-side hash rotates on a DAILY salt
        // (vs. Umami's own monthly), so it wouldn't even beat Umami's own
        // long-window visitor-count accuracy. None of that is a config
        // mistake to fix later -- it's how the feature is documented to work.
        persistence: "localStorage",
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
          // node_modules/@posthog/types' own doc comment) -- same "don't
          // depend on state this code can't guarantee" posture as the
          // persistence choice above: a safe default that doesn't depend on
          // separately getting a dashboard setting right before this ships.
          // Tune via a follow-up code change once real volume against the
          // 5k/mo free-tier recording cap is known.
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
 * event reflects the route just navigated to, not a stale closure value.
 *
 * `page_title` is added explicitly (Umami-parity, #7767's decommission gate
 * requires PostHog capture the same data types Umami did): posthog-js has no
 * built-in `$title`-style property the way it auto-attaches UTM/referrer/
 * browser/os/device -- confirmed against posthog-js's own source, there is no
 * such default. `document.title` is read at call time, not passed down from
 * the caller, so it's always the value the route's own `head()` meta just
 * committed -- `onResolved` (this function's only SPA call site, in
 * routes/-root-views.tsx) fires after the new route's head has rendered. */
export function capturePageview(url?: string): void {
  if (!POSTHOG_TOKEN) return;
  void loadPostHog().then((posthog) => {
    posthog?.capture("$pageview", {
      ...(url ? { $current_url: url } : undefined),
      ...(typeof document !== "undefined" ? { page_title: document.title } : undefined),
    });
  });
}

/** Starts or stops session replay to match the route now being shown (#8270).
 *
 * Call on every SPA navigation, alongside `capturePageview`. A no-op when
 * unconfigured. Only ever resumes a recording this policy itself stopped, and
 * never with `startSessionRecording`'s force-override, so a visitor excluded
 * by `sampleRate` stays excluded. */
export function syncReplayPolicy(pathname?: string): void {
  if (!POSTHOG_TOKEN) return;
  const blocked = isReplayBlockedRoute(pathname ?? currentPathname());
  void loadPostHog().then((posthog) => {
    if (!posthog) return;
    if (blocked) {
      posthog.stopSessionRecording();
      replayStoppedByPolicy = true;
      return;
    }
    if (replayStoppedByPolicy) {
      replayStoppedByPolicy = false;
      posthog.startSessionRecording();
    }
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
