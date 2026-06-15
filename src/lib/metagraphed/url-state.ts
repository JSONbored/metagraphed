import { z } from "zod";

/**
 * Fall back to `value` when a URL search param fails validation, so a stale or
 * hand-edited query string degrades to a sane default instead of erroring the
 * route. zod-4-native (`.catch`); replaces `@tanstack/zod-adapter`, which
 * peer-pins zod 3 and forced `.npmrc legacy-peer-deps` (metagraphed-ui#118).
 */
export function fallback<T extends z.ZodType>(schema: T, value: z.output<T>) {
  return schema.catch(value);
}

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
