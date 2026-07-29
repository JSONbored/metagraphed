// #8526: client-side construction of the per-watchlist feed URL
// (GET /api/v1/feeds/watch?ids=), the UI half of the #8376 endpoint. The
// watchlist is local-first (no accounts), so the id set travels IN the URL: a
// comma-joined token per entity, single-letter kind prefix + the raw id --
// `s7` (subnet 7), `v5FHn…` (validator hotkey), `a5Grw…` (account ss58). This
// is a direct re-encoding of the local store's three kinds, matching the
// backend's parseWatchIds contract in src/feeds.ts (WATCH_ID_PREFIX) exactly.
import type { WatchlistKind } from "@/lib/metagraphed/watchlist";

/** Single-letter kind prefixes — mirrors src/feeds.ts's WATCH_ID_PREFIX. */
const KIND_PREFIX: Record<WatchlistKind, string> = {
  subnet: "s",
  validator: "v",
  account: "a",
};

/** Hard cap the endpoint enforces (src/feeds.ts WATCH_MAX_IDS). */
export const WATCH_FEED_MAX_IDS = 50;

export interface WatchFeedFormat {
  suffix: ".rss" | ".atom" | ".json";
  label: string;
}

/** The three formats the endpoint serves, matching the per-subnet affordance. */
export const WATCH_FEED_FORMATS: readonly WatchFeedFormat[] = [
  { suffix: ".rss", label: "RSS" },
  { suffix: ".atom", label: "Atom" },
  { suffix: ".json", label: "JSON Feed" },
];

/**
 * Encodes the watched ids (per kind) into the `?ids=` token string. Returns ""
 * when nothing is watched, so callers can treat empty as "no feed to offer"
 * rather than emitting a URL with a dangling `ids=`. Order is stable
 * (subnet, validator, account) so the same watchlist always yields the same URL.
 */
export function encodeWatchFeedIds(
  watched: Partial<Record<WatchlistKind, readonly string[]>>,
): string {
  const tokens: string[] = [];
  for (const kind of ["subnet", "validator", "account"] as const) {
    for (const id of watched[kind] ?? []) {
      if (id) tokens.push(`${KIND_PREFIX[kind]}${id}`);
    }
  }
  return tokens.join(",");
}

/**
 * Builds the feed URL for one format from a runtime API base and an encoded id
 * set. Returns null when the id set is empty — the caller renders the
 * explanatory empty state instead of a broken `ids=` link. The base is passed
 * in (from the useApiBase() hook) rather than read here, so this stays pure and
 * unit-testable and never bakes in a hardcoded origin.
 */
export function buildWatchFeedUrl(
  apiBase: string,
  encodedIds: string,
  suffix: WatchFeedFormat["suffix"],
): string | null {
  if (!encodedIds) return null;
  const base = apiBase.replace(/\/+$/, "");
  return `${base}/api/v1/feeds/watch${suffix}?ids=${encodeURIComponent(encodedIds)}`;
}
