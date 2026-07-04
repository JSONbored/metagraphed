import { z } from "zod";
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
  provider: fallback(z.string(), "").default(""),
  // #9: agent-catalog capability filters (applied client-side over joined rows).
  serviceKind: fallback(z.string(), "").default(""),
  readiness: fallback(z.string(), "").default(""),
  // Layout state for list routes that support multiple views + row density.
  // Additive + optional with safe fallbacks so the toggles persist in the URL.
  view: fallback(z.enum(["table", "grid", "matrix"]), "table").default("table"),
  density: fallback(z.enum(["comfortable", "compact"]), "comfortable").default("comfortable"),
});

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

export function paginate<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
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
