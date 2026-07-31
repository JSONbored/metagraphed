import { z } from "zod";
import { stripSearchParams } from "@tanstack/react-router";
import { fallback } from "@tanstack/zod-adapter";

/** Common URL-driven table state schema for /subnets and /surfaces. */
export const tableSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  sort: fallback(z.string(), "").default(""),
  order: fallback(z.enum(["asc", "desc"]), "asc").default("asc"),
  // Server-driven cursor pagination. `limit` = page size sent to API;
  // `cursor` is an opaque token returned in meta.pagination.next_cursor.
  limit: fallback(z.number().int().min(5).max(200), 25).default(25),
  cursor: fallback(z.string(), "").default(""),
  // Legacy client-side pagination kept for back-compat with older callers.
  page: fallback(z.number().int().min(1), 1).default(1),
  pageSize: fallback(z.number().int().min(5).max(200), 25).default(25),
  curation: fallback(z.string(), "").default(""),
  health: fallback(z.string(), "").default(""),
  kind: fallback(z.string(), "").default(""),
  stale: fallback(z.string(), "").default(""),
  provider: fallback(z.string(), "").default(""),
  netuid: fallback(z.string(), "").default(""),
  // #9: agent-catalog capability filters (applied client-side over joined rows).
  serviceKind: fallback(z.string(), "").default(""),
  readiness: fallback(z.string(), "").default(""),
  // #6270: root-subnet inclusion toggle for /subnets, applied client-side over
  // the `subnet_type` the list response already returns. A boolean defaulting
  // to true (the endpoints route's `callable` toggle shape) rather than the ""
  // string filters above: it includes/excludes a slice of the set instead of
  // selecting one value, and defaulting to true keeps the unfiltered list
  // byte-identical to today's for anyone without the param.
  //
  // No companion `includeInactive`: GET /api/v1/subnets is documented as "List
  // active Finney subnets" and only ever returns status=active rows (verified
  // live — ?status=inactive returns 0). A client-side inactive filter could
  // only narrow rows the server already sent, so it would be inert by
  // construction; it belongs here only once that route serves non-active rows.
  includeRoot: fallback(z.boolean(), true).default(true),
  // #8248: client-only "Watched" quick-tab -- narrows the list to rows
  // starred in the localStorage watchlist (lib/metagraphed/watchlist.ts).
  // Optional/additive so pages that don't offer a watchlist never set it.
  watched: fallback(z.boolean(), false).default(false),
  // #8248: domains rollup chip filter (subnets belonging to a capability
  // domain from GET /api/v1/domains). Optional/additive, same as `watched`.
  domain: fallback(z.string(), "").default(""),
  // Layout state for list routes that support multiple views + row density.
  // Additive + optional with safe fallbacks so the toggles persist in the URL.
  view: fallback(z.enum(["table", "grid", "matrix"]), "table").default("table"),
  density: fallback(z.enum(["comfortable", "compact"]), "comfortable").default("comfortable"),
});

/**
 * Strip a route's default search params from the URL (#8628).
 *
 * Every field in these schemas carries a `.default()`, and TanStack Router
 * materialises defaults during `validateSearch` then rewrites the URL to match
 * — so `/subnets` always 307'd to a query string of 22 empty params. Nothing
 * was mis-indexed (the canonical tag points back at the clean path), but every
 * crawl paid a redirect hop and every shared link carried the noise.
 *
 * Defaults are DERIVED by parsing an empty object, never re-listed: a
 * hand-written list would silently stop stripping the moment a default
 * changed, which is exactly the drift this helper exists to prevent.
 *
 * NOTE for consumers: adding a search middleware collapses the route's search
 * type to `{}` at `useSearch()` — a TanStack typing limitation, not a runtime
 * change. `validateSearch` still applies every default when parsing, so the
 * value always has all fields; pages therefore cast to the route's exported
 * search type. That cast is sound precisely because the middleware only
 * affects what is WRITTEN to the URL, never what is read from it.
 */
export function stripDefaultSearchParams<T extends z.ZodObject>(schema: T) {
  return stripSearchParams<z.output<T>>(schema.parse({}) as Partial<z.output<T>>);
}

export type TableSearch = z.infer<typeof tableSearchSchema>;

/** Compare a needle against a few string fields case-insensitively. */
export function matchesQuery(haystacks: Array<unknown>, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  for (const h of haystacks) {
    if (h == null) continue;
    if (String(h).toLowerCase().includes(n)) return true;
  }
  return false;
}

export function sortBy<T>(
  rows: T[],
  key: string,
  order: "asc" | "desc",
  accessor: (row: T, key: string) => unknown,
): T[] {
  if (!key) return rows;
  const mul = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = accessor(a, key);
    const vb = accessor(b, key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
  });
}

/**
 * Join a list of rows with a per-key health map, overlaying `health` and
 * back-filling `updated_at` from the probe's `last_checked` when the row lacks
 * its own. Rows without a matching health entry pass through unchanged
 * (same reference). Pure + allocation-light so callers can safely memoize it.
 */
export function joinHealth<
  T extends { netuid: number; updated_at?: string | null },
  H extends { health?: string; last_checked?: string | null },
>(rows: T[], healthMap: Record<number, H | undefined>): Array<T | (T & { health?: string })> {
  return rows.map((s) => {
    const h = healthMap[s.netuid];
    return h ? { ...s, health: h.health, updated_at: s.updated_at ?? h.last_checked } : s;
  });
}

/**
 * #3364/#3363: join a list of rows with a per-netuid economics map, overlaying
 * registration, emission, price, stake, and market-cap fields so the /subnets
 * table's Registration and Emission columns (and their sort), plus the
 * homepage's alpha-price ticker, can read them straight off the row. Mirrors
 * `joinHealth`/the catalog join: a row with no economics entry passes through
 * unchanged (same reference), so its cells render "—". Pure + allocation-light
 * so callers can memoize it.
 */
export function joinEconomics<
  T extends { netuid: number },
  E extends {
    registration_cost_tao?: number;
    registration_allowed?: boolean;
    emission_share?: number;
    alpha_price_tao?: number;
    total_stake_tao?: number;
    alpha_market_cap_tao?: number;
  },
>(
  rows: T[],
  economicsMap: Record<number, E | undefined>,
): Array<
  | T
  | (T & {
      registration_cost_tao?: number;
      registration_allowed?: boolean;
      emission_share?: number;
      alpha_price_tao?: number;
      total_stake_tao?: number;
      alpha_market_cap_tao?: number;
    })
> {
  return rows.map((s) => {
    const e = economicsMap[s.netuid];
    return e
      ? {
          ...s,
          registration_cost_tao: e.registration_cost_tao,
          registration_allowed: e.registration_allowed,
          emission_share: e.emission_share,
          alpha_price_tao: e.alpha_price_tao,
          total_stake_tao: e.total_stake_tao,
          alpha_market_cap_tao: e.alpha_market_cap_tao,
        }
      : s;
  });
}
