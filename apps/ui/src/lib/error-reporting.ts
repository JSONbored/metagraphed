import { reportLovableError } from "./lovable-error-reporting";
import { captureException as capturePostHogException } from "./analytics";

/**
 * Centralized error-reporting seam for React error boundaries.
 *
 * This is the single chokepoint a real telemetry backend is wired into:
 * boundaries call `reportError` and never touch `console.error` or a vendor SDK
 * directly.
 *
 * Sinks, in order, all best-effort:
 *  1. PostHog (metagraphed#7759) — enabled whenever
 *     `VITE_POSTHOG_PROJECT_TOKEN` is configured (see analytics.ts). Reuses
 *     analytics.ts's own `captureException`, which shares the SAME
 *     lazily-loaded `posthog-js` instance web analytics already manages --
 *     this file never touches `posthog-js` directly or triggers a second
 *     init. Release correlation is inferred at read time from the chunk IDs
 *     `@posthog/rollup-plugin` injects into the built JS at upload time
 *     (vite.config.ts), not something passed at capture time.
 *  2. Lovable capture channel — best-effort, no-op outside the Lovable editor.
 *  3. `console.error` in dev so the boundary + context are always greppable
 *     locally.
 *
 * metagraphed#7766: Sentry sink fully removed (was sink 1, `@sentry/browser`
 * dynamically imported when a DSN was configured -- Sentry fully
 * decommissioned once PostHog error-tracking parity was proven). This seam
 * itself stays -- boundaries never called Sentry/PostHog directly, so
 * nothing upstream of this file changes.
 */

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  // 1. PostHog — a no-op when VITE_POSTHOG_PROJECT_TOKEN is unconfigured.
  capturePostHogException(error, context);

  // 2. Forward to the existing Lovable capture channel (no-op when unavailable / SSR).
  reportLovableError(error, context);

  // 3. Always surface locally in dev for greppable boundary + context.
  if (import.meta.env?.DEV) {
    console.error("[reportError]", context.boundary ?? "boundary", error, context);
  }
}
