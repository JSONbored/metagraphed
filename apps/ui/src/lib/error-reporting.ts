import { reportLovableError } from "./lovable-error-reporting";

/**
 * Centralized error-reporting seam for React error boundaries.
 *
 * This is the single chokepoint a real telemetry backend is wired into:
 * boundaries call `reportError` and never touch `console.error` or a vendor SDK
 * directly.
 *
 * Sinks, in order, all best-effort:
 *  1. Sentry — only when a build-time `VITE_SENTRY_DSN` is set. `@sentry/browser`
 *     is loaded via a DYNAMIC import so it costs zero bundle bytes when the DSN
 *     is unset (the import is tree-shaken / never reached).
 *  2. Lovable capture channel — best-effort, no-op outside the Lovable editor.
 *  3. `console.error` in dev so the boundary + context are always greppable
 *     locally.
 *
 * No backend change is required: when `VITE_SENTRY_DSN` is unset this degrades
 * to the existing best-effort behaviour with no eager Sentry load.
 */

const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN as string | undefined;

type SentryModule = typeof import("@sentry/browser");

let sentryInit: Promise<SentryModule | null> | null = null;

function loadSentry(): Promise<SentryModule | null> {
  if (sentryInit) return sentryInit;
  sentryInit = import("@sentry/browser")
    .then((Sentry) => {
      Sentry.init({ dsn: SENTRY_DSN });
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
