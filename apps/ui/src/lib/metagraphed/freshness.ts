import { relativeFromDiff } from "./format";

/**
 * Centralized freshness formatter — used by StatWithSpark, NoDataSpark,
 * MethodologyCallout and OperationalPanel so every "last-updated" stamp
 * across the app reads the same way.
 */
export function formatFreshness(
  updatedAt?: string | null,
  windowLabel?: string | null,
): string | null {
  const parts: string[] = [];
  if (updatedAt) {
    const t = new Date(updatedAt);
    if (!Number.isNaN(t.getTime())) {
      const diffMs = Date.now() - t.getTime();
      parts.push(`updated ${relative(diffMs)}`);
    }
  }
  if (windowLabel) parts.push(`${windowLabel} window`);
  return parts.length ? parts.join(" · ") : null;
}

export function formatFreshnessAbsolute(updatedAt?: string | null): string | null {
  if (!updatedAt) return null;
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString();
}

/**
 * Freshness "time ago" stamp. Delegates to the shared {@link relativeFromDiff}
 * core (#6020) with the freshness-specific behaviour, decided here for its one
 * caller ({@link formatFreshness}): a `generated_at`/`updated_at` a little ahead
 * of the client clock is clock skew, not real future data, so a future diff is
 * CLAMPED to "0s ago" ("just now") rather than surfaced as "in Xs" the way the
 * general {@link formatRelative} does. Seconds floor at 0 and an hours label up
 * to 47h preserve this stamp's long-standing output.
 */
export function relative(diffMs: number): string {
  return relativeFromDiff(diffMs, {
    clampFuture: true,
    secondsFloor: 0,
    hourCapHours: 48,
  });
}
