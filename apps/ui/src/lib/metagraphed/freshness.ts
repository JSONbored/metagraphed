import { relativeFromDiff } from "./format";

/**
 * Centralized freshness formatter — used by the fact cells,
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
  return t.toLocaleString("en-US");
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

/**
 * A W3C-Datetime string if the value is a usable timestamp, otherwise nothing.
 *
 * #11314. This project probes every registered surface on a 15-minute cycle and
 * asserted that freshness in exactly ONE route family — `/docs`, via the
 * `dateModified` added in #11259. Subnet, provider and validator pages emitted
 * none. Against competitor content dated months ago, live data is the whole
 * advantage and we were telling crawlers nothing about it.
 *
 * The rule lives beside the other freshness formatting rather than in
 * `server.ts`, because the two consumers sit on opposite sides of the app:
 * `buildSitemap` runs in the Worker entry, and the JSON-LD builders are imported
 * by route `head()`. A page whose `dateModified` and whose sitemap `lastmod`
 * disagree makes two different claims about one fact, and a second copy is how
 * `metaDescription`, the breadcrumb list and the OG card each drifted.
 *
 * **Absent beats wrong, and that is not a style preference.** Google discounts
 * `lastmod` site-wide once it catches a site stamping "now" on URLs that did not
 * change, so one fabricated value costs every honest one.
 */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * The timestamp a registry record publishes as its last modification.
 *
 * **`published_at`, not `operational_observed_at`** — and the distinction is the
 * point. `operational_observed_at` is when we last *looked*: it advances every
 * 15 minutes whether or not anything about the record changed, so publishing it
 * as `dateModified` would be indistinguishable from stamping "now" on every
 * request. `published_at` is when the record was last rebuilt, which is what
 * the field actually claims.
 *
 * `generated_at` is the fallback because some artifacts carry only that; where
 * both are present they are the same instant.
 */
export function recordModifiedAt(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const bag = meta as Record<string, unknown>;
  return isoTimestamp(bag.published_at) ?? isoTimestamp(bag.generated_at);
}
