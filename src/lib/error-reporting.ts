import { reportLovableError } from "./lovable-error-reporting";

/**
 * Centralized error-reporting seam for React error boundaries.
 *
 * Today this logs to the console and forwards to the existing Lovable capture
 * channel, but it is the single chokepoint a real telemetry backend (Sentry,
 * etc.) can be wired into later — boundaries call `reportError` and never touch
 * `console.error` or a vendor SDK directly.
 */
export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  // Structured console line so the boundary + context are always greppable.
  console.error("[reportError]", context.boundary ?? "boundary", error, context);
  // Forward to the existing capture channel (no-op when unavailable / SSR).
  reportLovableError(error, context);
}
