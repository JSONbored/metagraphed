import { reportLovableError } from "./lovable-error-reporting";

/**
 * Centralized error-reporting seam for React error boundaries.
 *
 * This is the single chokepoint a real telemetry backend is wired into:
 * boundaries call `reportError` and never touch `console.error` or a vendor SDK
 * directly.
 *
 * Sinks, in order, all best-effort:
 *  1. Sentry — enabled whenever a DSN is available. `@sentry/browser` is
 *     loaded via a DYNAMIC import so it costs zero bundle bytes when the DSN
 *     is unset (the import is tree-shaken / never reached). Tagged with a
 *     `release` (Cloudflare Workers Builds' own commit SHA, bridged in at
 *     build time via vite.config.ts's `define` -- see vite.config.ts's own
 *     comment) and `environment` (production/development from Vite's own
 *     `import.meta.env.PROD`), so a regression can be traced to the deploy
 *     that introduced it. Source maps for this release are uploaded by
 *     `@sentry/vite-plugin` (also wired in vite.config.ts), gated on
 *     `SENTRY_AUTH_TOKEN` being set -- absent everywhere except a production
 *     Cloudflare Workers Build that has it configured (a real Sentry API
 *     token, unlike the DSN below, so it can't have a code-level default
 *     the same way -- sourcemap upload stays opt-in until a maintainer sets
 *     it as a Workers Builds dashboard build variable).
 *  2. Lovable capture channel — best-effort, no-op outside the Lovable editor.
 *  3. `console.error` in dev so the boundary + context are always greppable
 *     locally.
 *
 * DSN resolution mirrors DEFAULT_API_BASE's own convention
 * (src/lib/metagraphed/config.ts): `VITE_SENTRY_DSN` overrides when a build
 * sets it (e.g. a future Workers Builds dashboard config), otherwise falls
 * back to the real "metagraphed" project DSN -- safe to hardcode since a
 * Sentry DSN is designed to be public/embeddable in client JS (see
 * scripts/observability.ts's own comment on the same point). The fallback
 * only applies to production builds (`import.meta.env.PROD`); `vite dev`
 * stays silent by default so local debugging doesn't mix into production
 * error tracking, matching this module's pre-existing "no eager Sentry load
 * unless configured" intent.
 */

const SENTRY_PROJECT_DSN =
  "https://998bd096e2c9f1d81781ed3a88fed0b9@o4511631313666048.ingest.us.sentry.io/4511749777588224";
const SENTRY_DSN =
  (import.meta.env?.VITE_SENTRY_DSN as string | undefined) ||
  (import.meta.env?.PROD ? SENTRY_PROJECT_DSN : undefined);
// Bridged in at build time from Cloudflare Workers Builds' own
// WORKERS_CI_COMMIT_SHA (see vite.config.ts's `define` block) -- "" (not
// undefined) whenever that var wasn't set, since Vite's `define` replaces
// this with a literal string constant, never an actual `undefined`.
const SENTRY_RELEASE = (import.meta.env?.VITE_SENTRY_RELEASE as string | undefined) || undefined;

type SentryModule = typeof import("@sentry/browser");

let sentryInit: Promise<SentryModule | null> | null = null;

function loadSentry(): Promise<SentryModule | null> {
  if (sentryInit) return sentryInit;
  sentryInit = import("@sentry/browser")
    .then((Sentry) => {
      Sentry.init({
        dsn: SENTRY_DSN,
        release: SENTRY_RELEASE,
        environment: import.meta.env?.PROD ? "production" : "development",
      });
      return Sentry;
    })
    .catch((err) => {
      // Never let telemetry wiring crash the host app.
      if (import.meta.env?.DEV) console.error("[reportError] sentry load failed", err);
      return null;
    });
  return sentryInit;
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  // 1. Sentry — gated on a build-time DSN, loaded lazily so it's zero-cost when unset.
  if (SENTRY_DSN) {
    void loadSentry().then((Sentry) => {
      if (Sentry) Sentry.captureException(error, { extra: context });
    });
  }

  // 2. Forward to the existing Lovable capture channel (no-op when unavailable / SSR).
  reportLovableError(error, context);

  // 3. Always surface locally in dev for greppable boundary + context.
  if (import.meta.env?.DEV) {
    console.error("[reportError]", context.boundary ?? "boundary", error, context);
  }
}
