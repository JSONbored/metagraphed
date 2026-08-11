import { reportLovableError } from "./lovable-error-reporting";
import { captureException as capturePostHogException } from "./analytics";
import { ApiError } from "./metagraphed/client";

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

/**
 * Is this the API telling us a route does not exist on THIS network?
 *
 * `ApiError.network` is set on exactly the network-partition 404s
 * (`workers/api.ts`'s `handleNetworkScopedRequest` — the mainnet-only
 * blocklist, `local`'s no-data 404, and its unmatched-route catch-all). Its
 * own doc comment says it exists so callers can tell "unavailable on this
 * network by design" from an ordinary 404. Nothing read it, so those refusals
 * were reported as exceptions.
 *
 * They are not faults. 105 of 188 routes are mainnet-only, so a testnet page
 * that touches one gets a correct, documented 404 — and three of them were
 * landing in Error Tracking from `testnet.metagraph.sh`:
 *
 *   /api/v1/health          → testnet.metagraph.sh/subnets
 *   /api/v1/domains         → testnet.metagraph.sh/subnets
 *   /api/v1/agent-resources → testnet.metagraph.sh/agents
 *
 * Capturing them costs signal (a correct refusal sitting beside a real
 * defect), quota (`$exception` has its own 100K/cycle allowance, already blown
 * once on this project), and the storm guard's headroom.
 *
 * Narrow on purpose: only a 404 that CARRIES a network, so an ordinary 404 —
 * a genuinely missing subnet, a typo'd path on mainnet — still reports. The
 * UI not requesting these at all on testnet is the better fix and is tracked
 * separately; this stops the noise at the seam that knows the condition was
 * expected.
 */
function isNetworkPartitionRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    typeof error.network === "string" &&
    error.network.length > 0
  );
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  // An expected refusal is still worth seeing in dev (step 3 below), but it is
  // not an exception and must not be reported as one.
  if (isNetworkPartitionRefusal(error)) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[reportError] network-partition refusal, not captured:",
        (error as ApiError).url,
      );
    }
    return;
  }

  // 1. PostHog — a no-op when VITE_POSTHOG_PROJECT_TOKEN is unconfigured.
  capturePostHogException(error, context);

  // 2. Forward to the existing Lovable capture channel (no-op when unavailable / SSR).
  reportLovableError(error, context);

  // 3. Always surface locally in dev for greppable boundary + context.
  if (import.meta.env?.DEV) {
    console.error("[reportError]", context.boundary ?? "boundary", error, context);
  }
}
